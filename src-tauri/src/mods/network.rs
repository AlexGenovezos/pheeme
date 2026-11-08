use super::schema::{ensure, https_url, origin, Manifest, MAX_JSON};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
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

/// Only public unicast addresses. Check resolved addresses, then pin the actual request
/// to them; a second DNS lookup must not be able to redirect access into the LAN.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_v4(ip);
            }
            // Global unicast only, excluding special-use 2001::/23 and documentation.
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && segments[1] < 0x0200)
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && !(segments[0] == 0x2002)
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !matches!(a, 0 | 10 | 127 | 224..=255)
        && !(a == 100 && (64..=127).contains(&b))
        && !(a == 169 && b == 254)
        && !(a == 172 && (16..=31).contains(&b))
        && !(a == 192 && (b == 0 || (b == 168) || (b == 88 && c == 99)))
        && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        && !(a == 203 && b == 0 && c == 113)
}

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
