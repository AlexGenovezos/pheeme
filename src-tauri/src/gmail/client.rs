//! HTTP plumbing for the Gmail REST API: bearer injection, retry with jittered exponential
//! backoff, one token refresh on 401, a per-client concurrency cap, and pacing under Gmail's
//! per-user quota.
//!
//! The per-area API methods (`messages.rs`, `threads.rs`, ...) are `impl GmailClient` blocks that
//! build an [`ApiRequest`] and hand it to [`GmailClient::send_json`] or
//! [`GmailClient::send_empty`]. Nothing here depends on Tauri.

use super::error::GmailError;
use super::probe::{self, ProbeStage, RetryReason};
use super::usage::{AccountUsage, UsageSource};
use rand::RngExt;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Semaphore};
use tokio::time::Instant;
use tracing::warn;

/// Production API root. `me` resolves to the account the access token belongs to.
pub const DEFAULT_BASE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// Requests in flight per client (one client per account).
pub const MAX_CONCURRENT_REQUESTS: usize = 10;

/// Leave room for on-demand attachment downloads even while sync requests are slow or retrying.
pub(crate) const MAX_BACKGROUND_REQUESTS: usize = MAX_CONCURRENT_REQUESTS - 2;

/// Slots bulk work (the mailbox backfill) may hold, so sync always has some of its own.
pub(crate) const MAX_BULK_REQUESTS: usize = MAX_BACKGROUND_REQUESTS - 4;

/// Gmail's per-user limit in quota units per minute: 6,000 for current projects (it was
/// 15,000), enforced per minute; beyond it Gmail answers 403 `rateLimitExceeded`. Google Cloud
/// Console shows it as the Gmail API's "Units per minute per user" quota, and a user who has it
/// raised enters the new value in Settings ([`QuotaSetting`]).
pub const DEFAULT_QUOTA_PER_MINUTE: u32 = 6_000;
/// The range Settings accepts: below 600 even sync crawls; above the project-wide quota
/// (1,200,000) no single user gets more.
pub const QUOTA_PER_MINUTE_RANGE: std::ops::RangeInclusive<u32> = 600..=1_200_000;

/// The share of the limit each client spends (4,800 units a minute at the default). It leaves
/// headroom for the user's other clients, and the limiter backs off further if Gmail still objects.
const CLIENT_SHARE: f64 = 0.8;
/// The share bulk work (the backfill) may spend (2,400 a minute at the default). Kept well under
/// the limit, the backfill doesn't trip it, so sync, sends and opening mail aren't refused for
/// quota the backfill used up.
const BULK_SHARE: f64 = 0.4;

/// How long background work stays off Gmail after any request is rate-limited. Gmail counts its
/// limit per minute, so a shorter pause trips it again and takes the quota the user needs.
pub const RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60);

/// The user's Gmail per-user limit (units per minute), shared by every account's client so a
/// change in Settings applies at once.
#[derive(Debug, Clone)]
pub struct QuotaSetting(Arc<AtomicU32>);

impl QuotaSetting {
    /// `per_minute` is clamped to [`QUOTA_PER_MINUTE_RANGE`].
    pub fn new(per_minute: u32) -> Self {
        let setting = Self(Arc::new(AtomicU32::new(0)));
        setting.set(per_minute);
        setting
    }

    pub fn get(&self) -> u32 {
        self.0.load(Ordering::Relaxed)
    }

    /// Store `per_minute` clamped to [`QUOTA_PER_MINUTE_RANGE`]; returns what was stored.
    pub fn set(&self, per_minute: u32) -> u32 {
        let clamped = per_minute.clamp(
            *QUOTA_PER_MINUTE_RANGE.start(),
            *QUOTA_PER_MINUTE_RANGE.end(),
        );
        self.0.store(clamped, Ordering::Relaxed);
        clamped
    }
}

impl Default for QuotaSetting {
    fn default() -> Self {
        Self::new(DEFAULT_QUOTA_PER_MINUTE)
    }
}

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
    delay.mul_f64(rand::rng().random_range(0.5..=1.0))
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
    /// Units per second at full speed: `share` of a per-minute limit that may change.
    limit: Arc<AtomicU32>,
    share: f64,
    state: std::sync::Mutex<Pace>,
}

struct Pace {
    /// When the schedule is next free.
    next: Instant,
    /// When the user's schedule is next free.
    first: Instant,
    /// The rate set by the last cut, and when it took effect (may be ahead: a cooldown).
    cut: Option<(f64, Instant)>,
}

const QUOTA_BURST: Duration = Duration::from_secs(1);
const QUOTA_RECOVERY: Duration = Duration::from_secs(60);

impl QuotaLimiter {
    fn new(limit: &QuotaSetting, share: f64) -> Self {
        Self {
            limit: limit.0.clone(),
            share,
            state: std::sync::Mutex::new(Pace {
                next: Instant::now(),
                first: Instant::now(),
                cut: None,
            }),
        }
    }

    /// A fixed rate, for tests.
    fn fixed(units_per_sec: u32) -> Self {
        let limit = Arc::new(AtomicU32::new(units_per_sec.saturating_mul(60)));
        Self::new(&QuotaSetting(limit), 1.0)
    }

    fn max_rate(&self) -> f64 {
        (f64::from(self.limit.load(Ordering::Relaxed)) / 60.0 * self.share).max(0.1)
    }

    fn pace(&self) -> std::sync::MutexGuard<'_, Pace> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Units per second allowed at `now`.
    fn rate_at(&self, pace: &Pace, now: Instant) -> f64 {
        let max_rate = self.max_rate();
        match pace.cut {
            None => max_rate,
            Some((rate, at)) => {
                let regained =
                    max_rate * now.duration_since(at).as_secs_f64() / QUOTA_RECOVERY.as_secs_f64();
                (rate + regained).min(max_rate)
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
        tokio::time::sleep_until(send_at).await;
    }

    /// [`Self::take`] for the user's requests: they wait only behind each other, at the full rate
    /// with 5 s of backlog going at once, and what they spend is booked on the shared schedule.
    async fn take_first(&self, units: u32) {
        let send_at = {
            let mut pace = self.pace();
            let now = Instant::now();
            let spend = |rate: f64| Duration::from_secs_f64(f64::from(units) / rate);
            pace.next = pace.next.max(now) + spend(self.rate_at(&pace, now));
            let start = pace.first.max(now);
            pace.first = start + spend(self.max_rate());
            start.checked_sub(Duration::from_secs(5)).unwrap_or(now)
        };
        tokio::time::sleep_until(send_at).await;
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
        let rate = (self.rate_at(&pace, now) / 2.0).max(self.max_rate() / 20.0);
        pace.cut = Some((rate, now));
        // `take` lets a request go `QUOTA_BURST` ahead of its slot, so push past that too:
        // otherwise the pause is used up before it starts.
        pace.next = pace.next.max(now) + 2 * QUOTA_BURST;
    }

    /// Book nothing for [`RATE_LIMIT_COOLDOWN`], then restart at a quarter of the full rate and
    /// climb back over [`QUOTA_RECOVERY`] (45 s).
    fn cool_down(&self) {
        let until = Instant::now() + RATE_LIMIT_COOLDOWN;
        let mut pace = self.pace();
        pace.cut = Some((self.max_rate() / 4.0, until));
        pace.next = pace.next.max(until + QUOTA_BURST);
    }

    /// The time left of a [`Self::cool_down`].
    fn cooling(&self) -> Option<Duration> {
        let (_, until) = self.pace().cut?;
        let left = until.saturating_duration_since(Instant::now());
        (!left.is_zero()).then_some(left)
    }

    #[cfg(test)]
    fn rate(&self) -> f64 {
        self.rate_at(&self.pace(), Instant::now())
    }
}

/// Counts a user request as waiting to go out (for a slot, the quota or a retry) until dropped;
/// meanwhile sync and background requests start nothing new.
struct UserWaiting<'a>(&'a watch::Sender<usize>);

impl Drop for UserWaiting<'_> {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

/// Who the requests made inside a [`user_action`] or [`background`] scope are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    User,
    Background,
}

tokio::task_local! {
    static SCOPE: Scope;
}

/// Run `f` as something the user did (a label edit, a queued change or send, a search, a
/// draft): its sync-priority Gmail requests run at [`Priority::Interactive`], ahead of sync and
/// the backfill. A task-local, so it reaches every request `f` makes (`buffer_unordered`
/// included) but not spawned tasks.
///
/// Scopes nest and the innermost wins: a `user_action` inside [`background`] is the user's,
/// and a `background` inside a `user_action` is background work.
pub async fn user_action<F: Future>(f: F) -> F::Output {
    SCOPE.scope(Scope::User, f).await
}

/// Run `f` as work nobody is waiting on (the mailbox backfill, preloading a thread, prefetching
/// attachments): every Gmail request it makes runs at [`Priority::Background`], whatever it
/// would run at otherwise. A task-local like [`user_action`], and the innermost of the two
/// wins: a `user_action` nested inside `background` runs at the user's priority.
pub async fn background<F: Future>(f: F) -> F::Output {
    SCOPE.scope(Scope::Background, f).await
}

/// Whether requests made here run as background work (inside [`background`], with no
/// [`user_action`] nested inside it).
pub(crate) fn in_background() -> bool {
    SCOPE.try_with(|s| *s) == Ok(Scope::Background)
}

/// The priority a request asking for `requested` runs at, given the innermost scope around it
/// and whether a reader's [`probe`] is in scope. Background work stays background even when
/// probed: nobody is waiting on it.
fn effective_priority(requested: Priority, scope: Option<Scope>, probed: bool) -> Priority {
    match (requested, scope) {
        (_, Some(Scope::Background)) => Priority::Background,
        (Priority::Sync, Some(Scope::User)) => Priority::Interactive,
        (Priority::Sync, None) if probed => Priority::Interactive,
        (p, _) => p,
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
    priority: Priority,
    /// Extra request headers (for example `If-Match`), sent next to the bearer.
    headers: Vec<(&'static str, String)>,
}

/// Who is waiting on a request; decides which slots and how much quota it may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Priority {
    /// The user is waiting on it (an attachment, an opened thread, anything in
    /// [`user_action`]): may use slots reserved from sync, skips the quota queue, and holds
    /// sync and background requests back until it has gone out.
    Interactive,
    /// Sync and other calls that keep the app current.
    Sync,
    /// Bulk work nobody is waiting on (anything in [`background`]: the backfill, preloads,
    /// attachment prefetch). Gets a few slots and a share of the quota, and gives up at Gmail's
    /// first rate limit instead of retrying: its caller pauses.
    Background,
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
            priority: Priority::Sync,
            headers: Vec::new(),
        }
    }

    pub fn get(segments: &[&str]) -> Self {
        Self::new(Method::GET, segments)
    }

    pub(crate) fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = priority;
        self
    }

    pub fn post(segments: &[&str]) -> Self {
        Self::new(Method::POST, segments)
    }

    pub fn patch(segments: &[&str]) -> Self {
        Self::new(Method::PATCH, segments)
    }

    pub fn delete(segments: &[&str]) -> Self {
        Self::new(Method::DELETE, segments)
    }

    /// Send an extra request header.
    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
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
        self.upload = Some(Upload::new(metadata, "message/rfc822", rfc822));
        self.query("uploadType", "multipart")
    }

    /// A Drive file upload uses the same multipart/related transport as Gmail messages.
    pub fn upload_file(mut self, metadata: Value, bytes: &[u8]) -> Self {
        self.upload = Some(Upload::new(metadata, "application/octet-stream", bytes));
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
    fn new(metadata: Value, media_type: &str, rfc822: &[u8]) -> Self {
        let boundary = format!("pheeme-{}", uuid::Uuid::new_v4().simple());
        let mut body = Vec::with_capacity(rfc822.len() + 256);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
                 --{boundary}\r\nContent-Type: {media_type}\r\n\r\n"
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
    background_permits: Arc<Semaphore>,
    bulk_permits: Arc<Semaphore>,
    quota: Arc<QuotaLimiter>,
    bulk_quota: Arc<QuotaLimiter>,
    users_waiting: Arc<watch::Sender<usize>>,
    /// Where the account's Gmail usage is counted (Settings › Accounts); `None` for clients of
    /// other Google APIs, whose quotas are their own.
    usage: Option<Arc<AccountUsage>>,
}

impl GmailClient {
    pub fn new(tokens: Arc<dyn TokenProvider>) -> Self {
        let http = crate::http::client_builder()
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
            background_permits: Arc::new(Semaphore::new(MAX_BACKGROUND_REQUESTS)),
            bulk_permits: Arc::new(Semaphore::new(MAX_BULK_REQUESTS)),
            quota: Arc::new(QuotaLimiter::new(&QuotaSetting::default(), CLIENT_SHARE)),
            bulk_quota: Arc::new(QuotaLimiter::new(&QuotaSetting::default(), BULK_SHARE)),
            users_waiting: Arc::new(watch::Sender::new(0)),
            usage: None,
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
        self.quota = Arc::new(QuotaLimiter::fixed(units_per_sec));
        self
    }

    /// Pace by the user's Gmail limit, following later changes to it.
    pub fn with_quota_setting(mut self, limit: &QuotaSetting) -> Self {
        self.quota = Arc::new(QuotaLimiter::new(limit, CLIENT_SHARE));
        self.bulk_quota = Arc::new(QuotaLimiter::new(limit, BULK_SHARE));
        self
    }

    /// Count what this client spends, and what Gmail refuses, in `usage`.
    pub fn with_usage(mut self, usage: Arc<AccountUsage>) -> Self {
        self.usage = Some(usage);
        self
    }

    /// Change the pacing of background requests (tests observe it at a low rate).
    pub fn with_background_quota(mut self, units_per_sec: u32) -> Self {
        self.bulk_quota = Arc::new(QuotaLimiter::fixed(units_per_sec));
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
    ///
    /// With a [`probe`] in scope (the reader opened a thread), a sync request is the reader's:
    /// it runs at [`Priority::Interactive`], and its waits, retries and failures are reported.
    /// Inside [`user_action`] it is the user's too; inside [`background`] every request is
    /// background work (see [`effective_priority`]).
    async fn execute(&self, req: &ApiRequest) -> Result<Vec<u8>, GmailError> {
        let closed = |_| GmailError::Network("request limiter closed".into());
        let probe = probe::current();
        let priority =
            effective_priority(req.priority, SCOPE.try_with(|s| *s).ok(), probe.is_some());
        let background = priority == Priority::Background;
        let user = priority == Priority::Interactive;
        let url = self.url_for(req)?;
        // Before anything is held: a slow token refresh (or keychain prompt) must not hold
        // back other requests or slots.
        let mut token = self.tokens.access_token().await?;
        let mut waiting = user.then(|| self.user_waiting());
        if let Some(p) = &probe {
            p.stage(ProbeStage::Queued);
        }
        let queued = Instant::now();
        if !user {
            // Before taking any slot, so requests held back don't keep slots from anyone.
            self.wait_turn(background).await?;
        }
        // Take the narrowest gate first: queued bulk calls must not hold sync's slots, and
        // queued sync calls must not reserve the last two global slots. All calls still share
        // the total cap and Gmail quota limiter.
        let _bulk = if background {
            Some(self.bulk_permits.acquire().await.map_err(closed)?)
        } else {
            None
        };
        let _background = if priority == Priority::Interactive {
            None
        } else {
            Some(self.background_permits.acquire().await.map_err(closed)?)
        };
        let _permit = self.permits.acquire().await.map_err(closed)?;
        if let Some(p) = &probe {
            p.slot_wait(queued.elapsed());
        }
        let mut refreshed = false;
        let mut attempt = 0;
        let units = req.quota_units();
        let source = UsageSource::current(priority);

        loop {
            // Every attempt spends quota, retries included.
            let paced = Instant::now();
            if user {
                self.quota.take_first(units).await;
            } else {
                if background {
                    self.bulk_quota.take(units).await;
                }
                self.quota.take(units).await;
                // A user request or a rate limit may have come up while this one was paced.
                self.wait_turn(background).await?;
            }
            drop(waiting.take());
            if let Some(p) = &probe {
                p.quota_wait(paced.elapsed());
                p.stage(ProbeStage::Fetching);
            }
            let mut builder = self
                .http
                .request(req.method.clone(), url.clone())
                .bearer_auth(&token);
            for (name, value) in &req.headers {
                builder = builder.header(*name, value);
            }
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

            // Google's front end answers a bodiless POST/PUT/PATCH with 411 unless it carries
            // an explicit `Content-Length: 0` (trash, untrash, ...).
            if req.body.is_none()
                && req.upload.is_none()
                && matches!(req.method, Method::POST | Method::PUT | Method::PATCH)
            {
                builder = builder
                    .header(reqwest::header::CONTENT_LENGTH, 0)
                    .body(Vec::<u8>::new());
            }

            let sent = Instant::now();
            let sent_ms = self.usage.as_ref().map(|u| u.now_ms());
            let response = send_and_read(builder).await;
            if let Some(p) = &probe {
                p.sent(sent.elapsed());
            }
            // Gmail charges every attempt that reached it; a connect failure never left.
            if let (Some(usage), Some(sent_ms)) = (&self.usage, sent_ms) {
                if !matches!(&response, Err(e) if e.is_connect()) {
                    usage.record_at(sent_ms, source, units);
                }
            }
            let (status, retry_after, body) = match response {
                Ok(parts) => parts,
                Err(e) => {
                    // The URL can carry a search (`q=from:bob@x.com`); keep it out of logs and errors.
                    let e = e.without_url();
                    if let Some(p) = &probe {
                        p.failed(None, Some("network"));
                    }
                    // A connect failure means the request never left; anything later is ambiguous.
                    let safe_to_retry = req.retry_ambiguous || e.is_connect();
                    if safe_to_retry && attempt < self.retry.max_retries {
                        let delay = jittered(self.retry.backoff(attempt));
                        warn!(attempt, ?delay, error = %e, "Gmail request failed, retrying");
                        if let Some(p) = &probe {
                            p.retrying(attempt, delay, RetryReason::Network);
                        }
                        waiting = user.then(|| self.user_waiting());
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
            if let Some(p) = &probe {
                p.failed(Some(status.as_u16()), reason.as_deref());
            }

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
                if let Some(usage) = &self.usage {
                    usage.refused();
                }
                self.quota.rate_limited();
                // Whichever request saw it, background work stays off Gmail for a while.
                self.bulk_quota.cool_down();
            }
            let retryable = rate_limited || (status.is_server_error() && req.retry_ambiguous);
            // A server asking for longer than our cap gets the error back (with `retry_after`)
            // instead of an early retry; the caller decides when to try again.
            let wait_too_long = retry_after.is_some_and(|d| d > self.retry.max_delay);
            // Bulk work doesn't wait out a rate limit holding its slot: the backfill pauses as
            // a whole, leaving the quota to sync and the reader.
            let retry_rate_limit = !(rate_limited && background);
            if retryable && retry_rate_limit && !wait_too_long && attempt < self.retry.max_retries {
                let delay = retry_after.unwrap_or_else(|| jittered(self.retry.backoff(attempt)));
                warn!(
                    attempt,
                    method = %req.method,
                    resource = req.segments.first().map(String::as_str).unwrap_or(""),
                    status = status.as_u16(),
                    reason = reason.as_deref().unwrap_or(""),
                    message = %message,
                    ?delay,
                    "Gmail request throttled or failed, retrying"
                );
                if let Some(p) = &probe {
                    let why = if rate_limited {
                        RetryReason::RateLimited
                    } else {
                        RetryReason::Server
                    };
                    p.retrying(attempt, delay, why);
                }
                waiting = user.then(|| self.user_waiting());
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }
            // A refused background call isn't news: its caller logs the pause once.
            if rate_limited && background {
                return Err(GmailError::RateLimit { retry_after });
            }
            if rate_limited {
                warn!(
                    attempts = attempt + 1,
                    method = %req.method,
                    resource = req.segments.first().map(String::as_str).unwrap_or(""),
                    status = status.as_u16(),
                    reason = reason.as_deref().unwrap_or(""),
                    message = %message,
                    ?retry_after,
                    "Gmail rate limit outlasted request retry budget"
                );
                return Err(GmailError::RateLimit { retry_after });
            }
            return Err(GmailError::Api {
                status: status.as_u16(),
                reason,
                message,
            });
        }
    }

    fn user_waiting(&self) -> UserWaiting<'_> {
        self.users_waiting.send_modify(|n| *n += 1);
        UserWaiting(&self.users_waiting)
    }

    /// Wait until no user request is waiting to go out. Background work during a cooldown is
    /// turned away instead, unsent: its caller pauses rather than holding anything meanwhile.
    async fn wait_turn(&self, background: bool) -> Result<(), GmailError> {
        let _ = self.users_waiting.subscribe().wait_for(|&n| n == 0).await;
        match self.bulk_quota.cooling() {
            Some(left) if background => Err(GmailError::RateLimit {
                retry_after: Some(left),
            }),
            _ => Ok(()),
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
        if text.is_empty() || text.contains('<') {
            // An HTML error page (a proxy or Google's front end) is not for the user to read.
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
mod tests;
