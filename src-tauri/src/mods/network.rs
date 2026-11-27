use super::schema::{ensure, https_url, origin, Manifest, MAX_JSON};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub url: String,
    #[serde(default = "get")]
    pub method: String,
    pub body: Option<String>,
    pub content_type: Option<String>,
    pub connection: Option<String>,
}

fn get() -> String {
    "GET".into()
}

#[derive(Serialize)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn allowed(manifest: &Manifest, request: &Request) -> Result<Url, String> {
    ensure(
        request.url.len() <= 2000 && request.body.as_ref().is_none_or(|b| b.len() <= MAX_JSON),
        "Request is too large",
    )?;
    ensure(
        matches!(
            request.method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ),
        "Unsupported HTTP method",
    )?;
    ensure(
        request.content_type.as_ref().is_none_or(|t| {
            matches!(
                t.as_str(),
                "application/json" | "application/x-www-form-urlencoded" | "text/plain"
            )
        }),
        "Unsupported content type",
    )?;
    let url = https_url(&request.url)?;
    let origins = if let Some(id) = &request.connection {
        &manifest
            .permissions
            .connections
            .iter()
            .find(|c| &c.id == id)
            .ok_or("Connection is not declared by this mod")?
            .api_origins
    } else {
        &manifest.permissions.network
    };
    let host = url.origin().ascii_serialization();
    ensure(
        origins.iter().any(|o| origin(o).is_ok_and(|o| o == host)),
        "This mod does not have access to that network origin",
    )?;
    Ok(url)
}

pub use crate::http::public_ip;

pub async fn client(url: &Url) -> Result<Client, String> {
    let host = url.host_str().ok_or("Missing network host")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().ok_or("Missing network port")?;
    let addresses: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "Network lookup timed out")?
        .map_err(|_| "Network lookup failed")?
        .take(32)
        .collect(),
    };
    ensure(
        !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
        "Mods cannot access local, private or special-use network addresses",
    )?;
    crate::http::client_builder()
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| "Could not create mod network client".into())
}

pub async fn read(mut response: reqwest::Response) -> Result<Response, String> {
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read network response")?
    {
        ensure(
            body.len() + chunk.len() <= 1024 * 1024,
            "Network response exceeds 1 MiB",
        )?;
        body.extend_from_slice(&chunk);
    }
    Ok(Response {
        status,
        body: String::from_utf8(body).map_err(|_| "Expected a UTF-8 network response")?,
    })
}

pub async fn request(
    url: Url,
    request: Request,
    token: Option<String>,
) -> Result<Response, String> {
    let client = client(&url).await?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Invalid HTTP method")?;
    let mut outgoing = client.request(method, url);
    if let Some(body) = request.body {
        outgoing = outgoing.body(body);
    }
    if let Some(content_type) = request.content_type {
        outgoing = outgoing.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if let Some(token) = token {
        outgoing = outgoing.bearer_auth(token);
    }
    // Redirects are returned as responses. Credentials never follow them.
    read(
        outgoing
            .send()
            .await
            .map_err(|_| "Mod network request failed")?,
    )
    .await
}
