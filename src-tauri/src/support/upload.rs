//! Uploading a bundle to the diagnostics Worker.

use super::SupportError;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;
use serde::Serialize;
use std::time::Duration;

/// What the Worker files the upload under (the multipart `meta` field).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeta {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub reply_to: Option<String>,
    pub note: String,
    pub highlights: Vec<String>,
}

const TIMEOUT: Duration = Duration::from_secs(60);

/// POST the bundle to `url` as `multipart/form-data` (`meta` JSON and the `bundle` zip).
pub async fn send(url: &str, meta: &UploadMeta, zip: Vec<u8>) -> Result<(), SupportError> {
    let network = |e: reqwest::Error| SupportError::Network(e.without_url().to_string());
    let http = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(network)?;
    let meta = serde_json::to_string(meta).map_err(|e| SupportError::Internal(e.to_string()))?;
    let form = Form::new()
        .part(
            "meta",
            Part::text(meta)
                .mime_str("application/json")
                .map_err(network)?,
        )
        .part(
            "bundle",
            Part::bytes(zip)
                .file_name("pheeme-diagnostics.zip")
                .mime_str("application/zip")
                .map_err(network)?,
        );
    let response = http
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(network)?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    tracing::warn!(status = status.as_u16(), "diagnostics upload refused");
    Err(match status {
        StatusCode::TOO_MANY_REQUESTS => SupportError::RateLimited,
        StatusCode::PAYLOAD_TOO_LARGE => SupportError::TooLarge,
        s if s.is_client_error() => SupportError::Rejected(s.as_u16()),
        s => SupportError::Network(format!("diagnostics service answered {s}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header_regex, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn meta() -> UploadMeta {
        UploadMeta {
            version: "0.12.0".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            reply_to: Some("me@gmail.com".into()),
            note: "slow".into(),
            highlights: vec!["38.2 s from Gmail".into()],
        }
    }

    async fn answer(status: u16) -> (Result<(), SupportError>, MockServer) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/upload"))
            .and(header_regex(
                "content-type",
                "^multipart/form-data; boundary=",
            ))
            .respond_with(ResponseTemplate::new(status).insert_header("Retry-After", "60"))
            .mount(&server)
            .await;
        let url = format!("{}/v1/upload", server.uri());
        let result = send(&url, &meta(), b"PK\x03\x04zip".to_vec()).await;
        (result, server)
    }

    #[tokio::test]
    async fn upload_maps_statuses() {
        let (ok, server) = answer(204).await;
        ok.unwrap();
        let request = &server.received_requests().await.unwrap()[0];
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("name=\"meta\""), "{body}");
        assert!(body.contains("\"replyTo\":\"me@gmail.com\""), "{body}");
        assert!(body.contains("name=\"bundle\""), "{body}");
        assert!(body.contains("Content-Type: application/zip"), "{body}");
        assert!(body.contains("PK\u{3}\u{4}zip"), "{body}");

        let code = |r: Result<(), SupportError>| r.unwrap_err().code().to_owned();
        let (limited, _) = answer(429).await;
        let limited = limited.unwrap_err();
        assert_eq!(limited.code(), "rate_limited");
        assert!(limited.to_string().contains("try again later"), "{limited}");
        assert_eq!(code(answer(413).await.0), "too_large");
        assert_eq!(code(answer(400).await.0), "rejected");
        assert_eq!(code(answer(503).await.0), "network");
    }

    #[tokio::test]
    async fn unreachable_service_is_a_network_error_without_the_url() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{port}/v1/upload?secret=1");
        let error = send(&url, &meta(), Vec::new()).await.unwrap_err();
        assert_eq!(error.code(), "network");
        assert!(!error.to_string().contains("secret"), "{error}");
    }
}
