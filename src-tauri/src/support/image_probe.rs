//! When the email on screen is included, its images that failed in the window are fetched once more
//! from here, as Send is pressed. The webview never says why an image failed; this tells a server or
//! network refusing them (the same failure from here) apart from a problem only the webview had (they
//! load fine from here). Only images that failed are fetched, and only to read the answer's status and
//! size: nothing fetched is kept. Addresses on this computer or the local network are left alone,
//! whether written in the URL, resolved from its name or reached by a redirect.

use futures::stream::{self, StreamExt};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{redirect, Url};
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// At most this many images are fetched, the first ones in the email.
pub const MAX_PROBES: usize = 50;
/// How many are fetched at once.
const CONCURRENT: usize = 6;
/// Each fetch gives up after this.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// All of them together give up after this, so Send never waits long on a slow network.
pub const BATCH_TIMEOUT: Duration = Duration::from_secs(15);
/// Redirects followed, each to an address on the internet.
const MAX_REDIRECTS: usize = 5;
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
    /// The server answered with an image (not, say, an HTML error page).
    pub fn loaded(&self) -> bool {
        self.error.is_none()
            && self.status.is_some_and(|s| (200..300).contains(&s))
            && self.bytes.is_some_and(|b| b > 0)
            && self
                .content_type
                .as_deref()
                .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("image/"))
    }
}

/// The client the probes use: no `Referer`, even on a redirect, like the email frame, and only
/// addresses on the internet ([`PublicOnly`], and every redirect hop).
pub fn client() -> reqwest::Client {
    crate::http::client_builder()
        .referer(false)
        // A proxy would resolve the name itself, past `PublicOnly`.
        .no_proxy()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if !is_public(attempt.url().as_str()) {
                attempt.error("redirected to a local address")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .expect("reqwest client builds")
}

/// Resolves a name to its internet addresses only; one with none is an error. (A URL with an
/// IP address isn't resolved: [`probe_targets`] and the redirect policy check those.)
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|a| public_ip(a.ip()))
                .collect();
            if found.is_empty() {
                return Err(format!("{} has no address on the internet", name.as_str()).into());
            }
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }
}

/// The distinct http(s) URLs of `urls` on the internet, in order, at most [`MAX_PROBES`].
pub fn probe_targets<'a>(urls: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for url in urls {
        let remote = url.starts_with("https://") || url.starts_with("http://");
        if remote && is_public(url) && !out.iter().any(|u| u == url) {
            out.push(url.to_owned());
            if out.len() == MAX_PROBES {
                break;
            }
        }
    }
    out
}

/// Whether the URL's host can be on the internet: not this computer, a private or link-local
/// address, or a `.local` name. Names are judged as written, not resolved.
fn is_public(url: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(ip) => public_ip(ip),
        Err(_) => {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            !(name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local"))
        }
    }
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast())
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // unique local
                || (first & 0xffc0) == 0xfe80) // link-local
        }
    }
}

/// Fetch the URLs, [`CONCURRENT`] at a time, each within [`PROBE_TIMEOUT`] and all within
/// [`BATCH_TIMEOUT`]; in order. One the batch's time ran out on says `timeout`.
pub async fn probe_all(client: &reqwest::Client, urls: Vec<String>) -> Vec<ImageProbe> {
    let deadline = tokio::time::Instant::now() + BATCH_TIMEOUT;
    stream::iter(urls)
        .map(|url| probe(client, url, deadline))
        .buffered(CONCURRENT)
        .collect()
        .await
}

async fn probe(
    client: &reqwest::Client,
    url: String,
    deadline: tokio::time::Instant,
) -> ImageProbe {
    let start = Instant::now();
    let now = tokio::time::Instant::now();
    let until = deadline.min(now + PROBE_TIMEOUT);
    // Queued behind slow ones until the batch's time ran out: not sent at all.
    let result = if until <= now {
        None
    } else {
        tokio::time::timeout_at(until, fetch(client, &url))
            .await
            .ok()
    };
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
        None => out.error = Some("timeout".into()),
        Some(Err((status, content_type, error))) => {
            out.status = status;
            out.content_type = content_type;
            out.error = Some(error);
        }
        Some(Ok((status, content_type, bytes))) => {
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
    // No Referer, like the email frame (`referrerPolicy="no-referrer"`): see [`client`].
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
        let many: Vec<String> = (0..80).map(|i| format!("https://c.example/{i}")).collect();
        urls = many.iter().map(String::as_str).collect();
        assert_eq!(probe_targets(urls).len(), MAX_PROBES);
    }

    #[test]
    fn targets_leave_this_computer_and_the_local_network_alone() {
        let urls = [
            "http://localhost/a.png",
            "http://printer.local/a.png",
            "http://127.0.0.1/a.png",
            "http://192.168.0.10/a.png",
            "http://10.1.2.3/a.png",
            "http://169.254.1.1/a.png",
            "http://[::1]/a.png",
            "http://[fd00::1]/a.png",
            "http://[::ffff:192.168.1.1]/a.png",
            "https://8.8.8.8/a.png",
            "https://cdn.example/a.png",
        ];
        assert_eq!(
            probe_targets(urls),
            ["https://8.8.8.8/a.png", "https://cdn.example/a.png"]
        );
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
                    } else if request.starts_with("GET /page ") {
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 6\r\nconnection: close\r\n\r\n<html>"
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
    async fn names_resolving_only_to_local_addresses_are_refused() {
        let local = PublicOnly.resolve("localhost".parse().unwrap()).await;
        assert!(local.is_err());
    }

    #[test]
    fn redirects_to_local_addresses_are_refused() {
        assert!(!is_public("http://192.168.1.1/a.png"));
        assert!(is_public("https://cdn.example/a.png"));
    }

    #[tokio::test]
    async fn reports_status_size_and_failures() {
        let base = server().await;
        // A port nothing listens on: bound, then closed.
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let client = client();
        let probes = probe_all(
            &client,
            vec![
                format!("{base}/ok"),
                format!("{base}/missing"),
                format!("http://{closed}/x.png"),
                format!("{base}/page"),
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

        // An error page answered with 200 isn't an image.
        assert_eq!(probes[3].status, Some(200));
        assert!(!probes[3].loaded());
    }
}
