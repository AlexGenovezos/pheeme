//! Runs sync for every connected account: one sync at a time per account (extra
//! requests coalesce), the 90 s timer, focus/manual/after-action triggers, and a
//! background backfill per account.

use super::api::MailApi;
use super::engine::{now_ms, BackfillProgress, SyncEngine, SyncError, WriteLock};
use super::events::{SyncEvent, SyncEvents};
use super::outbox;
use crate::db::accounts;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;

pub const SYNC_INTERVAL: Duration = Duration::from_secs(90);
/// Focus changes fire often; don't sync on focus more often than this.
pub const FOCUS_MIN_INTERVAL: Duration = Duration::from_secs(15);
/// Pause between backfill pages, to stay well inside Gmail's per-user quota.
pub const BACKFILL_PAUSE: Duration = Duration::from_secs(1);

/// Builds the Gmail API for an account (production: a `GmailClient` on the keychain).
pub type ApiFactory = Arc<dyn Fn(&str) -> Arc<dyn MailApi> + Send + Sync>;

struct AccountSync {
    api: Arc<dyn MailApi>,
    write_lock: WriteLock,
    run_lock: tokio::sync::Mutex<()>,
    running: AtomicBool,
    dirty: AtomicBool,
    backfilling: AtomicBool,
}

pub struct SyncManager {
    db: SqlitePool,
    api_for: ApiFactory,
    events: Arc<dyn SyncEvents>,
    runtime: Handle,
    accounts: Mutex<HashMap<String, Arc<AccountSync>>>,
    last_focus: Mutex<Option<Instant>>,
    backfill_pause: Duration,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SyncManager {
    /// Must be called inside a tokio runtime; background work is spawned on it.
    pub fn new(db: SqlitePool, api_for: ApiFactory, events: Arc<dyn SyncEvents>) -> Arc<Self> {
        Arc::new(Self {
            db,
            api_for,
            events,
            runtime: Handle::current(),
            accounts: Mutex::new(HashMap::new()),
            last_focus: Mutex::new(None),
            backfill_pause: BACKFILL_PAUSE,
        })
    }

    fn account(&self, id: &str) -> Arc<AccountSync> {
        lock(&self.accounts)
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new(AccountSync {
                    api: (self.api_for)(id),
                    write_lock: Default::default(),
                    run_lock: Default::default(),
                    running: AtomicBool::new(false),
                    dirty: AtomicBool::new(false),
                    backfilling: AtomicBool::new(false),
                })
            })
            .clone()
    }

    /// The account's engine, sharing its API client and write lock.
    pub fn engine(&self, account_id: &str) -> SyncEngine {
        let a = self.account(account_id);
        SyncEngine::new(
            self.db.clone(),
            a.api.clone(),
            account_id,
            self.events.clone(),
            a.write_lock.clone(),
        )
    }

    pub fn emit(&self, event: SyncEvent) {
        self.events.emit(event);
    }

    /// Drop an account's sync state (it was removed).
    pub fn forget(&self, account_id: &str) {
        lock(&self.accounts).remove(account_id);
    }

    async fn exists(&self, account_id: &str) -> bool {
        matches!(
            accounts::get_account(&self.db, account_id).await,
            Ok(Some(_))
        )
    }

    /// Push queued changes, pull Gmail's, push again if anything became due, then make
    /// sure the backfill is running. Errors are emitted as `sync:error`, except for an
    /// account that was removed meanwhile, which is dropped quietly.
    pub async fn sync_account(self: &Arc<Self>, account_id: &str) -> Result<(), SyncError> {
        if !self.exists(account_id).await {
            self.forget(account_id);
            return Ok(());
        }
        let a = self.account(account_id);
        let _running = a.run_lock.lock().await;
        let engine = self.engine(account_id);
        let result = async {
            outbox::process(&engine, now_ms()).await?;
            engine.run_incremental_sync().await?;
            outbox::process(&engine, now_ms()).await?;
            Ok::<_, SyncError>(())
        }
        .await;
        match result {
            Ok(()) => {
                self.ensure_backfill(account_id);
                Ok(())
            }
            Err(_) if !self.exists(account_id).await => {
                self.forget(account_id);
                Ok(())
            }
            Err(e) => {
                tracing::warn!(account = account_id, error = %e, "sync failed");
                self.events.emit(SyncEvent::Error {
                    account_id: account_id.to_owned(),
                    code: e.code().to_owned(),
                    message: e.to_string(),
                });
                Err(e)
            }
        }
    }

    /// Sync now, coalescing with a sync already running for the account (it runs once
    /// more afterwards instead of in parallel).
    pub async fn run_coalesced(self: &Arc<Self>, account_id: &str) {
        let a = self.account(account_id);
        a.dirty.store(true, Ordering::SeqCst);
        while a.dirty.load(Ordering::SeqCst) {
            if a.running.swap(true, Ordering::SeqCst) {
                return; // the running loop sees `dirty` and goes again
            }
            while a.dirty.swap(false, Ordering::SeqCst) {
                let _ = self.sync_account(account_id).await;
            }
            a.running.store(false, Ordering::SeqCst);
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

    /// Sync one account, or every account, in the background.
    pub fn trigger(self: &Arc<Self>, account_id: Option<String>) {
        let this = self.clone();
        self.runtime.spawn(async move {
            let ids = match account_id {
                Some(id) => vec![id],
                None => this.account_ids().await,
            };
            futures::future::join_all(ids.iter().map(|id| this.run_coalesced(id))).await;
        });
    }

    /// The window gained focus.
    pub fn trigger_focus(self: &Arc<Self>) {
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
        self.runtime.spawn(async move {
            let mut tick = tokio::time::interval(SYNC_INTERVAL);
            loop {
                tick.tick().await;
                this.trigger(None);
            }
        });
    }

    fn ensure_backfill(self: &Arc<Self>, account_id: &str) {
        let a = self.account(account_id);
        if a.backfilling.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        let id = account_id.to_owned();
        self.runtime.spawn(async move {
            let engine = this.engine(&id);
            loop {
                if !this.exists(&id).await {
                    break;
                }
                match engine.backfill_step().await {
                    Ok(BackfillProgress::More) => tokio::time::sleep(this.backfill_pause).await,
                    Ok(BackfillProgress::Done) => break,
                    Err(e) => {
                        // Picked up again after the next successful sync.
                        tracing::info!(account = %id, error = %e, "backfill paused");
                        break;
                    }
                }
            }
            a.backfilling.store(false, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::{FakeGmail, FakeMsg};

    async fn setup() -> (
        tempfile::TempDir,
        SqlitePool,
        Arc<FakeGmail>,
        Arc<RecordingEvents>,
        Arc<SyncManager>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(dir.path()).await.unwrap();
        accounts::insert_account(
            &pool,
            &accounts::DbAccount {
                id: "a1".into(),
                email: "me@example.com".into(),
                display_name: None,
                profile_photo_url: None,
                client_id: "c".into(),
                history_id: None,
                created_at: 0,
                updated_at: 0,
            },
        )
        .await
        .unwrap();
        let fake = Arc::new(FakeGmail::new());
        let events = Arc::new(RecordingEvents::default());
        let api = fake.clone();
        let manager = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
        );
        (dir, pool, fake, events, manager)
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
            crate::gmail::GmailError::Offline("down".into()),
        );
        assert!(manager.sync_account("a1").await.is_err());
        assert!(events.take().iter().any(|e| matches!(
            e,
            SyncEvent::Error { code, .. } if code == "network"
        )));
    }

    #[tokio::test]
    async fn concurrent_requests_coalesce() {
        let (_dir, _pool, fake, _events, manager) = setup().await;
        futures::future::join_all((0..5).map(|_| manager.run_coalesced("a1"))).await;
        let runs = fake.calls("list_threads") + fake.calls("list_history");
        assert_eq!(runs, 2, "one sync plus one coalesced follow-up");
    }
}
