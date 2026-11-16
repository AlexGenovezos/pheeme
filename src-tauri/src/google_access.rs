//! What Calendar, Tasks and Google Contacts share: where an account's access to a Google API
//! stands ([`AccessStatus`], stored as text with a detail column and sent to the UI as
//! [`AccessDto`]), and the background loop that keeps each one's cache current ([`Poller`]),
//! with one [`Adapter`] per Google API saying how to read, sync and record it.

use crate::db;
use crate::gmail::GmailError;
use serde::{Serialize, Serializer};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::warn;

/// Where an account's access to one Google API stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessStatus {
    /// Never checked, or never allowed.
    Unknown,
    On,
    /// The account didn't grant the scope: the user has to allow access again.
    MissingScope,
    /// The API is off in the user's Google Cloud project (its number, when Google gave it).
    ApiDisabled {
        project: Option<String>,
    },
    /// The last check failed for another reason; what failed.
    Error(String),
}

impl AccessStatus {
    pub const UNKNOWN: &'static str = "unknown";
    pub const ON: &'static str = "on";
    pub const MISSING_SCOPE: &'static str = "missing_scope";
    pub const API_DISABLED: &'static str = "api_disabled";
    pub const ERROR: &'static str = "error";

    /// The status as stored (`status` and `detail` columns). Anything unrecognised reads as
    /// [`Self::Unknown`].
    pub fn from_stored(status: &str, detail: Option<&str>) -> Self {
        match status {
            Self::ON => Self::On,
            Self::MISSING_SCOPE => Self::MissingScope,
            Self::API_DISABLED => Self::ApiDisabled {
                project: detail.map(str::to_owned),
            },
            Self::ERROR => Self::Error(detail.unwrap_or_default().to_owned()),
            _ => Self::Unknown,
        }
    }

    /// The `status` column.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unknown => Self::UNKNOWN,
            Self::On => Self::ON,
            Self::MissingScope => Self::MISSING_SCOPE,
            Self::ApiDisabled { .. } => Self::API_DISABLED,
            Self::Error(_) => Self::ERROR,
        }
    }

    /// The `detail` column: the project number, or what failed.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::ApiDisabled { project } => project.as_deref(),
            Self::Error(message) => Some(message),
            Self::Unknown | Self::On | Self::MissingScope => None,
        }
    }

    /// The status a failed call leaves the account in, or `None` for a failure that may pass
    /// by itself, which leaves the status as it was: no network, a rate limit, Google having
    /// trouble, a locked keychain, or a sign-in Google stopped accepting (mail sync already
    /// says so in the sidebar and offers to sign in again, and signing in checks again).
    pub fn from_failure(e: &GmailError) -> Option<Self> {
        match e {
            GmailError::Network(_)
            | GmailError::Offline(_)
            | GmailError::RateLimit { .. }
            | GmailError::KeychainLocked(_)
            | GmailError::Auth(_)
            | GmailError::SignedOut(_) => None,
            GmailError::Api { status, .. } if *status >= 500 => None,
            e if e.is_missing_scope() => Some(Self::MissingScope),
            e if e.is_api_disabled() => Some(Self::ApiDisabled {
                project: e.disabled_api_project(),
            }),
            e => Some(Self::Error(e.to_string())),
        }
    }

    pub fn is_on(&self) -> bool {
        matches!(self, Self::On)
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown)
    }

    /// Waiting on the user (allow access, turn the API on): not polled until they act.
    pub fn is_held(&self) -> bool {
        matches!(self, Self::MissingScope | Self::ApiDisabled { .. })
    }

    /// Access was given and not taken away, so what's cached is the account's own.
    pub fn is_granted(&self) -> bool {
        !matches!(self, Self::Unknown | Self::MissingScope)
    }

    /// What the UI is sent. `api_page` is the API's page in the Google Cloud console, linked
    /// (with the project when known) for [`Self::ApiDisabled`].
    pub fn dto(self, api_page: &str, synced_at: Option<i64>) -> AccessDto {
        let message = match &self {
            Self::Error(message) if !message.is_empty() => Some(message.clone()),
            _ => None,
        };
        let enable_url = match &self {
            Self::ApiDisabled {
                project: Some(project),
            } => Some(format!("{api_page}?project={project}")),
            Self::ApiDisabled { project: None } => Some(api_page.to_owned()),
            _ => None,
        };
        AccessDto {
            status: self,
            message,
            enable_url,
            synced_at,
        }
    }
}

impl Serialize for AccessStatus {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl PartialEq<&str> for AccessStatus {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

/// An account's access to one Google API, as the UI receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessDto {
    /// `unknown`, `on`, `missing_scope`, `api_disabled` or `error`.
    pub status: AccessStatus,
    /// What failed, for `error`.
    pub message: Option<String>,
    /// The API's page for the user's project, for `api_disabled`.
    pub enable_url: Option<String>,
    /// The last sync that worked.
    pub synced_at: Option<i64>,
}

/// Why an adapter's sync stopped.
#[derive(Debug)]
pub enum SyncFailure {
    /// Google refused or couldn't be reached: becomes the account's status, or passes.
    Google(GmailError),
    /// The cache couldn't be read or written.
    Cache(anyhow::Error),
}

/// One Google API kept current by a [`Poller`].
#[async_trait::async_trait]
pub trait Adapter: Send + Sync {
    /// The API, for logs.
    const NAME: &'static str;

    fn pool(&self) -> &SqlitePool;

    /// The account's stored status; [`AccessStatus::Unknown`] when nothing is stored.
    async fn access(&self, account_id: &str) -> anyhow::Result<AccessStatus>;

    /// Whether the regular ticks sync the account, given its stored status.
    async fn due(&self, account_id: &str, status: &AccessStatus) -> anyhow::Result<bool>;

    /// Bring the account's cache up to date, announcing whatever changed. `asked` when the
    /// user (or the app on their behalf) asked for it now rather than a regular tick.
    async fn sync(&self, account_id: &str, now: i64, asked: bool) -> Result<(), SyncFailure>;

    /// Store how the sync went.
    async fn record(&self, account_id: &str, status: &AccessStatus, now: i64)
        -> anyhow::Result<()>;

    /// The account's status changed to `status`.
    fn access_changed(&self, account_id: &str, status: &AccessStatus);

    /// Whether a failure that may pass by itself is recorded anyway, given the status before
    /// (so a first check that fails says why rather than nothing).
    fn records_passing_failure(&self, _before: &AccessStatus) -> bool {
        false
    }
}

/// How often a [`Poller`] checks.
#[derive(Debug, Clone, Copy)]
pub struct Intervals {
    /// The first check waits for launch and mail's first sync to settle.
    pub first: Duration,
    pub background: Duration,
    /// While the app shows this API's data in front (Calendar mode).
    pub foreground: Duration,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The background loop and per-account bookkeeping one [`Adapter`] is synced with.
pub struct Poller {
    intervals: Intervals,
    foreground: AtomicBool,
    wake: Notify,
    /// Accounts to sync on the next tick whatever their status (just signed in, or asked).
    forced: Mutex<HashSet<String>>,
    /// One sync (or write) per account at a time, so a sync never caches a version older than
    /// a write that landed while it ran.
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Poller {
    pub fn new(intervals: Intervals) -> Self {
        Self {
            intervals,
            foreground: AtomicBool::new(false),
            wake: Notify::new(),
            forced: Mutex::new(HashSet::new()),
            gates: Mutex::new(HashMap::new()),
        }
    }

    /// The account's sync-and-write gate.
    pub fn gate(&self, account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.gates)
            .entry(account_id.to_owned())
            .or_default()
            .clone()
    }

    /// The data is (or stopped being) in front: check at the foreground interval.
    pub fn set_foreground(&self, on: bool) {
        let was = self.foreground.swap(on, Ordering::Relaxed);
        if on && !was {
            self.wake.notify_one();
        }
    }

    /// Check `account_id` (or every account) soon; an account named here is checked whatever
    /// its status, so signing in finds out at once whether it now has access.
    pub fn trigger(&self, account_id: Option<String>) {
        if let Some(id) = account_id {
            lock(&self.forced).insert(id);
        }
        self.wake.notify_one();
    }

    /// Whether a sync of `account_id` was asked for and hasn't run yet.
    #[cfg(test)]
    pub fn is_forced(&self, account_id: &str) -> bool {
        lock(&self.forced).contains(account_id)
    }

    /// Sync the account now, whatever its status, and record how it went.
    pub async fn sync_now<A: Adapter>(
        &self,
        adapter: &A,
        account_id: &str,
        now: i64,
    ) -> anyhow::Result<()> {
        lock(&self.forced).remove(account_id);
        self.sync_one(adapter, account_id, now, true).await
    }

    /// One pass: every account the adapter says is due, plus any triggered account.
    pub async fn tick<A: Adapter>(&self, adapter: &A, now: i64) {
        let accounts = match db::accounts::list_accounts(adapter.pool()).await {
            Ok(a) => a,
            Err(e) => {
                warn!(error = %e, "couldn't list accounts for {} sync", A::NAME);
                return;
            }
        };
        let forced: HashSet<String> = std::mem::take(&mut *lock(&self.forced));
        for account in accounts {
            if !forced.contains(&account.id) {
                let due = match adapter.access(&account.id).await {
                    Ok(status) => adapter.due(&account.id, &status).await,
                    Err(e) => Err(e),
                };
                match due {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(e) => {
                        warn!(error = %e, "couldn't read {} access", A::NAME);
                        continue;
                    }
                }
            }
            if let Err(e) = self.sync_one(adapter, &account.id, now, false).await {
                warn!(error = %e, "{} sync failed", A::NAME);
            }
        }
    }

    /// Sync one account and record how it went. Google's refusals are recorded (and
    /// announced) here; the returned error is only a cache failure.
    async fn sync_one<A: Adapter>(
        &self,
        adapter: &A,
        account_id: &str,
        now: i64,
        asked: bool,
    ) -> anyhow::Result<()> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        let before = adapter.access(account_id).await?;
        let status = match adapter.sync(account_id, now, asked).await {
            Ok(()) => AccessStatus::On,
            Err(SyncFailure::Cache(e)) => return Err(e),
            Err(SyncFailure::Google(e)) => match AccessStatus::from_failure(&e) {
                Some(status) => status,
                None if adapter.records_passing_failure(&before) => {
                    AccessStatus::Error(e.to_string())
                }
                None => {
                    warn!(error = %e, "{} sync will retry", A::NAME);
                    // An account the regular ticks skip (never allowed, or waiting on the
                    // user) was asked for: keep asking until Google answers.
                    if !adapter.due(account_id, &before).await.unwrap_or(false) {
                        lock(&self.forced).insert(account_id.to_owned());
                    }
                    return Ok(());
                }
            },
        };
        adapter.record(account_id, &status, now).await?;
        if before.as_str() != status.as_str() {
            adapter.access_changed(account_id, &status);
        }
        Ok(())
    }

    /// Check soon after launch, then every interval on the shared clock (so this check wakes
    /// the computer together with the others), or sooner when triggered.
    pub async fn run<A: Adapter>(&self, adapter: &A) {
        tokio::time::sleep(self.intervals.first).await;
        loop {
            self.tick(adapter, crate::sync::engine::now_ms()).await;
            let wait = if self.foreground.load(Ordering::Relaxed) {
                self.intervals.foreground
            } else {
                self.intervals.background
            };
            tokio::select! {
                () = crate::cadence::sleep_until_next(wait) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::error::tests::api;

    #[test]
    fn failures_that_pass_by_themselves_leave_the_status_alone() {
        for e in [
            GmailError::Network("reset".into()),
            GmailError::Offline("no route".into()),
            GmailError::RateLimit { retry_after: None },
            GmailError::KeychainLocked("locked".into()),
            GmailError::Auth("refresh failed".into()),
            GmailError::SignedOut("Sign in again".into()),
            api(503, None, "Backend Error"),
        ] {
            assert_eq!(AccessStatus::from_failure(&e), None, "{e:?}");
        }
    }

    #[test]
    fn refusals_become_the_status() {
        let scope = api(
            403,
            Some("insufficientPermissions"),
            "Request had insufficient authentication scopes.",
        );
        assert_eq!(
            AccessStatus::from_failure(&scope),
            Some(AccessStatus::MissingScope)
        );
        let disabled = api(
            403,
            Some("accessNotConfigured"),
            "Google Calendar API has not been used in project 1234 before or it is disabled.",
        );
        assert_eq!(
            AccessStatus::from_failure(&disabled),
            Some(AccessStatus::ApiDisabled {
                project: Some("1234".into())
            })
        );
        let bad = api(400, None, "Bad Request");
        assert!(matches!(
            AccessStatus::from_failure(&bad),
            Some(AccessStatus::Error(m)) if m.contains("Bad Request")
        ));
        let decode = GmailError::Decode("not JSON".into());
        assert!(matches!(
            AccessStatus::from_failure(&decode),
            Some(AccessStatus::Error(_))
        ));
    }

    #[test]
    fn a_missing_scope_wins_over_a_disabled_api() {
        let both = api(
            403,
            Some("insufficientPermissions"),
            "API has not been used in project 9 before or it is disabled.",
        );
        assert_eq!(
            AccessStatus::from_failure(&both),
            Some(AccessStatus::MissingScope)
        );
    }

    #[test]
    fn stored_text_round_trips() {
        for status in [
            AccessStatus::Unknown,
            AccessStatus::On,
            AccessStatus::MissingScope,
            AccessStatus::ApiDisabled { project: None },
            AccessStatus::ApiDisabled {
                project: Some("42".into()),
            },
            AccessStatus::Error("Bad Request".into()),
        ] {
            assert_eq!(
                AccessStatus::from_stored(status.as_str(), status.detail()),
                status
            );
        }
        assert_eq!(
            AccessStatus::from_stored("something else", None),
            AccessStatus::Unknown
        );
    }

    #[test]
    fn predicates_name_what_the_callers_ask() {
        assert!(AccessStatus::MissingScope.is_held());
        assert!(AccessStatus::ApiDisabled { project: None }.is_held());
        assert!(!AccessStatus::Error("x".into()).is_held());
        assert!(!AccessStatus::Unknown.is_granted());
        assert!(!AccessStatus::MissingScope.is_granted());
        assert!(AccessStatus::ApiDisabled { project: None }.is_granted());
        assert!(AccessStatus::On.is_on());
        assert!(AccessStatus::Unknown.is_unknown());
    }

    #[test]
    fn the_dto_keeps_its_json_shape() {
        let page = "https://console.cloud.google.com/apis/library/x";
        let json = |s: AccessStatus, at| serde_json::to_value(s.dto(page, at)).unwrap();
        assert_eq!(
            json(AccessStatus::Unknown, None),
            serde_json::json!({"status": "unknown", "message": null, "enableUrl": null, "syncedAt": null})
        );
        assert_eq!(
            json(AccessStatus::Error("Bad Request".into()), Some(5)),
            serde_json::json!({"status": "error", "message": "Bad Request", "enableUrl": null, "syncedAt": 5})
        );
        assert_eq!(
            json(
                AccessStatus::ApiDisabled {
                    project: Some("42".into())
                },
                None
            )["enableUrl"],
            format!("{page}?project=42")
        );
        assert_eq!(
            json(AccessStatus::ApiDisabled { project: None }, None)["enableUrl"],
            page
        );
    }
}
