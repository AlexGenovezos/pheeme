//! The MCP server AI assistants connect to: MCP's Streamable HTTP transport on loopback only,
//! answering `POST /mcp` with plain JSON (no SSE streams; `GET` is refused, as the spec
//! allows). Every request carries a client's bearer token. Requests whose `Host` or `Origin`
//! isn't this loopback address are refused, so a web page can't reach it through DNS
//! rebinding. All the work is [`LocalApi`]'s; this module only speaks the protocol.
//! Tauri-free.

pub mod protocol;

use crate::local_api::{ApiError, LocalApi};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{
    HeaderValue, ALLOW, AUTHORIZATION, CONTENT_TYPE, HOST, ORIGIN, WWW_AUTHENTICATE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinHandle;

/// **My call** (design doc): a fixed port, so the command users copy keeps working.
pub const DEFAULT_PORT: u16 = 43830;
/// Largest request body read.
const MAX_BODY: usize = 4 * 1024 * 1024;

/// What one local process can hold of the server: connections served at once (more wait to be
/// accepted), and how long a request's headers, then its body, may take to arrive. An idle
/// keep-alive connection is closed after `header_timeout` too.
#[derive(Debug, Clone, Copy)]
struct Limits {
    connections: usize,
    header_timeout: Duration,
    body_timeout: Duration,
}

const LIMITS: Limits = Limits {
    connections: 32,
    header_timeout: Duration::from_secs(10),
    body_timeout: Duration::from_secs(30),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerState {
    Off,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub state: ServerState,
    /// Where clients connect.
    pub url: String,
    /// Why it couldn't start.
    pub message: Option<String>,
}

struct Running {
    port: u16,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    failure: Option<String>,
}

pub struct McpServer {
    api: Arc<LocalApi>,
    port: u16,
    limits: Limits,
    inner: Mutex<Inner>,
}

impl McpServer {
    /// A server for `port` (0 picks a free one, for tests), not started.
    pub fn new(api: Arc<LocalApi>, port: u16) -> Self {
        Self {
            api,
            port,
            limits: LIMITS,
            inner: Mutex::default(),
        }
    }

    #[cfg(test)]
    fn with_limits(api: Arc<LocalApi>, limits: Limits) -> Self {
        Self {
            limits,
            ..Self::new(api, 0)
        }
    }

    pub fn api(&self) -> &Arc<LocalApi> {
        &self.api
    }

    fn url(port: u16) -> String {
        format!("http://127.0.0.1:{port}/mcp")
    }

    pub async fn status(&self) -> ServerStatus {
        let inner = self.inner.lock().await;
        match (&inner.running, &inner.failure) {
            (Some(r), _) => ServerStatus {
                state: ServerState::Running,
                url: Self::url(r.port),
                message: None,
            },
            (None, Some(why)) => ServerStatus {
                state: ServerState::Failed,
                url: Self::url(self.port),
                message: Some(why.clone()),
            },
            (None, None) => ServerStatus {
                state: ServerState::Off,
                url: Self::url(self.port),
                message: None,
            },
        }
    }

    /// Run the server if assistants are allowed, stop it if not.
    pub async fn apply_setting(&self) -> ServerStatus {
        match self.api.enabled().await {
            Ok(true) => self.start().await,
            Ok(false) => self.stop().await,
            Err(e) => {
                tracing::warn!(error = %e, "couldn't read the MCP setting");
                self.status().await
            }
        }
    }

    /// Start listening (a no-op while running).
    pub async fn start(&self) -> ServerStatus {
        {
            let mut inner = self.inner.lock().await;
            if inner.running.is_none() {
                match TcpListener::bind(("127.0.0.1", self.port)).await {
                    Ok(listener) => {
                        let port = listener.local_addr().map(|a| a.port()).unwrap_or(self.port);
                        let (shutdown, stopped) = watch::channel(false);
                        let task = tokio::spawn(serve(
                            listener,
                            port,
                            self.api.clone(),
                            self.limits,
                            stopped,
                        ));
                        tracing::info!(port, "MCP server listening");
                        inner.failure = None;
                        inner.running = Some(Running {
                            port,
                            shutdown,
                            task,
                        });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, port = self.port, "MCP server couldn't start");
                        inner.failure = Some(format!(
                            "Pheeme couldn't listen on port {}: another app may be using it ({e}).",
                            self.port
                        ));
                    }
                }
            }
        }
        self.status().await
    }

    /// Stop listening and drop open connections.
    pub async fn stop(&self) -> ServerStatus {
        let running = {
            let mut inner = self.inner.lock().await;
            inner.failure = None;
            inner.running.take()
        };
        if let Some(r) = running {
            let _ = r.shutdown.send(true);
            let _ = r.task.await;
            tracing::info!("MCP server stopped");
        }
        self.status().await
    }
}

async fn serve(
    listener: TcpListener,
    port: u16,
    api: Arc<LocalApi>,
    limits: Limits,
    mut stopped: watch::Receiver<bool>,
) {
    let mut connections = tokio::task::JoinSet::new();
    // A connection holds a slot until it closes; with every slot taken, new ones wait in the
    // listen backlog rather than each getting a task and buffers.
    let slots = Arc::new(Semaphore::new(limits.connections));
    loop {
        let slot = tokio::select! {
            _ = stopped.changed() => break,
            slot = slots.clone().acquire_owned() => slot.expect("the semaphore is never closed"),
        };
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _)) => stream,
                    Err(e) => {
                        tracing::warn!(error = %e, "MCP server couldn't accept a connection");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let api = api.clone();
                let mut stopped = stopped.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    let service = service_fn(move |req| {
                        let api = api.clone();
                        async move { Ok::<_, Infallible>(respond(&api, port, limits, req).await) }
                    });
                    let conn = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(limits.header_timeout)
                        .serve_connection(TokioIo::new(stream), service);
                    tokio::pin!(conn);
                    tokio::select! {
                        _ = conn.as_mut() => {}
                        _ = stopped.changed() => {
                            conn.as_mut().graceful_shutdown();
                            let _ = conn.await;
                        }
                    }
                });
            }
        }
        // Reap finished connections so the set doesn't grow.
        while connections.try_join_next().is_some() {}
    }
    connections.shutdown().await;
}

fn plain(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(text.to_owned())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn json(status: StatusCode, value: &serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// Whether a `Host` value (or an `Origin`'s host part) is this server on loopback.
fn is_loopback_host(host: &str, port: u16) -> bool {
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn bearer(req: &Request<Incoming>) -> Option<&str> {
    let value = req.headers().get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
}

async fn respond(
    api: &LocalApi,
    port: u16,
    limits: Limits,
    req: Request<Incoming>,
) -> Response<Full<Bytes>> {
    if req.uri().path() != "/mcp" {
        return plain(StatusCode::NOT_FOUND, "Pheeme's MCP endpoint is /mcp.");
    }
    let host_ok = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| is_loopback_host(h, port));
    let origin_ok = match req.headers().get(ORIGIN) {
        None => true,
        Some(origin) => origin
            .to_str()
            .ok()
            .and_then(|o| o.strip_prefix("http://"))
            .is_some_and(|h| is_loopback_host(h, port)),
    };
    if !host_ok || !origin_ok {
        return plain(
            StatusCode::FORBIDDEN,
            "Pheeme only answers local MCP clients.",
        );
    }
    if req.method() != Method::POST {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "Use POST.");
        response
            .headers_mut()
            .insert(ALLOW, HeaderValue::from_static("POST"));
        return response;
    }
    let unauthorized = || {
        let mut response = plain(
            StatusCode::UNAUTHORIZED,
            &ApiError::Unauthorized.to_string(),
        );
        response
            .headers_mut()
            .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        response
    };
    let Some(token) = bearer(&req).map(str::to_owned) else {
        return unauthorized();
    };
    let check = |e: ApiError| match e {
        ApiError::Unauthorized => unauthorized(),
        e => {
            tracing::warn!(error = %e, "couldn't check an assistant's token");
            plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Pheeme couldn't check the token.",
            )
        }
    };
    // Checked before the body is read, so an unknown caller can't make Pheeme hold its upload.
    if let Err(e) = api.authenticate(&token).await {
        return check(e);
    }
    let read = Limited::new(req.into_body(), MAX_BODY).collect();
    let body = match tokio::time::timeout(limits.body_timeout, read).await {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "That request is too large."),
        Err(_) => {
            return plain(
                StatusCode::REQUEST_TIMEOUT,
                "The request took too long to arrive.",
            )
        }
    };
    // And again once the body is in, so a client removed while it was still sending is refused.
    let caller = match api.authenticate(&token).await {
        Ok(caller) => caller,
        Err(e) => return check(e),
    };
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return json(StatusCode::BAD_REQUEST, &protocol::parse_error());
    };
    match protocol::handle(api, &caller, message).await {
        Some(answer) => json(StatusCode::OK, &answer),
        None => {
            let mut response = Response::new(Full::new(Bytes::new()));
            *response.status_mut() = StatusCode::ACCEPTED;
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_api::tests::setup;
    use crate::sync::fake::FakeGmail;
    use serde_json::json;

    #[test]
    fn loopback_hosts_only() {
        assert!(is_loopback_host("127.0.0.1:43830", 43830));
        assert!(is_loopback_host("localhost:43830", 43830));
        assert!(!is_loopback_host("127.0.0.1:1", 43830));
        assert!(!is_loopback_host("evil.com:43830", 43830));
        assert!(!is_loopback_host("127.0.0.1", 43830));
    }

    #[tokio::test]
    async fn serves_mcp_over_http_on_loopback_with_a_token() {
        let h = setup(FakeGmail::new()).await;
        let new = h.api.connect_client("Test").await.unwrap();
        let api = Arc::new(h.api);
        let server = McpServer::new(api.clone(), 0);
        assert_eq!(server.status().await.state, ServerState::Off);
        let status = server.start().await;
        assert_eq!(status.state, ServerState::Running);
        let url = status.url.clone();
        assert_eq!(server.start().await.url, url, "start is idempotent");

        let client = crate::http::client_builder().no_proxy().build().unwrap();
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });

        let no_token = client.post(&url).json(&init).send().await.unwrap();
        assert_eq!(no_token.status(), 401);
        assert_eq!(no_token.headers()["www-authenticate"], "Bearer");
        let wrong = client
            .post(&url)
            .bearer_auth("pheeme_nope")
            .json(&init)
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), 401);

        let ok = client
            .post(&url)
            .bearer_auth(&new.token)
            .json(&init)
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers()["content-type"], "application/json");
        let body: serde_json::Value = ok.json().await.unwrap();
        assert_eq!(body["result"]["serverInfo"]["name"], "pheeme");

        let note = client
            .post(&url)
            .bearer_auth(&new.token)
            .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .send()
            .await
            .unwrap();
        assert_eq!(note.status(), 202);

        let junk = client
            .post(&url)
            .bearer_auth(&new.token)
            .body("{")
            .send()
            .await
            .unwrap();
        assert_eq!(junk.status(), 400);

        let foreign = client
            .post(&url)
            .bearer_auth(&new.token)
            .header("Origin", "https://evil.example")
            .json(&init)
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), 403);
        let rebound = client
            .post(&url)
            .bearer_auth(&new.token)
            .header("Host", "evil.example")
            .json(&init)
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), 403);

        let get = client.get(&url).send().await.unwrap();
        assert_eq!(get.status(), 405);
        let elsewhere = client
            .post(url.replace("/mcp", "/other"))
            .send()
            .await
            .unwrap();
        assert_eq!(elsewhere.status(), 404);

        assert_eq!(server.stop().await.state, ServerState::Off);
        assert!(client.post(&url).json(&init).send().await.is_err());
    }

    /// Opens a connection to `server` and writes `request` on it.
    async fn send_raw(server: &McpServer, request: &str) -> tokio::net::TcpStream {
        use tokio::io::AsyncWriteExt;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port(server).await))
            .await
            .unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        stream
    }

    /// What arrives on `stream` within `wait`: `None` if nothing did, `Some("")` if it closed.
    async fn read_raw(stream: &mut tokio::net::TcpStream, wait: Duration) -> Option<String> {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0; 4096];
        match tokio::time::timeout(wait, stream.read(&mut buf)).await {
            Err(_) => None,
            Ok(Ok(n)) => Some(String::from_utf8_lossy(&buf[..n]).into_owned()),
            Ok(Err(_)) => Some(String::new()),
        }
    }

    /// A POST that promises `length` body bytes and sends only `{`.
    fn partial_post(port: u16, token: &str, length: usize) -> String {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {length}\r\n\r\n{{"
        )
    }

    async fn port(server: &McpServer) -> u16 {
        server.inner.lock().await.running.as_ref().unwrap().port
    }

    #[tokio::test]
    async fn refuses_an_unknown_token_before_reading_the_body() {
        let h = setup(FakeGmail::new()).await;
        let server = McpServer::new(Arc::new(h.api), 0);
        server.start().await;
        let port = port(&server).await;
        // The body never finishes arriving, so only a check made before reading it can answer.
        let mut stream = send_raw(&server, &partial_post(port, "pheeme_nope", 1_000_000)).await;
        let answer = read_raw(&mut stream, Duration::from_secs(5)).await;
        assert!(
            answer
                .as_deref()
                .is_some_and(|a| a.starts_with("HTTP/1.1 401")),
            "{answer:?}"
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn a_body_that_stops_arriving_times_out() {
        let h = setup(FakeGmail::new()).await;
        let new = h.api.connect_client("Test").await.unwrap();
        let limits = Limits {
            body_timeout: Duration::from_millis(200),
            ..LIMITS
        };
        let server = McpServer::with_limits(Arc::new(h.api), limits);
        server.start().await;
        let port = port(&server).await;
        let mut stream = send_raw(&server, &partial_post(port, &new.token, 100)).await;
        let answer = read_raw(&mut stream, Duration::from_secs(5)).await;
        assert!(
            answer
                .as_deref()
                .is_some_and(|a| a.starts_with("HTTP/1.1 408")),
            "{answer:?}"
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn idle_connections_close_and_extra_ones_wait_their_turn() {
        let h = setup(FakeGmail::new()).await;
        let limits = Limits {
            connections: 2,
            header_timeout: Duration::from_millis(500),
            ..LIMITS
        };
        let server = McpServer::with_limits(Arc::new(h.api), limits);
        server.start().await;
        let port = port(&server).await;
        let mut idle = [send_raw(&server, "").await, send_raw(&server, "").await];
        let request = format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        let mut third = send_raw(&server, &request).await;
        assert_eq!(
            read_raw(&mut third, Duration::from_millis(200)).await,
            None,
            "both slots are taken, so the third connection isn't served yet"
        );
        for stream in &mut idle {
            assert_eq!(
                read_raw(stream, Duration::from_secs(5)).await.as_deref(),
                Some(""),
                "an idle connection is closed after the header timeout"
            );
        }
        let answer = read_raw(&mut third, Duration::from_secs(5)).await;
        assert!(
            answer
                .as_deref()
                .is_some_and(|a| a.starts_with("HTTP/1.1 405")),
            "{answer:?}"
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn follows_the_setting_and_reports_a_busy_port() {
        let h = setup(FakeGmail::new()).await;
        let api = Arc::new(h.api);
        let server = McpServer::new(api.clone(), 0);
        assert_eq!(server.apply_setting().await.state, ServerState::Running);
        api.set_enabled(false).await.unwrap();
        assert_eq!(server.apply_setting().await.state, ServerState::Off);

        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let busy = McpServer::new(api, port);
        let status = busy.start().await;
        assert_eq!(status.state, ServerState::Failed);
        assert!(status.message.unwrap().contains(&port.to_string()));
        assert_eq!(busy.stop().await.state, ServerState::Off);
    }
}
