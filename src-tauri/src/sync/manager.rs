//! Runs sync for every connected account: one sync at a time per account (extra
//! requests coalesce), the 10 s new-mail check (a full sync at least every 90 s),
//! focus/manual/after-action triggers, and a background backfill per account.

use super::api::MailApi;
use super::connectivity::{self, Connectivity, Probe, PROBE_INTERVAL};
use super::engine::{
    now_ms, BackfillProgress, ColorSync, LabelLock, SyncEngine, SyncError, WriteLock,
};
use super::events::{SyncEvent, SyncEvents};
use super::outbox;
use crate::db::accounts;
use crate::gmail::{usage_source, user_action, GmailError, UsageSource, RATE_LIMIT_COOLDOWN};
use crate::lock::lock;
use crate::shutdown::{Shutdown, Stop};
use sqlx::SqlitePool;
use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;

/// How often to ask Gmail for new mail, so notifications arrive within seconds. A check that
/// finds no history costs one `history.list` (2 quota units) and stops there.
pub const SYNC_INTERVAL: Duration = Duration::from_secs(10);
/// A sync also refreshes label names, colours and counters and tells the window to reload.
/// Gmail records no history for label edits made elsewhere, so a full sync runs at least this
/// often even when nothing new arrived.
pub const FULL_SYNC_INTERVAL: Duration = Duration::from_secs(90);
/// Focus changes fire often; don't sync on focus more often than this.
pub const FOCUS_MIN_INTERVAL: Duration = Duration::from_secs(15);
/// Pause between backfill pages, to stay well inside Gmail's per-user quota.
/// Sync runs at least this long are logged.
const SLOW_SYNC: Duration = Duration::from_secs(2);
pub const BACKFILL_PAUSE: Duration = Duration::from_secs(1);

/// Pause after Gmail rate-limits the backfill, unless it says how long to wait: the client keeps
/// background requests off Gmail that long anyway. The page's progress is kept.
pub const BACKFILL_RATE_LIMIT_PAUSE: Duration = RATE_LIMIT_COOLDOWN;

/// Builds the Gmail API for an account (production: a `GmailClient` on the keychain).
pub type ApiFactory = Arc<dyn Fn(&str) -> Arc<dyn MailApi> + Send + Sync>;

/// Clears a flag (`running`, `backfilling`, `first_sync`) however the work it marks ends:
/// finished, failed, panicked, or dropped while waiting.
struct ClearOnDrop<T: Borrow<AtomicBool>>(T);

impl<T: Borrow<AtomicBool>> Drop for ClearOnDrop<T> {
    fn drop(&mut self) {
        self.0.borrow().store(false, Ordering::SeqCst);
    }
}

struct AccountSync {
    api: Arc<dyn MailApi>,
    write_lock: WriteLock,
    label_lock: LabelLock,
    colors: Arc<ColorSync>,
    run_lock: tokio::sync::Mutex<()>,
    outbox_lock: tokio::sync::Mutex<()>,
    running: AtomicBool,
    dirty: AtomicBool,
    backfilling: Arc<AtomicBool>,
    /// The account's first sync (no history cursor yet) is running.
    first_sync: AtomicBool,
    /// When the last full sync succeeded; `None` after a failure, so the next one runs in full
    /// and its `sync:completed` clears the error.
    last_full: Mutex<Option<Instant>>,
}

pub struct SyncManager {
    db: SqlitePool,
    api_for: ApiFactory,
    events: Arc<dyn SyncEvents>,
    runtime: Handle,
    shutdown: Shutdown,
    accounts: Mutex<HashMap<String, Arc<AccountSync>>>,
    /// Accounts removed via [`forget`]; stale triggers check the DB before recreating state.
    forgotten: Mutex<HashSet<String>>,
    last_focus: Mutex<Option<Instant>>,
    backfill_pause: Duration,
    rate_limit_pause: Duration,
    connectivity: Connectivity,
    /// The last sync couldn't read the keychain (the Mac is asleep or locked). Retried on the
    /// usual ticks, but logged once per spell rather than every 90 s all night.
    keychain_waiting: AtomicBool,
}

/// The sync failed because Google couldn't be reached at all, not because of Gmail.
fn is_offline(e: &SyncError) -> bool {
    matches!(e, SyncError::Gmail(GmailError::Offline(_)))
}

/// The sync failed because the keychain can't be read right now: it passes by itself.
fn is_keychain_locked(e: &SyncError) -> bool {
    matches!(e, SyncError::Gmail(GmailError::KeychainLocked(_)))
}

/// Records whether the keychain could be read; true when that changed, so it's worth saying.
fn note_keychain(waiting: &AtomicBool, locked: bool) -> bool {
    waiting.swap(locked, Ordering::SeqCst) != locked
}

impl SyncManager {
    /// Must be called inside a tokio runtime; background work is spawned on it.
    pub fn new(db: SqlitePool, api_for: ApiFactory, events: Arc<dyn SyncEvents>) -> Arc<Self> {
        Self::with_pauses(
            db,
            api_for,
            events,
            BACKFILL_PAUSE,
            BACKFILL_RATE_LIMIT_PAUSE,
            connectivity::http_probe(),
            PROBE_INTERVAL,
        )
    }

    fn with_pauses(
        db: SqlitePool,
        api_for: ApiFactory,
        events: Arc<dyn SyncEvents>,
        backfill_pause: Duration,
        rate_limit_pause: Duration,
        probe: Probe,
        probe_interval: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            api_for,
            events,
            runtime: Handle::current(),
            shutdown: crate::shutdown::APP.clone(),
            accounts: Mutex::new(HashMap::new()),
            forgotten: Mutex::new(HashSet::new()),
            last_focus: Mutex::new(None),
            backfill_pause,
            rate_limit_pause,
            connectivity: Connectivity::new(probe, probe_interval),
            keychain_waiting: AtomicBool::new(false),
        })
    }

    /// Google answered the last time it was asked. While it doesn't, syncs and queued changes
    /// wait for the connection instead of failing.
    pub fn online(&self) -> bool {
        self.connectivity.online()
    }

    /// Google couldn't be reached: say so once, then check until it can, and sync everything.
    fn went_offline(self: &Arc<Self>) {
        if !self.connectivity.went_offline() {
            return;
        }
        tracing::info!("can't reach Google; syncing again once the connection is back");
        self.events.emit(SyncEvent::Network { online: false });
        let this = self.clone();
        self.runtime.spawn(self.shutdown.until(async move {
            this.connectivity.wait_until_online().await;
            tracing::info!("Google is reachable again; syncing");
            // Changes that failed while the connection was going go now, not after their backoff.
            if let Err(e) = crate::db::outbox::retry_waiting(&this.db, now_ms()).await {
                tracing::warn!(error = %e, "couldn't make waiting changes due");
            }
            this.events.emit(SyncEvent::Network { online: true });
            this.trigger(None);
        }));
    }

    /// The last sync couldn't read the keychain (asleep or locked).
    pub fn keychain_waiting(&self) -> bool {
        self.keychain_waiting.load(Ordering::SeqCst)
    }

    /// Log a failure, except a keychain that can't be read: that's said once when it starts.
    fn log_failure(&self, account_id: &str, e: &SyncError, what: &str) {
        if !is_keychain_locked(e) {
            tracing::warn!(account = account_id, error = %e, "{what}");
        } else if note_keychain(&self.keychain_waiting, true) {
            tracing::info!(
                error = %e,
                "can't read the keychain (the Mac is asleep or locked); syncing again once it can"
            );
        }
    }

    /// Report a failed sync: going offline is one app-wide `network:status`, not an error for
    /// every account.
    fn report_error(self: &Arc<Self>, account_id: &str, e: &SyncError) {
        if is_offline(e) {
            self.went_offline();
            return;
        }
        // A rate limit is Gmail slowing us down, not a failure to flag on the account.
        if let SyncError::Gmail(GmailError::RateLimit { retry_after }) = e {
            self.events.emit(SyncEvent::RateLimited {
                account_id: account_id.to_owned(),
                retry_in_ms: retry_after.map(|d| d.as_millis() as u64),
            });
            return;
        }
        self.events.emit(SyncEvent::Error {
            account_id: account_id.to_owned(),
            code: e.code().to_owned(),
            message: e.to_string(),
        });
    }

    fn account(&self, id: &str) -> Arc<AccountSync> {
        lock(&self.accounts)
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new(AccountSync {
                    api: (self.api_for)(id),
                    write_lock: Default::default(),
                    label_lock: Default::default(),
                    colors: Default::default(),
                    run_lock: Default::default(),
                    outbox_lock: Default::default(),
                    running: AtomicBool::new(false),
                    dirty: AtomicBool::new(false),
                    backfilling: Arc::default(),
                    first_sync: AtomicBool::new(false),
                    last_full: Mutex::new(None),
                })
            })
            .clone()
    }

    /// The account's engine, sharing its API client and write lock.
    pub fn engine(&self, account_id: &str) -> SyncEngine {
        self.engine_for(account_id, &self.account(account_id))
    }

    fn engine_for(&self, account_id: &str, a: &AccountSync) -> SyncEngine {
        SyncEngine::new(
            self.db.clone(),
            a.api.clone(),
            account_id,
            self.events.clone(),
            a.write_lock.clone(),
        )
        .with_label_lock(a.label_lock.clone())
        .with_color_sync(a.colors.clone())
    }

    /// The account's Gmail client, for callers that only talk to Gmail (no cache write).
    pub fn api(&self, account_id: &str) -> Arc<dyn MailApi> {
        self.account(account_id).api.clone()
    }

    pub fn emit(&self, event: SyncEvent) {
        self.events.emit(event);
    }

    /// The account's mailbox is still being downloaded (its first sync or the backfill), so
    /// those requests compete with anything the reader opens. Routine syncs don't count.
    pub fn sync_busy(&self, account_id: &str) -> bool {
        // A read: it mustn't bring back the state of an account that was removed.
        lock(&self.accounts).get(account_id).is_some_and(|a| {
            a.backfilling.load(Ordering::SeqCst) || a.first_sync.load(Ordering::SeqCst)
        })
    }

    /// Drop an account's sync state (it was removed).
    pub fn forget(&self, account_id: &str) {
        lock(&self.accounts).remove(account_id);
        lock(&self.forgotten).insert(account_id.to_owned());
    }

    async fn exists(&self, account_id: &str) -> bool {
        matches!(
            accounts::get_account(&self.db, account_id).await,
            Ok(Some(_))
        )
    }

    async fn live_account(&self, account_id: &str, stop: &Stop) -> Option<Arc<AccountSync>> {
        if let Some(existing) = lock(&self.accounts).get(account_id).cloned() {
            return Some(existing);
        }
        // Only check the DB when the account was explicitly forgotten; normal first-use lookups
        // stay synchronous so concurrent callers coalesce without racing on SQLite.
        if !lock(&self.forgotten).contains(account_id) {
            return Some(self.account(account_id));
        }
        if stop.until(self.exists(account_id)).await == Some(true) {
            lock(&self.forgotten).remove(account_id);
            return Some(self.account(account_id));
        }
        None
    }

    /// Serialize queue processing separately from fetching mail. A send whose undo window expires
    /// must not wait for a slow history/body fetch, while label operations still keep their order.
    async fn process_outbox(
        &self,
        account_id: &str,
        a: &AccountSync,
        stop: &Stop,
    ) -> Result<(), SyncError> {
        let Some(_processing) = stop.until(a.outbox_lock.lock()).await else {
            return Ok(());
        };
        // Every queued change is something the user did: it goes ahead of sync and backfill, and
        // its Gmail quota counts as theirs.
        let engine = self.engine_for(account_id, a);
        // Keep the queue's SQL and Gmail futures off the stack of each nested sync caller.
        let dispatch = Box::pin(outbox::process_until(&engine, now_ms(), stop));
        user_action(usage_source(UsageSource::YourChanges, dispatch)).await?;
        Ok(())
    }

    /// Push queued changes, pull Gmail's, push again if anything became due, then make
    /// sure the backfill is running. Errors are emitted as `sync:error`, except for an
    /// account that was removed meanwhile, which is dropped quietly.
    pub async fn sync_account(self: &Arc<Self>, account_id: &str) -> Result<(), SyncError> {
        let Some(stop) = self.shutdown.track() else {
            return Ok(());
        };
        let Some(a) = self.live_account(account_id, &stop).await else {
            return Ok(());
        };
        self.sync_with(account_id, &a, &stop).await
    }

    async fn sync_with(
        self: &Arc<Self>,
        account_id: &str,
        a: &AccountSync,
        stop: &Stop,
    ) -> Result<(), SyncError> {
        let Some(_running) = stop.until(a.run_lock.lock()).await else {
            return Ok(());
        };
        let first = match stop
            .until(accounts::get_account(&self.db, account_id))
            .await
        {
            Some(Ok(Some(account))) => account.history_id.is_none(),
            Some(_) => {
                self.forget(account_id);
                return Ok(());
            }
            None => return Ok(()),
        };
        a.first_sync.store(first, Ordering::SeqCst);
        let _first_done = ClearOnDrop(&a.first_sync);
        let engine = self.engine_for(account_id, a);
        let start = Instant::now();
        let pool = crate::diagnostics::PoolLoad::of(&self.db);
        let full_due = lock(&a.last_full).is_none_or(|t| t.elapsed() >= FULL_SYNC_INTERVAL);
        // Counts what its Gmail requests waited on, for the slow sync line; priorities unchanged.
        let gmail = crate::gmail::probe::RequestProbe::passive();
        let outbox_ms = std::sync::atomic::AtomicU64::new(0);
        let outbox = || async {
            let started = Instant::now();
            let result = self.process_outbox(account_id, a, stop).await;
            outbox_ms.fetch_add(
                crate::diagnostics::ms_since(started),
                std::sync::atomic::Ordering::Relaxed,
            );
            result
        };
        let result = crate::gmail::probe::with_probe(gmail.clone(), async {
            outbox().await?;
            let Some(changed) = stop
                .until(Box::pin(async {
                    if full_due {
                        engine.run_incremental_sync().await.map(Some)
                    } else {
                        engine.check_incremental_sync().await
                    }
                }))
                .await
            else {
                return Ok(None);
            };
            let changed = changed?;
            if changed.is_some() {
                *lock(&a.last_full) = Some(Instant::now());
            }
            outbox().await?;
            Ok::<_, SyncError>(changed)
        })
        .await;
        if stop.stopping() {
            return Ok(());
        }
        if result.is_err() {
            *lock(&a.last_full) = None;
        }
        if start.elapsed() >= SLOW_SYNC {
            // Where the time went: each step, what its Gmail requests waited on, and the database
            // pool when it began. Time the steps don't cover is the outbox's and the cache's.
            let phases = engine.phases();
            let gmail = gmail.snapshot();
            tracing::info!(
                account = account_id,
                elapsed_ms = start.elapsed().as_millis() as u64,
                changed = ?result.as_ref().ok(),
                full = full_due,
                outbox_ms = outbox_ms.load(std::sync::atomic::Ordering::Relaxed),
                history_ms = phases.history_ms,
                history_pages = phases.history_pages,
                history_records = phases.history_records,
                apply_ms = phases.apply_ms,
                resync_ms = phases.resync_ms,
                labels_ms = phases.labels_ms,
                gmail_requests = gmail.requests,
                gmail_ms = gmail.gmail_ms,
                slot_wait_ms = gmail.slot_wait_ms,
                quota_wait_ms = gmail.quota_wait_ms,
                retries = gmail.retries,
                last_status = ?gmail.last_status,
                last_reason = ?gmail.last_reason,
                %pool,
                "slow sync"
            );
        }
        let result = result.map(|_| ());
        match result {
            Ok(()) => {
                if note_keychain(&self.keychain_waiting, false) {
                    tracing::info!("the keychain can be read again; syncing");
                }
                self.ensure_backfill(account_id, a);
                Ok(())
            }
            Err(_) if !self.exists(account_id).await => {
                self.forget(account_id);
                Ok(())
            }
            Err(e) => {
                self.log_failure(account_id, &e, "sync failed");
                self.report_error(account_id, &e);
                Err(e)
            }
        }
    }

    /// Sync now, coalescing with a sync already running for the account (it runs once
    /// more afterwards instead of in parallel).
    pub async fn run_coalesced(self: &Arc<Self>, account_id: &str) {
        let Some(stop) = self.shutdown.track() else {
            return;
        };
        let Some(a) = self.live_account(account_id, &stop).await else {
            return;
        };
        a.dirty.store(true, Ordering::SeqCst);
        while !stop.stopping() && a.dirty.load(Ordering::SeqCst) {
            if a.running.swap(true, Ordering::SeqCst) {
                return; // the running loop sees `dirty` and goes again
            }
            let _running = ClearOnDrop(&a.running);
            while !stop.stopping() && a.dirty.swap(false, Ordering::SeqCst) {
                let _ = self.sync_with(account_id, &a, &stop).await;
            }
        }
    }

    async fn account_ids(&self) -> Vec<String> {
        match accounts::list_accounts(&self.db).await {
            Ok(list) => list.into_iter().map(|a| a.id).collect(),
            Err(e) => {
                tracing::warn!(error = %e, "couldn't list accounts to sync");
                Vec::new()
            }
        }
    }

    /// Sync one account, or every account, in the background. Offline, check the connection now
    /// instead: coming back syncs every account.
    pub fn trigger(self: &Arc<Self>, account_id: Option<String>) {
        if !self.online() {
            self.connectivity.check_soon();
            return;
        }
        let this = self.clone();
        let Some(stop) = self.shutdown.track() else {
            return;
        };
        self.runtime.spawn(async move {
            let ids = match account_id {
                Some(id) => vec![id],
                None => stop.until(this.account_ids()).await.unwrap_or_default(),
            };
            futures::future::join_all(ids.iter().map(|id| this.run_coalesced(id))).await;
        });
    }

    /// Dispatch queued changes once `delay` has passed, then refresh mail. Dispatch runs independently
    /// of an ongoing mail fetch, but shares its outbox lock so no operation is processed twice.
    pub fn trigger_after(self: &Arc<Self>, account_id: &str, delay: Duration) {
        let this = self.clone();
        let id = account_id.to_owned();
        let Some(stop) = self.shutdown.track() else {
            return;
        };
        self.runtime.spawn(async move {
            if stop.until(tokio::time::sleep(delay)).await.is_none()
                || stop.until(this.exists(&id)).await != Some(true)
            {
                return;
            }
            // The change stays queued; coming back online sends it.
            if !this.online() {
                return;
            }
            let a = this.account(&id);
            if let Err(e) = this.process_outbox(&id, &a, &stop).await {
                this.log_failure(&id, &e, "scheduled outbox dispatch failed");
                this.report_error(&id, &e);
            }
            this.run_coalesced(&id).await;
        });
    }

    /// The window gained focus.
    pub fn trigger_focus(self: &Arc<Self>) {
        if !self.online() {
            self.connectivity.check_soon();
            return;
        }
        {
            let mut last = lock(&self.last_focus);
            if last.is_some_and(|t| t.elapsed() < FOCUS_MIN_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        self.trigger(None);
    }

    /// Sync every account now and then every [`SYNC_INTERVAL`].
    pub fn start(self: &Arc<Self>) {
        let this = self.clone();
        self.runtime.spawn(self.shutdown.until(async move {
            // On the shared clock, so the calendar's and tasks' checks share mail's wakeups.
            // After the computer sleeps, this checks once rather than catching up.
            loop {
                // Offline, the connection check takes over until Google answers.
                if this.online() {
                    this.trigger(None);
                }
                crate::cadence::sleep_until_next(SYNC_INTERVAL).await;
            }
        }));
    }

    fn ensure_backfill(self: &Arc<Self>, account_id: &str, a: &AccountSync) {
        if a.backfilling.swap(true, Ordering::SeqCst) {
            return;
        }
        let backfilling = ClearOnDrop(a.backfilling.clone());
        let engine = self.engine_for(account_id, a);
        let this = self.clone();
        let id = account_id.to_owned();
        self.runtime.spawn(self.shutdown.until(async move {
            let _backfilling = backfilling;
            loop {
                if !this.exists(&id).await {
                    break;
                }
                match engine.backfill_step().await {
                    Ok(BackfillProgress::More) => tokio::time::sleep(this.backfill_pause).await,
                    Ok(BackfillProgress::Done) => break,
                    Err(SyncError::Gmail(GmailError::RateLimit { retry_after })) => {
                        let wait = retry_after.unwrap_or(this.rate_limit_pause);
                        tracing::info!(account = %id, ?wait, "backfill rate limited, pausing");
                        this.events.emit(SyncEvent::RateLimited {
                            account_id: id.clone(),
                            retry_in_ms: Some(wait.as_millis() as u64),
                        });
                        tokio::time::sleep(wait).await;
                    }
                    Err(e) => {
                        // Picked up again after the next successful sync.
                        tracing::info!(account = %id, error = %e, "backfill paused");
                        break;
                    }
                }
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::{FakeGmail, FakeMsg};

    async fn setup() -> (
        TestDb,
        SqlitePool,
        Arc<FakeGmail>,
        Arc<RecordingEvents>,
        Arc<SyncManager>,
    ) {
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(FakeGmail::new());
        let events = Arc::new(RecordingEvents::default());
        let api = fake.clone();
        let manager = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
        );
        (db, pool, fake, events, manager)
    }

    /// Sync twice (initial, then a full incremental) and wait for the backfill that follows, so
    /// it can't store mail or refresh labels in the middle of a test.
    async fn synced(manager: &Arc<SyncManager>) {
        manager.sync_account("a1").await.unwrap();
        manager.sync_account("a1").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.sync_busy("a1") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("backfill never finished");
        let state = crate::db::sync_state::get(&manager.db, "a1").await.unwrap();
        assert!(
            state.backfill_complete,
            "a later sync would restart the backfill"
        );
    }

    #[tokio::test]
    async fn frequent_check_stops_at_history_when_nothing_is_new() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        fake.add(FakeMsg::new("m1", "t1", &["INBOX"]));
        synced(&manager).await;
        events.take();
        let labels = fake.calls("list_labels");
        let history = fake.calls("list_history");

        manager.sync_account("a1").await.unwrap();
        assert_eq!(fake.calls("list_history"), history + 1);
        assert_eq!(fake.calls("list_labels"), labels, "no label refresh");
        assert!(events.names().is_empty(), "{:?}", events.names());

        // New mail syncs in full, and alerts, on the next check.
        fake.add(FakeMsg::new(
            "m2",
            "t2",
            &["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
        ));
        manager.sync_account("a1").await.unwrap();
        let names = events.names();
        assert!(names.contains(&"sync:new_mail"), "{names:?}");
        assert!(names.contains(&"sync:completed"), "{names:?}");
        assert_eq!(fake.calls("list_labels"), labels + 1);
    }

    #[tokio::test]
    async fn sync_after_a_failure_runs_in_full() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        synced(&manager).await;
        fake.fail_next("list_history", GmailError::Network("down".into()));
        assert!(manager.sync_account("a1").await.is_err());
        events.take();

        // Nothing new, but the window still hears `sync:completed` to clear the error.
        manager.sync_account("a1").await.unwrap();
        assert!(
            events.names().contains(&"sync:completed"),
            "{:?}",
            events.names()
        );
    }

    #[tokio::test]
    async fn full_sync_runs_once_its_interval_passes() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        synced(&manager).await;
        *lock(&manager.account("a1").last_full) = Instant::now().checked_sub(FULL_SYNC_INTERVAL);
        events.take();
        let labels = fake.calls("list_labels");

        manager.sync_account("a1").await.unwrap();
        assert_eq!(fake.calls("list_labels"), labels + 1);
        assert!(
            events.names().contains(&"sync:completed"),
            "{:?}",
            events.names()
        );
    }

    #[tokio::test]
    async fn first_sync_busy_flag_clears_when_the_first_sync_fails() {
        let (_dir, _pool, fake, _events, manager) = setup().await;
        fake.fail_next("list_threads", GmailError::Network("down".into()));
        assert!(manager.sync_account("a1").await.is_err());
        assert!(!manager.sync_busy("a1"));
    }

    #[tokio::test]
    async fn undo_deadline_dispatches_during_a_blocked_mail_fetch() {
        let (_dir, pool, fake, events, manager) = setup().await;
        manager.engine("a1").run_initial_sync().await.unwrap();
        assert!(!manager.sync_busy("a1"));
        fake.add(FakeMsg::new("new", "new-thread", &["INBOX"]));
        let gate = fake.hold_batch_gets();
        let sync = manager.run_coalesced("a1");
        tokio::pin!(sync);
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut sync)
            .await
            .is_err());
        assert!(manager.account("a1").run_lock.try_lock().is_err());

        let undo = Duration::from_millis(200);
        let op_id = outbox::queue_send(
            &pool,
            "a1",
            b"To: friend@example.com\r\nSubject: Forward\r\n\r\nForwarded content",
            &outbox::SendOptions {
                send_at: now_ms() + undo.as_millis() as i64,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        manager.trigger_after("a1", undo);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(fake.sent().is_empty(), "must preserve the undo window");

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if events.take().iter().any(|e| {
                    matches!(
                        e, SyncEvent::SendStatus { op_id: id, status, .. }
                            if id == &op_id && status == "sent"
                    )
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("send waited for the blocked mail fetch");
        assert_eq!(fake.sent().len(), 1);
        assert!(manager.account("a1").run_lock.try_lock().is_err());
        assert!(
            !manager.sync_busy("a1"),
            "a routine sync isn't the mailbox's first download"
        );

        // Finish the fetch and its coalesced follow-up; neither may dispatch the message again.
        gate.add_permits(10);
        sync.await;
        assert_eq!(fake.sent().len(), 1);
    }

    #[tokio::test]
    async fn shutdown_lets_claimed_sends_finish_and_leaves_other_sends_pending() {
        for scheduled in [false, true] {
            let (_dir, pool, fake, _events, mut manager) = setup().await;
            let shutdown = Shutdown::default();
            Arc::get_mut(&mut manager).unwrap().shutdown = shutdown.clone();
            let raw = b"To: friend@example.com\r\nSubject: Hello\r\n\r\nHi";
            let first = outbox::queue_send(&pool, "a1", raw, &Default::default())
                .await
                .unwrap();
            let second = outbox::queue_send(&pool, "a1", raw, &Default::default())
                .await
                .unwrap();
            let gate = fake.hold_sends();
            if scheduled {
                manager.trigger_after("a1", Duration::ZERO);
            } else {
                manager.trigger(Some("a1".into()));
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while fake.calls("send_message") == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("send wasn't claimed");
            let claimed = crate::db::outbox::get(&pool, &first)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(claimed.status, "checking");

            let drain = shutdown.drain();
            tokio::pin!(drain);
            assert!(futures::poll!(&mut drain).is_pending());
            gate.add_permits(1);
            tokio::time::timeout(Duration::from_secs(5), drain)
                .await
                .unwrap();

            assert_eq!(fake.calls("send_message"), 1);
            assert_eq!(fake.sent().len(), 1);
            assert!(crate::db::outbox::get(&pool, &first)
                .await
                .unwrap()
                .is_none());
            let waiting = crate::db::outbox::get(&pool, &second)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(waiting.status, "pending");
            assert_eq!(waiting.attempts, 0);
        }
    }

    #[tokio::test]
    async fn send_confirmation_does_not_wait_for_draft_cleanup() {
        let (_dir, pool, fake, events, manager) = setup().await;
        let raw = b"To: friend@example.com\r\nSubject: Forward\r\n\r\nForwarded content";
        let draft = fake.create_draft(raw, None).await.unwrap();
        let gate = fake.hold_draft_deletes();
        let op_id = outbox::queue_send(
            &pool,
            "a1",
            raw,
            &outbox::SendOptions {
                draft_id: Some(draft.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let engine = manager.engine("a1");
        let dispatch = outbox::process(&engine, now_ms());
        tokio::pin!(dispatch);
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                result = &mut dispatch => panic!("dispatch completed before blocked cleanup: {result:?}"),
                _ = async {
                    while fake.calls("delete_draft") == 0 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } => {}
            }
        })
        .await
        .expect("dispatch never reached draft cleanup");
        assert_eq!(fake.sent().len(), 1);
        assert_eq!(fake.drafts().len(), 1, "cleanup is still blocked");
        assert!(events.take().iter().any(|e| matches!(
            e, SyncEvent::SendStatus { op_id: id, status, .. }
                if id == &op_id && status == "sent"
        )));
        gate.add_permits(1);
        dispatch.await.unwrap();
        assert!(fake.drafts().is_empty());
    }

    #[tokio::test]
    async fn manager_drops_removed_account_without_error_event() {
        let (_dir, pool, fake, events, manager) = setup().await;
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        manager.sync_account("a1").await.unwrap();
        accounts::delete_account(&pool, "a1").await.unwrap();
        fake.fail_next(
            "list_history",
            crate::gmail::GmailError::Offline("x".into()),
        );

        manager.sync_account("a1").await.unwrap();
        assert!(events
            .take()
            .iter()
            .all(|e| !matches!(e, SyncEvent::Error { .. })));
        assert!(!lock(&manager.accounts).contains_key("a1"));
    }

    #[tokio::test]
    async fn sync_error_is_emitted() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        fake.fail_next(
            "profile_history_id",
            crate::gmail::GmailError::Network("timed out".into()),
        );
        assert!(manager.sync_account("a1").await.is_err());
        assert!(events.take().iter().any(|e| matches!(
            e,
            SyncEvent::Error { code, .. } if code == "network"
        )));
        assert!(
            manager.online(),
            "a timeout reached Google, so it isn't offline"
        );
    }

    #[tokio::test]
    async fn sync_rate_limit_is_a_slowdown_not_an_error() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        fake.fail_next(
            "profile_history_id",
            crate::gmail::GmailError::RateLimit {
                retry_after: Some(Duration::from_secs(7)),
            },
        );
        assert!(manager.sync_account("a1").await.is_err());
        let seen = events.take();
        assert!(seen.contains(&SyncEvent::RateLimited {
            account_id: "a1".into(),
            retry_in_ms: Some(7000),
        }));
        assert!(!seen.iter().any(|e| matches!(e, SyncEvent::Error { .. })));
    }

    #[tokio::test]
    async fn unreadable_keychain_waits_quietly_until_it_can_be_read() {
        let (_dir, _pool, fake, events, manager) = setup().await;
        for _ in 0..2 {
            fake.fail_next(
                "profile_history_id",
                crate::gmail::GmailError::KeychainLocked("in dark wake".into()),
            );
            assert!(manager.sync_account("a1").await.is_err());
            assert!(manager.keychain_waiting());
        }
        let codes: Vec<String> = events
            .take()
            .into_iter()
            .filter_map(|e| match e {
                SyncEvent::Error { code, .. } => Some(code),
                _ => None,
            })
            .collect();
        assert_eq!(codes, ["keychain_locked", "keychain_locked"]);

        manager.sync_account("a1").await.unwrap();
        assert!(!manager.keychain_waiting());
    }

    #[test]
    fn keychain_wait_is_said_once_per_spell() {
        let waiting = AtomicBool::new(false);
        assert!(note_keychain(&waiting, true), "the first failure says so");
        assert!(!note_keychain(&waiting, true), "later ones don't");
        assert!(note_keychain(&waiting, false), "reading it again says so");
        assert!(!note_keychain(&waiting, false), "routine syncs don't");
    }

    /// A check that answers whatever `reachable` holds.
    fn probe(reachable: Arc<AtomicBool>) -> Probe {
        Arc::new(move || {
            let up = reachable.load(Ordering::SeqCst);
            Box::pin(async move { up })
        })
    }

    /// A manager whose connection check answers `reachable`, every 10 ms.
    async fn offline_setup() -> (
        TestDb,
        SqlitePool,
        Arc<FakeGmail>,
        Arc<RecordingEvents>,
        Arc<SyncManager>,
        Arc<AtomicBool>,
    ) {
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(FakeGmail::new());
        let events = Arc::new(RecordingEvents::default());
        let reachable = Arc::new(AtomicBool::new(false));
        let api = fake.clone();
        let manager = SyncManager::with_pauses(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
            Duration::ZERO,
            Duration::from_millis(10),
            probe(reachable.clone()),
            Duration::from_millis(10),
        );
        (db, pool, fake, events, manager, reachable)
    }

    async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "{what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn unreachable_google_is_one_offline_status_not_an_account_error() {
        let (_dir, _pool, fake, events, manager, reachable) = offline_setup().await;
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        fake.fail_next(
            "profile_history_id",
            crate::gmail::GmailError::Offline("dns error".into()),
        );
        assert!(manager.sync_account("a1").await.is_err());
        assert!(!manager.online());
        let seen = events.take();
        assert!(seen.contains(&SyncEvent::Network { online: false }));
        assert!(
            !seen.iter().any(|e| matches!(e, SyncEvent::Error { .. })),
            "{seen:?}"
        );

        // While offline, scheduled, focus and after-action syncs don't ask Gmail.
        let before = fake.calls("profile_history_id");
        manager.trigger(None);
        manager.trigger_focus();
        manager.trigger_after("a1", Duration::ZERO);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(fake.calls("profile_history_id"), before);

        // The connection comes back: online again, and every account syncs.
        reachable.store(true, Ordering::SeqCst);
        eventually("never came back online", || manager.online()).await;
        eventually("didn't sync after reconnecting", || {
            fake.calls("profile_history_id") > before
        })
        .await;
        eventually("no completed sync", || {
            events
                .take()
                .iter()
                .any(|e| matches!(e, SyncEvent::Completed { .. }))
        })
        .await;
        assert!(manager.online());
    }

    #[tokio::test]
    async fn reconnecting_sends_changes_waiting_out_their_backoff() {
        let (_dir, pool, _fake, _events, manager, reachable) = offline_setup().await;
        let now = now_ms();
        let op = crate::db::outbox::DbOp {
            seq: 0,
            id: "op1".into(),
            account_id: "a1".into(),
            kind: "modify".into(),
            payload: "{}".into(),
            status: "pending".into(),
            attempts: 3,
            next_attempt_at: now + 60_000,
            checks_done: 0,
            rfc822_message_id: None,
            last_error: Some("can't reach Gmail".into()),
            created_at: now,
            updated_at: now,
        };
        // A send still in its undo window keeps its time.
        let undo = crate::db::outbox::DbOp {
            id: "send1".into(),
            kind: "send".into(),
            attempts: 0,
            last_error: None,
            ..op.clone()
        };
        let mut conn = pool.acquire().await.unwrap();
        crate::db::outbox::insert(&mut conn, &op, &[])
            .await
            .unwrap();
        crate::db::outbox::insert(&mut conn, &undo, &[])
            .await
            .unwrap();
        drop(conn);

        manager.went_offline();
        reachable.store(true, Ordering::SeqCst);
        eventually("never came back online", || manager.online()).await;
        let due = |id: &'static str| {
            let pool = pool.clone();
            async move {
                crate::db::outbox::get(&pool, id)
                    .await
                    .unwrap()
                    .map(|op| op.next_attempt_at)
            }
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match due("op1").await {
                // Dispatched (and dropped) or made due.
                None => break,
                Some(at) if at <= now_ms() => break,
                Some(_) => {}
            }
            assert!(
                Instant::now() < deadline,
                "the waiting change was never made due"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(due("send1").await, Some(now + 60_000));
    }

    #[tokio::test]
    async fn rate_limited_backfill_resumes_without_waiting_for_a_sync() {
        let (_dir, pool, fake, events, _) = setup().await;
        let api = fake.clone();
        let manager = SyncManager::with_pauses(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
            Duration::ZERO,
            Duration::from_millis(10),
            probe(Arc::new(AtomicBool::new(true))),
            Duration::from_millis(10),
        );
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        fake.seed(FakeMsg::new("old", "t2", &["SENT"]).days_ago(3));
        fake.fail_next(
            "get_message",
            crate::gmail::GmailError::RateLimit { retry_after: None },
        );
        manager.sync_account("a1").await.unwrap();

        // Only the backfill fetches "old"; no further sync is triggered.
        let deadline = Instant::now() + Duration::from_secs(5);
        while crate::db::messages::get_message(&pool, "a1", "old")
            .await
            .unwrap()
            .is_none()
        {
            assert!(Instant::now() < deadline, "backfill never resumed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // The pause was announced with its length, and it isn't an error.
        let seen = events.take();
        assert!(seen.contains(&SyncEvent::RateLimited {
            account_id: "a1".into(),
            retry_in_ms: Some(10),
        }));
        assert!(!seen.iter().any(|e| matches!(e, SyncEvent::Error { .. })));
    }

    #[tokio::test]
    async fn concurrent_requests_coalesce() {
        let (_dir, _pool, fake, _events, manager) = setup().await;
        futures::future::join_all((0..5).map(|_| manager.run_coalesced("a1"))).await;
        let runs = fake.calls("list_threads") + fake.calls("list_history");
        assert_eq!(runs, 2, "one sync plus one coalesced follow-up");
    }

    #[tokio::test]
    async fn a_sync_dropped_midway_doesnt_block_the_next() {
        let (_dir, _pool, fake, _events, manager) = setup().await;
        let a = manager.account("a1");
        let held = a.run_lock.lock().await;
        let sync = manager.run_coalesced("a1");
        assert!(tokio::time::timeout(Duration::from_millis(50), sync)
            .await
            .is_err());
        drop(held);
        assert!(!a.running.load(Ordering::SeqCst));

        manager.run_coalesced("a1").await;
        assert_eq!(fake.calls("list_threads") + fake.calls("list_history"), 1);
    }

    #[tokio::test]
    async fn asking_about_a_removed_account_doesnt_bring_it_back() {
        let (_dir, pool, _fake, _events, manager) = setup().await;
        manager.account("a1");
        let mut tx = crate::db::begin_write(&pool).await.unwrap();
        accounts::delete_account(&mut *tx, "a1").await.unwrap();
        tx.commit().await.unwrap();
        manager.forget("a1");
        assert!(!manager.sync_busy("a1"));
        manager.run_coalesced("a1").await;
        assert!(!lock(&manager.accounts).contains_key("a1"));
    }

    #[tokio::test]
    async fn shutdown_before_the_backfill_is_polled_clears_its_flag() {
        let (_dir, _pool, _fake, _events, mut manager) = setup().await;
        let shutdown = Shutdown::default();
        Arc::get_mut(&mut manager).unwrap().shutdown = shutdown.clone();
        let a = manager.account("a1");
        manager.ensure_backfill("a1", &a);
        assert!(a.backfilling.load(Ordering::SeqCst));
        shutdown.drain().await;
        assert!(!a.backfilling.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_panicking_backfill_can_start_again() {
        let (_dir, _pool, fake, _events, manager) = setup().await;
        fake.add(FakeMsg::new("m1", "t1", &["INBOX"]));
        let ran = Arc::new(AtomicBool::new(false));
        let hook = ran.clone();
        fake.before_next_batch_get(move || {
            hook.store(true, Ordering::SeqCst);
            panic!("backfill blew up");
        });
        manager.ensure_backfill("a1", &manager.account("a1"));
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.sync_busy("a1") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the backfill stayed marked as running");
        assert!(
            ran.load(Ordering::SeqCst),
            "the backfill never reached its fetch"
        );
    }
}
