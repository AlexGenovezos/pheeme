//! HTTP plumbing for the Gmail REST API: bearer injection, retry with jittered exponential
//! backoff, one token refresh on 401, a per-client concurrency cap, and pacing under Gmail's
//! per-user quota.
//!
//! The per-area API methods (`messages.rs`, `threads.rs`, ...) are `impl GmailClient` blocks that
//! build an [`ApiRequest`] and hand it to [`GmailClient::send_json`] or
//! [`GmailClient::send_empty`]. Nothing here depends on Tauri.

use super::error::GmailError;
use rand::Rng;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tracing::warn;

/// Production API root. `me` resolves to the account the access token belongs to.
pub const DEFAULT_BASE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// Requests in flight per client (one client per account).
pub const MAX_CONCURRENT_REQUESTS: usize = 10;

/// Quota units per second each client may spend. Gmail's per-user limit is 6,000 units per
/// minute for current projects (it was 15,000), enforced per minute; beyond it Gmail answers
/// 403 `rateLimitExceeded`. 80/s (4,800 a minute) leaves headroom for the user's other
/// clients, and the limiter backs off further if Gmail still objects.
pub const QUOTA_UNITS_PER_SEC: u32 = 80;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Uploads carry whole messages (attachments up to Gmail's 25 MB), so they get longer.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Source of OAuth access tokens. The OAuth layer implements this on top of the keychain.
#[async_trait::async_trait]
pub trait TokenProvider: Send + Sync {
    /// A currently valid access token (implementations may cache).
    async fn access_token(&self) -> Result<String, GmailError>;
    /// Force a refresh after a 401 and return the new token.
    async fn refresh_access_token(&self) -> Result<String, GmailError>;
}

/// Exponential backoff for 429, 5xx and network failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Retries after the first attempt, so a request is sent at most `max_retries + 1` times.
    pub max_retries: u32,
    pub base_delay: Duration,
    pub multiplier: u32,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            base_delay: Duration::from_secs(1),
            multiplier: 2,
            max_delay: Duration::from_secs(32),
        }
    }
}

impl RetryPolicy {
    /// Delay before retry number `attempt` (0-based): `base * multiplier^attempt`, capped.
    pub fn backoff(&self, attempt: u32) -> Duration {
        self.base_delay
            .saturating_mul(self.multiplier.saturating_pow(attempt))
            .min(self.max_delay)
    }
}

/// A random delay in `[delay / 2, delay]`, so requests throttled together don't all retry in
/// the same instant and get throttled together again.
fn jittered(delay: Duration) -> Duration {
    delay.mul_f64(rand::thread_rng().gen_range(0.5..=1.0))
}

/// Paces requests by Gmail quota units, adapting to the limit Gmail actually enforces.
///
/// Each request reserves a send time on a schedule advancing `units / rate` seconds per call,
/// allowing up to [`QUOTA_BURST`] of backlog to go at once (a GCRA). A rate-limit answer halves
/// the rate and pauses the schedule; the rate then climbs back linearly, regaining the full
/// rate's worth per [`QUOTA_RECOVERY`] (so 30 s from half speed). Gmail enforces its limit per
/// minute, so a fixed rate either wastes quota or keeps tripping it, and recovering much faster
/// trips it again.
struct QuotaLimiter {
    max_rate: f64,
    state: std::sync::Mutex<Pace>,
}

struct Pace {
    /// When the schedule is next free.
    next: Instant,
    /// The rate set by the last cut, and when it was made.
    cut: Option<(f64, Instant)>,
}

const QUOTA_BURST: Duration = Duration::from_secs(1);
const QUOTA_RECOVERY: Duration = Duration::from_secs(60);

impl QuotaLimiter {
    fn new(units_per_sec: u32) -> Self {
        Self {
            max_rate: f64::from(units_per_sec.max(1)),
            state: std::sync::Mutex::new(Pace {
                next: Instant::now(),
                cut: None,
            }),
        }
    }

    fn pace(&self) -> std::sync::MutexGuard<'_, Pace> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Units per second allowed at `now`.
    fn rate_at(&self, pace: &Pace, now: Instant) -> f64 {
        match pace.cut {
            None => self.max_rate,
            Some((rate, at)) => {
                let regained = self.max_rate * now.duration_since(at).as_secs_f64()
                    / QUOTA_RECOVERY.as_secs_f64();
                (rate + regained).min(self.max_rate)
            }
        }
    }

    /// Wait for this request's turn to spend `units`.
    async fn take(&self, units: u32) {
        let send_at = {
            let mut pace = self.pace();
            let now = Instant::now();
            let rate = self.rate_at(&pace, now);
            let start = pace.next.max(now);
            pace.next = start + Duration::from_secs_f64(f64::from(units) / rate);
            start.checked_sub(QUOTA_BURST).unwrap_or(now)
        };
        tokio::time::sleep_until(send_at.into()).await;
    }

    /// Gmail said slow down: halve the rate (once per burst of rejections) and let the
    /// window drain before anything else goes.
    fn rate_limited(&self) {
        let mut pace = self.pace();
        let now = Instant::now();
        if pace
            .cut
            .is_some_and(|(_, at)| now.duration_since(at) < QUOTA_BURST)
        {
            return;
        }
        let rate = (self.rate_at(&pace, now) / 2.0).max(self.max_rate / 20.0);
        pace.cut = Some((rate, now));
        pace.next = pace.next.max(now) + QUOTA_BURST;
    }

    #[cfg(test)]
    fn rate(&self) -> f64 {
        self.rate_at(&self.pace(), Instant::now())
    }
}

/// One Gmail API call, rebuilt for every attempt.
#[derive(Debug, Clone)]
pub(crate) struct ApiRequest {
    method: Method,
    segments: Vec<String>,
    query: Vec<(String, String)>,
    body: Option<Value>,
    /// `multipart/related` upload of an RFC 2822 message (`/upload/...`, `uploadType=multipart`).
    upload: Option<Upload>,
    /// Whether failures that leave the outcome unknown (timeouts, dropped connections, 5xx) may
    /// be retried. False for non-idempotent calls such as sends: Gmail may already have acted.
    retry_ambiguous: bool,
}

impl ApiRequest {
    pub fn new(method: Method, segments: &[&str]) -> Self {
        Self {
            method,
            segments: segments.iter().map(|s| (*s).to_owned()).collect(),
            query: Vec::new(),
            body: None,
            upload: None,
            retry_ambiguous: true,
        }
    }

    pub fn get(segments: &[&str]) -> Self {
        Self::new(Method::GET, segments)
    }

    pub fn post(segments: &[&str]) -> Self {
        Self::new(Method::POST, segments)
    }

    /// Add a query parameter (repeat the key for list-valued parameters such as `labelIds`).
    pub fn query(mut self, key: &str, value: impl Into<String>) -> Self {
        self.query.push((key.to_owned(), value.into()));
        self
    }

    pub fn query_opt(self, key: &str, value: Option<&str>) -> Self {
        match value {
            Some(v) => self.query(key, v),
            None => self,
        }
    }

    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    /// Quota units Gmail charges for this call
    /// (<https://developers.google.com/workspace/gmail/api/reference/quota>).
    fn quota_units(&self) -> u32 {
        let segments: Vec<&str> = self.segments.iter().map(String::as_str).collect();
        match (self.method.as_str(), segments.as_slice()) {
            (_, ["profile"]) | ("GET", ["labels", ..]) => 1,
            ("GET", ["history"]) => 2,
            (_, [_, "send"]) => 100,
            ("POST", ["messages", "batchModify"]) => 50,
            ("PUT", ["drafts", _]) => 15,
            ("GET", ["threads", ..]) | (_, ["threads", _, _]) => 10,
            ("DELETE", ["messages", _]) | ("POST", ["drafts"]) => 10,
            _ => 5,
        }
    }

    /// Send `metadata` and a raw RFC 2822 message through Gmail's media upload endpoint, which
    /// takes messages far larger than a JSON `raw` field can.
    pub fn upload_message(mut self, metadata: Value, rfc822: &[u8]) -> Self {
        self.upload = Some(Upload::new(metadata, rfc822));
        self.query("uploadType", "multipart")
    }

    /// Mark the call non-idempotent: never retry when the outcome is unknown (timeout, dropped
    /// connection, 5xx). Retries still happen when Gmail clearly did not act (connect failure,
    /// 429, 401 refresh). The design forbids automatic re-sends (design doc §5).
    pub fn non_idempotent(mut self) -> Self {
        self.retry_ambiguous = false;
        self
    }
}

/// A prepared `multipart/related` body: JSON metadata, then the message.
#[derive(Debug, Clone)]
struct Upload {
    content_type: String,
    body: bytes::Bytes,
}

impl Upload {
    fn new(metadata: Value, rfc822: &[u8]) -> Self {
        let boundary = format!("pheeme-{}", uuid::Uuid::new_v4().simple());
        let mut body = Vec::with_capacity(rfc822.len() + 256);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
                 --{boundary}\r\nContent-Type: message/rfc822\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(rfc822);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        Self {
            content_type: format!("multipart/related; boundary={boundary}"),
            body: body.into(),
        }
    }
}

#[derive(Clone)]
pub struct GmailClient {
    http: reqwest::Client,
    tokens: Arc<dyn TokenProvider>,
    base_url: String,
    retry: RetryPolicy,
    permits: Arc<Semaphore>,
    quota: Arc<QuotaLimiter>,
}

impl GmailClient {
    pub fn new(tokens: Arc<dyn TokenProvider>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client with static configuration builds");
        Self {
            http,
            tokens,
            base_url: DEFAULT_BASE_URL.to_owned(),
            retry: RetryPolicy::default(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
            quota: Arc::new(QuotaLimiter::new(QUOTA_UNITS_PER_SEC)),
        }
    }

    /// Point the client at another API root (tests use a mock server).
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    pub fn with_retry_policy(mut self, p: RetryPolicy) -> Self {
        self.retry = p;
        self
    }

    /// Change the quota pacing (tests use a low rate to observe it).
    pub fn with_quota(mut self, units_per_sec: u32) -> Self {
        self.quota = Arc::new(QuotaLimiter::new(units_per_sec));
        self
    }

    /// Send a request and decode a JSON response body into `T`.
    pub(crate) async fn send_json<T: DeserializeOwned>(
        &self,
        req: ApiRequest,
    ) -> Result<T, GmailError> {
        let bytes = self.execute(&req).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| GmailError::Decode(format!("unexpected Gmail response: {e}")))
    }

    /// Send a request whose success response carries no body we need (e.g. DELETE).
    pub(crate) async fn send_empty(&self, req: ApiRequest) -> Result<(), GmailError> {
        self.execute(&req).await.map(|_| ())
    }

    fn url_for(&self, req: &ApiRequest) -> Result<reqwest::Url, GmailError> {
        let mut url = reqwest::Url::parse(&self.base_url)
            .map_err(|e| GmailError::Decode(format!("invalid Gmail base URL: {e}")))?;
        if req.upload.is_some() {
            // `https://gmail.googleapis.com/gmail/v1/...` → `.../upload/gmail/v1/...`.
            let path = format!("/upload{}", url.path().trim_end_matches('/'));
            url.set_path(&path);
        }
        url.path_segments_mut()
            .map_err(|_| GmailError::Decode("Gmail base URL cannot be a base".into()))?
            .pop_if_empty()
            .extend(&req.segments);
        Ok(url)
    }

    /// Run one request through auth, the concurrency gate and the retry loop; returns the body of
    /// the first successful response.
    ///
    /// The permit is held for the whole call, backoff sleeps included, so a rate-limited client
    /// slows down instead of piling retries on top of new requests.
    async fn execute(&self, req: &ApiRequest) -> Result<Vec<u8>, GmailError> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| GmailError::Network("request limiter closed".into()))?;
        let url = self.url_for(req)?;
        let mut token = self.tokens.access_token().await?;
        let mut refreshed = false;
        let mut attempt = 0;
        let units = req.quota_units();

        loop {
            // Every attempt spends quota, retries included.
            self.quota.take(units).await;
            let mut builder = self
                .http
                .request(req.method.clone(), url.clone())
                .bearer_auth(&token);
            if !req.query.is_empty() {
                builder = builder.query(&req.query);
            }
            if let Some(body) = &req.body {
                builder = builder.json(body);
            }
            if let Some(upload) = &req.upload {
                builder = builder
                    .header(reqwest::header::CONTENT_TYPE, &upload.content_type)
                    .body(upload.body.clone())
                    .timeout(UPLOAD_TIMEOUT);
            }

            let (status, retry_after, body) = match send_and_read(builder).await {
                Ok(parts) => parts,
                Err(e) => {
                    // A connect failure means the request never left; anything later is ambiguous.
                    let safe_to_retry = req.retry_ambiguous || e.is_connect();
                    if safe_to_retry && attempt < self.retry.max_retries {
                        let delay = jittered(self.retry.backoff(attempt));
                        warn!(attempt, ?delay, error = %e, "Gmail request failed, retrying");
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                    if e.is_connect() {
                        return Err(GmailError::Offline(e.to_string()));
                    }
                    return Err(GmailError::Network(e.to_string()));
                }
            };

            if status.is_success() {
                return Ok(body);
            }

            let (reason, message) = parse_error_body(&body, status);

            if status == StatusCode::UNAUTHORIZED {
                if refreshed {
                    return Err(GmailError::Auth(format!(
                        "Gmail rejected the refreshed access token: {message}"
                    )));
                }
                token = self.tokens.refresh_access_token().await?;
                refreshed = true;
                continue;
            }

            let rate_limited = status == StatusCode::TOO_MANY_REQUESTS
                || (status == StatusCode::FORBIDDEN
                    && matches!(
                        reason.as_deref(),
                        Some("rateLimitExceeded" | "userRateLimitExceeded")
                    ));
            if rate_limited {
                self.quota.rate_limited();
            }
            let retryable = rate_limited || (status.is_server_error() && req.retry_ambiguous);
            // A server asking for longer than our cap gets the error back (with `retry_after`)
            // instead of an early retry; the caller decides when to try again.
            let wait_too_long = retry_after.is_some_and(|d| d > self.retry.max_delay);
            if retryable && !wait_too_long && attempt < self.retry.max_retries {
                let delay = retry_after.unwrap_or_else(|| jittered(self.retry.backoff(attempt)));
                warn!(
                    attempt,
                    status = status.as_u16(),
                    reason = reason.as_deref().unwrap_or(""),
                    message = %message,
                    ?delay,
                    "Gmail request throttled or failed, retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }
            if rate_limited {
                return Err(GmailError::RateLimit { retry_after });
            }
            return Err(GmailError::Api {
                status: status.as_u16(),
                reason,
                message,
            });
        }
    }
}

/// Send, then read the whole body, so a connection dropped mid-response counts as a network
/// error and is retried like any other.
async fn send_and_read(
    builder: reqwest::RequestBuilder,
) -> Result<(StatusCode, Option<Duration>, Vec<u8>), reqwest::Error> {
    let resp = builder.send().await?;
    let status = resp.status();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after);
    let body = resp.bytes().await?.to_vec();
    Ok((status, retry_after, body))
}

/// `Retry-After` is either delta-seconds or an HTTP date.
fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<f64>() {
        return Duration::try_from_secs_f64(secs).ok();
    }
    // `dateparse` is lenient (it accepts "soon" as the epoch), so insist on the "Sun, 06 Nov ..." shape.
    if !value.contains(',') {
        return None;
    }
    let at = mailparse::dateparse(value).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(Duration::from_secs((at - now).max(0) as u64))
}

/// Extract `(reason, message)` from Google's `{"error": {...}}` body; tolerate anything else.
fn parse_error_body(body: &[u8], status: StatusCode) -> (Option<String>, String) {
    let fallback = || {
        let text = String::from_utf8_lossy(body);
        let text = text.trim();
        if text.is_empty() {
            status
                .canonical_reason()
                .unwrap_or("request failed")
                .to_owned()
        } else {
            text.chars().take(300).collect()
        }
    };
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return (None, fallback());
    };
    let Some(error) = value.get("error") else {
        return (None, fallback());
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(fallback);
    let reason = error
        .pointer("/errors/0/reason")
        .and_then(Value::as_str)
        .or_else(|| error.get("status").and_then(Value::as_str))
        .map(str::to_owned);
    (reason, message)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Token provider that hands out `token-0`, then `token-1`, ... on each refresh.
    #[derive(Default)]
    pub struct CountingTokens {
        pub refreshes: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl TokenProvider for CountingTokens {
        async fn access_token(&self) -> Result<String, GmailError> {
            Ok(format!("token-{}", self.refreshes.load(Ordering::SeqCst)))
        }

        async fn refresh_access_token(&self) -> Result<String, GmailError> {
            let n = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(format!("token-{n}"))
        }
    }

    pub fn fast_retry() -> RetryPolicy {
        RetryPolicy {
            max_retries: 3,
            base_delay: Duration::from_millis(1),
            multiplier: 2,
            max_delay: Duration::from_millis(20),
        }
    }

    pub fn client_for(server: &wiremock::MockServer) -> (GmailClient, Arc<CountingTokens>) {
        let tokens = Arc::new(CountingTokens::default());
        let client = GmailClient::new(tokens.clone())
            .with_base_url(server.uri())
            .with_retry_policy(fast_retry());
        (client, tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::gmail::types::UserProfile;
    use std::sync::atomic::Ordering;
    use std::time::Instant;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn profile_json() -> Value {
        serde_json::from_str(include_str!("fixtures/profile.json")).unwrap()
    }

    fn error_json(code: u16, reason: &str, message: &str) -> Value {
        serde_json::json!({"error": {"code": code, "message": message,
            "errors": [{"message": message, "domain": "global", "reason": reason}]}})
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let p = RetryPolicy::default();
        let secs: Vec<_> = (0..7).map(|n| p.backoff(n).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 32, 32]);
        assert_eq!(p.backoff(u32::MAX), Duration::from_secs(32));
    }

    #[test]
    fn retry_after_parses_seconds_and_dates() {
        assert_eq!(parse_retry_after("3"), Some(Duration::from_secs(3)));
        assert_eq!(
            parse_retry_after(" 0.25 "),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(Duration::ZERO)
        );
        assert_eq!(parse_retry_after("soon"), None);
        assert_eq!(parse_retry_after("-1"), None);
    }

    #[test]
    fn error_body_extracts_reason_and_message() {
        let body = include_bytes!("fixtures/error_start_history_id.json");
        let (reason, message) = parse_error_body(body, StatusCode::NOT_FOUND);
        assert_eq!(reason.as_deref(), Some("failedPrecondition"));
        assert_eq!(message, "Invalid startHistoryId: 12");

        let (reason, message) =
            parse_error_body(b"<html>bad gateway</html>", StatusCode::BAD_GATEWAY);
        assert_eq!(reason, None);
        assert_eq!(message, "<html>bad gateway</html>");

        let (_, message) = parse_error_body(b"", StatusCode::BAD_GATEWAY);
        assert_eq!(message, "Bad Gateway");
    }

    #[tokio::test]
    async fn injects_bearer_token_and_decodes_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/profile"))
            .and(header("authorization", "Bearer token-0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let profile: UserProfile = client
            .send_json(ApiRequest::get(&["profile"]))
            .await
            .unwrap();
        assert_eq!(profile.email_address, "alex@example.com");
    }

    #[tokio::test]
    async fn base_url_path_prefix_and_query_are_preserved() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .and(query_param("labelIds", "INBOX"))
            .and(query_param("labelIds", "UNREAD"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;
        let tokens = Arc::new(CountingTokens::default());
        let client = GmailClient::new(tokens)
            .with_base_url(format!("{}/gmail/v1/users/me/", server.uri()))
            .with_retry_policy(fast_retry());

        let req = ApiRequest::get(&["messages"])
            .query("labelIds", "INBOX")
            .query("labelIds", "UNREAD");
        let _: Value = client.send_json(req).await.unwrap();
    }

    #[tokio::test]
    async fn retries_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429).set_body_json(error_json(
                429,
                "rateLimitExceeded",
                "slow down",
            )))
            .up_to_n_times(2)
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let profile: UserProfile = client
            .send_json(ApiRequest::get(&["profile"]))
            .await
            .unwrap();
        assert_eq!(profile.history_id, "1204850");
    }

    #[tokio::test]
    async fn server_errors_exhaust_retries() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503).set_body_json(error_json(
                503,
                "backendError",
                "try later",
            )))
            // max_retries = 3 in fast_retry(): the first attempt plus three retries.
            .expect(4)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client
            .send_json::<Value>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        match err {
            GmailError::Api {
                status,
                reason,
                message,
            } => {
                assert_eq!(status, 503);
                assert_eq!(reason.as_deref(), Some("backendError"));
                assert_eq!(message, "try later");
            }
            other => panic!("expected Api error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn persistent_429_ends_as_rate_limit() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .expect(4)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client
            .send_json::<Value>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        assert!(matches!(err, GmailError::RateLimit { .. }), "{err:?}");
        assert_eq!(err.code(), "rate_limit");
    }

    #[tokio::test]
    async fn client_errors_are_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404).set_body_json(error_json(
                404,
                "notFound",
                "Requested entity was not found.",
            )))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client
            .send_json::<Value>(ApiRequest::get(&["messages", "nope"]))
            .await
            .unwrap_err();
        assert!(err.is_not_found());
    }

    fn retry_after_client(server: &MockServer) -> GmailClient {
        GmailClient::new(Arc::new(CountingTokens::default()))
            .with_base_url(server.uri())
            .with_retry_policy(RetryPolicy {
                max_retries: 2,
                base_delay: Duration::from_millis(1),
                multiplier: 2,
                max_delay: Duration::from_millis(500),
            })
    }

    #[tokio::test]
    async fn retry_after_header_is_honoured() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0.3"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
            .mount(&server)
            .await;
        // Backoff alone would wait 1 ms; Retry-After asks for 300 ms, within the 500 ms cap.
        let started = Instant::now();
        let _: Value = retry_after_client(&server)
            .send_json(ApiRequest::get(&["profile"]))
            .await
            .unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(300),
            "waited only {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn retry_after_beyond_cap_returns_rate_limit_without_retrying() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "120"))
            .expect(1)
            .mount(&server)
            .await;
        let err = retry_after_client(&server)
            .send_json::<Value>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            GmailError::RateLimit { retry_after: Some(d) } if d == Duration::from_secs(120)
        ));
    }

    #[tokio::test]
    async fn refreshes_token_on_401_and_retries() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer token-0"))
            .respond_with(ResponseTemplate::new(401).set_body_json(error_json(
                401,
                "authError",
                "Invalid Credentials",
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer token-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
            .expect(1)
            .mount(&server)
            .await;
        let (client, tokens) = client_for(&server);

        let _: UserProfile = client
            .send_json(ApiRequest::get(&["profile"]))
            .await
            .unwrap();
        assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn second_401_is_an_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_json(error_json(
                401,
                "authError",
                "Invalid Credentials",
            )))
            // One original attempt and exactly one retry after the refresh.
            .expect(2)
            .mount(&server)
            .await;
        let (client, tokens) = client_for(&server);

        let err = client
            .send_json::<Value>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        assert!(matches!(err, GmailError::Auth(_)), "{err:?}");
        assert_eq!(err.code(), "auth");
        assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unreachable_server_ends_as_network_error() {
        // Bind then drop a listener to get a port nothing is listening on.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let tokens = Arc::new(CountingTokens::default());
        let client = GmailClient::new(tokens)
            .with_base_url(format!("http://127.0.0.1:{port}"))
            .with_retry_policy(fast_retry());

        let err = client
            .send_json::<Value>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        assert!(matches!(err, GmailError::Offline(_)), "{err:?}");
        assert_eq!(err.code(), "network");
    }

    #[tokio::test]
    async fn malformed_success_body_is_a_decode_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client
            .send_json::<UserProfile>(ApiRequest::get(&["profile"]))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "decode");
    }

    #[test]
    fn quota_units_follow_gmail_costs() {
        let units = |req: ApiRequest| req.quota_units();
        assert_eq!(units(ApiRequest::get(&["profile"])), 1);
        assert_eq!(units(ApiRequest::get(&["labels", "INBOX"])), 1);
        assert_eq!(units(ApiRequest::get(&["history"])), 2);
        assert_eq!(units(ApiRequest::get(&["messages", "m1"])), 5);
        assert_eq!(units(ApiRequest::get(&["messages"])), 5);
        assert_eq!(units(ApiRequest::get(&["threads", "t1"])), 10);
        assert_eq!(units(ApiRequest::post(&["threads", "t1", "modify"])), 10);
        assert_eq!(units(ApiRequest::post(&["messages", "batchModify"])), 50);
        assert_eq!(units(ApiRequest::post(&["messages", "send"])), 100);
        assert_eq!(units(ApiRequest::post(&["drafts", "send"])), 100);
    }

    #[test]
    fn jitter_stays_within_half_to_full_delay() {
        for _ in 0..200 {
            let d = jittered(Duration::from_millis(1000));
            assert!(d >= Duration::from_millis(500) && d <= Duration::from_millis(1000));
        }
    }

    #[test]
    fn rate_limits_halve_the_pace_and_time_restores_it() {
        let limiter = QuotaLimiter::new(200);
        limiter.rate_limited();
        assert!((limiter.rate() - 100.0).abs() < 1.0);
        limiter.rate_limited(); // same burst of rejections: no second cut
        assert!((limiter.rate() - 100.0).abs() < 1.0);

        // Half a recovery period after a cut to half rate, it's back to full.
        let mut pace = limiter.pace();
        pace.cut = Some((100.0, Instant::now() - QUOTA_RECOVERY / 2));
        drop(pace);
        assert_eq!(limiter.rate(), 200.0);
    }

    #[tokio::test]
    async fn requests_are_paced_under_the_quota() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        // 10 units a second with a 1 s burst: three 5-unit gets go at once, the fourth waits
        // ~0.5 s.
        let client = client_for(&server).0.with_quota(10);
        let started = Instant::now();
        for _ in 0..4 {
            let _: Value = client
                .send_json(ApiRequest::get(&["messages", "m1"]))
                .await
                .unwrap();
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(450),
            "waited only {elapsed:?}"
        );
    }
}
