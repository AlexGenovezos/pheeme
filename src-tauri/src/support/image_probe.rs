//! When the email on screen is included, its images that failed in the window are fetched once more
//! from here, as Send is pressed. The webview never says why an image failed; this tells a server or
//! network refusing them (the same failure from here) apart from a problem only the webview had (they
//! load fine from here). Only images that failed are fetched, and only to read the answer's status and
//! size: nothing fetched is kept.

use futures::future::join_all;
use serde::Serialize;
use std::time::{Duration, Instant};

/// At most this many images are fetched, the first ones in the email.
pub const MAX_PROBES: usize = 12;
/// Each fetch gives up after this.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Bytes read of each answer before stopping; enough to tell an image from an error page.
const MAX_READ_BYTES: usize = 4 * 1024 * 1024;

/// What fetching one image from the app got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProbe {
    pub url: String,
    /// The HTTP status, or `None` when no answer came.
    pub status: Option<u16>,
    pub content_type: Option<String>,
    /// Bytes read (stopped at 4 MB).
    pub bytes: Option<usize>,
    /// Why no answer came (timeout, connect, ...), or why reading it failed.
    pub error: Option<String>,
    pub ms: u64,
}

impl ImageProbe {
    /// The server answered with something that could be an image.
    pub fn loaded(&self) -> bool {
        self.error.is_none()
            && self.status.is_some_and(|s| (200..300).contains(&s))
            && self.bytes.is_some_and(|b| b > 0)
    }
}

/// The distinct http(s) URLs of `urls`, in order, at most [`MAX_PROBES`].
pub fn probe_targets<'a>(urls: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for url in urls {
        let remote = url.starts_with("https://") || url.starts_with("http://");
        if remote && !out.iter().any(|u| u == url) {
            out.push(url.to_owned());
            if out.len() == MAX_PROBES {
                break;
            }
        }
    }
    out
}

/// Fetch every URL at once, each within [`PROBE_TIMEOUT`].
pub async fn probe_all(client: &reqwest::Client, urls: Vec<String>) -> Vec<ImageProbe> {
    join_all(urls.into_iter().map(|url| probe(client, url))).await
}

async fn probe(client: &reqwest::Client, url: String) -> ImageProbe {
    let start = Instant::now();
    let result = tokio::time::timeout(PROBE_TIMEOUT, fetch(client, &url)).await;
    let ms = start.elapsed().as_millis() as u64;
    let mut out = ImageProbe {
        url,
        status: None,
        content_type: None,
        bytes: None,
        error: None,
        ms,
    };
    match result {
        Err(_) => out.error = Some("timeout".into()),
        Ok(Err((status, content_type, error))) => {
            out.status = status;
            out.content_type = content_type;
            out.error = Some(error);
        }
        Ok(Ok((status, content_type, bytes))) => {
            out.status = Some(status);
            out.content_type = content_type;
            out.bytes = Some(bytes);
        }
    }
    out
}

type Answer = (u16, Option<String>, usize);
type Failure = (Option<u16>, Option<String>, String);

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Answer, Failure> {
    // No Referer, like the email frame (`referrerPolicy="no-referrer"`); reqwest sends none by default.
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| (None, None, describe(&e)))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut bytes = 0;
    while bytes < MAX_READ_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => bytes += chunk.len(),
            Ok(None) => break,
            Err(e) => return Err((Some(status), content_type, describe(&e))),
        }
    }
    Ok((status, content_type, bytes))
}

/// The kind of failure first, then reqwest's chain of causes (which names DNS, TLS, refused, ...).
fn describe(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_body() || e.is_decode() {
        "body"
    } else if e.is_request() {
        "request"
    } else {
        "other"
    };
    let mut text = format!("{kind}: {e}");
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn targets_are_distinct_remote_urls_capped() {
        let mut urls = vec![
            "https://a.example/1.png",
            "data:image/png;base64,AA",
            "https://a.example/1.png",
            "http://b.example/2.gif",
            "pheeme-att://localhost/x",
        ];
        assert_eq!(
            probe_targets(urls.iter().copied()),
            ["https://a.example/1.png", "http://b.example/2.gif"]
        );
        let many: Vec<String> = (0..40).map(|i| format!("https://c.example/{i}")).collect();
        urls = many.iter().map(String::as_str).collect();
        assert_eq!(probe_targets(urls).len(), MAX_PROBES);
    }

    /// A one-shot server: `/ok` answers a small PNG, anything else 404.
    async fn server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let reply: &[u8] = if request.starts_with("GET /ok ") {
                        b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4\r\nconnection: close\r\n\r\n\x89PNG"
                    } else {
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    };
                    let _ = socket.write_all(reply).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn reports_status_size_and_failures() {
        let base = server().await;
        // A port nothing listens on: bound, then closed.
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let client = crate::http::client();
        let probes = probe_all(
            &client,
            vec![
                format!("{base}/ok"),
                format!("{base}/missing"),
                format!("http://{closed}/x.png"),
            ],
        )
        .await;

        assert_eq!(probes[0].status, Some(200));
        assert_eq!(probes[0].content_type.as_deref(), Some("image/png"));
        assert_eq!(probes[0].bytes, Some(4));
        assert!(probes[0].loaded());

        assert_eq!(probes[1].status, Some(404));
        assert!(!probes[1].loaded());

        assert_eq!(probes[2].status, None);
        assert!(
            probes[2].error.as_deref().unwrap().starts_with("connect"),
            "{:?}",
            probes[2].error
        );
        assert!(!probes[2].loaded());
    }
}
