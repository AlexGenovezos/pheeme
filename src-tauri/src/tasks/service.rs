//! The tasks service the commands call: every account's task lists and tasks, answered from
//! the cache, plus the background loop that keeps the cache current. Runs apart from mail and
//! calendar sync, so a Tasks problem never holds either up.

use super::sync::{classify, sync_account, SyncError};
use super::{TasksApi, TasksFactory};
use crate::db;
use crate::db::tasks::{DbTask, DbTasksAccess};
use crate::gmail::GmailError;
use crate::mail::MailError;
use crate::sync::engine::now_ms;
use crate::sync::{SyncEvent, SyncEvents};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::warn;

/// The Google Tasks API page in the user's Google Cloud project.
pub const TASKS_API_URL: &str =
    "https://console.cloud.google.com/apis/library/tasks.googleapis.com";

/// How often tasks are checked while the app runs.
const INTERVAL: Duration = Duration::from_secs(60);
/// How often while Calendar mode is in front.
const FOREGROUND_INTERVAL: Duration = Duration::from_secs(15);
/// The first check waits for launch and mail's first sync to settle.
const FIRST_DELAY: Duration = Duration::from_secs(5);

/// Statuses that need the user (allow access, turn the API on); not polled until then.
const HELD: [&str; 2] = ["missing_scope", "api_disabled"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksAccessDto {
    /// `unknown` (never checked), `on`, `missing_scope`, `api_disabled` or `error`.
    pub status: String,
    /// What failed, for `error`.
    pub message: Option<String>,
    /// The Tasks API page for the user's project, for `api_disabled`.
    pub enable_url: Option<String>,
    pub synced_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListDto {
    pub id: String,
    pub title: String,
    /// Unticked in the sidebar: its dated tasks stay off the calendar (local only).
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksAccountDto {
    pub account_id: String,
    pub email: String,
    pub access: TasksAccessDto,
    /// In Google's order.
    pub lists: Vec<TaskListDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub account_id: String,
    pub list_id: String,
    pub id: String,
    /// The parent task, for a subtask.
    pub parent: Option<String>,
    pub title: String,
    pub notes: Option<String>,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    pub completed: bool,
    /// When it was completed (UTC ms).
    pub completed_at: Option<i64>,
    /// Completed and cleared from the list's view.
    pub hidden: bool,
    pub updated_at: i64,
    /// The task on the Google Tasks website.
    pub web_view_link: Option<String>,
}

impl From<&DbTask> for TaskDto {
    fn from(t: &DbTask) -> Self {
        let raw: serde_json::Value = serde_json::from_str(&t.raw).unwrap_or_default();
        TaskDto {
            account_id: t.account_id.clone(),
            list_id: t.list_id.clone(),
            id: t.id.clone(),
            parent: t.parent.clone(),
            title: t.title.clone(),
            notes: t.notes.clone(),
            due: t.due_date.clone(),
            completed: t.status == "completed",
            completed_at: t.completed_ms,
            hidden: t.hidden,
            updated_at: t.updated_ms,
            web_view_link: raw
                .get("webViewLink")
                .and_then(|l| l.as_str())
                .map(str::to_owned),
        }
    }
}

pub(super) fn access_dto(access: Option<&DbTasksAccess>) -> TasksAccessDto {
    let Some(a) = access else {
        return TasksAccessDto {
            status: "unknown".into(),
            message: None,
            enable_url: None,
            synced_at: None,
        };
    };
    TasksAccessDto {
        status: a.status.clone(),
        message: (a.status == "error").then(|| a.detail.clone()).flatten(),
        enable_url: (a.status == "api_disabled").then(|| match &a.detail {
            Some(project) => format!("{TASKS_API_URL}?project={project}"),
            None => TASKS_API_URL.to_owned(),
        }),
        synced_at: a.synced_at,
    }
}

/// Tasks in the order the list shows them: top-level tasks by position, each followed by its
/// subtasks by position. A subtask whose parent isn't cached shows at the top level.
pub fn outline(rows: &[DbTask]) -> Vec<&DbTask> {
    let ids: HashSet<&str> = rows.iter().map(|t| t.id.as_str()).collect();
    let is_top = |t: &DbTask| t.parent.as_deref().is_none_or(|p| !ids.contains(p));
    let mut children: HashMap<&str, Vec<&DbTask>> = HashMap::new();
    let mut top = Vec::new();
    for t in rows {
        match t.parent.as_deref() {
            Some(p) if !is_top(t) => children.entry(p).or_default().push(t),
            _ => top.push(t),
        }
    }
    let by_position = |a: &&DbTask, b: &&DbTask| (&a.position, &a.id).cmp(&(&b.position, &b.id));
    top.sort_by(by_position);
    let mut out = Vec::with_capacity(rows.len());
    for t in top {
        out.push(t);
        if let Some(mut subs) = children.remove(t.id.as_str()) {
            subs.sort_by(by_position);
            out.extend(subs);
        }
    }
    out
}

fn sync_error(e: SyncError) -> MailError {
    MailError::Sync(match e {
        SyncError::Api(e) => crate::sync::engine::SyncError::Gmail(e),
        SyncError::Db(e) => crate::sync::engine::SyncError::Db(e),
    })
}

/// A failure that may pass by itself, which doesn't change the account's status.
fn is_transient(e: &GmailError) -> bool {
    match e {
        GmailError::Network(_) | GmailError::Offline(_) | GmailError::RateLimit { .. } => true,
        GmailError::Api { status, .. } => *status >= 500,
        _ => false,
    }
}

pub(super) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct TasksService {
    pub(super) db: SqlitePool,
    pub(super) api_for: TasksFactory,
    pub(super) events: Arc<dyn SyncEvents>,
    foreground: AtomicBool,
    wake: Notify,
    /// Accounts to sync on the next tick whatever their status (just signed in, or written).
    forced: Mutex<HashSet<String>>,
    /// One sync or write per account at a time, so a sync never caches a version older than
    /// a write that landed while it ran.
    running: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl TasksService {
    pub fn new(db: SqlitePool, api_for: TasksFactory, events: Arc<dyn SyncEvents>) -> Arc<Self> {
        Arc::new(Self {
            db,
            api_for,
            events,
            foreground: AtomicBool::new(false),
            wake: Notify::new(),
            forced: Mutex::new(HashSet::new()),
            running: Mutex::new(HashMap::new()),
        })
    }

    /// The account's sync-and-write gate.
    pub(super) fn gate(&self, account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.running)
            .entry(account_id.to_owned())
            .or_default()
            .clone()
    }

    /// Every account with its tasks access and task lists.
    pub async fn accounts(&self) -> Result<Vec<TasksAccountDto>, MailError> {
        let accounts = db::accounts::list_accounts(&self.db).await?;
        let lists = db::tasks::task_lists(&self.db, None).await?;
        let mut out = Vec::with_capacity(accounts.len());
        for account in accounts {
            let access = db::tasks::access(&self.db, &account.id).await?;
            out.push(TasksAccountDto {
                access: access_dto(access.as_ref()),
                lists: lists
                    .iter()
                    .filter(|l| l.account_id == account.id)
                    .map(|l| TaskListDto {
                        id: l.id.clone(),
                        title: l.title.clone(),
                        hidden: l.hidden,
                    })
                    .collect(),
                account_id: account.id,
                email: account.email,
            });
        }
        Ok(out)
    }

    /// A list's tasks (completed and hidden ones too) in the order the list shows them.
    pub async fn tasks(&self, account_id: &str, list_id: &str) -> Result<Vec<TaskDto>, MailError> {
        let rows = db::tasks::tasks(&self.db, account_id, list_id).await?;
        Ok(outline(&rows).into_iter().map(TaskDto::from).collect())
    }

    /// Every account's tasks due on `[from_date, to_date)` (`YYYY-MM-DD`) in shown lists.
    pub async fn dated_tasks(
        &self,
        from_date: &str,
        to_date: &str,
    ) -> Result<Vec<TaskDto>, MailError> {
        let rows = db::tasks::dated_tasks(&self.db, from_date, to_date).await?;
        Ok(rows.iter().map(TaskDto::from).collect())
    }

    /// Show or hide a list's dated tasks on the calendar (local only).
    pub async fn set_list_hidden(
        &self,
        account_id: &str,
        list_id: &str,
        hidden: bool,
    ) -> Result<(), MailError> {
        db::tasks::set_list_hidden(&self.db, account_id, list_id, hidden).await?;
        self.events.emit(SyncEvent::TasksUpdated {
            account_id: account_id.to_owned(),
        });
        Ok(())
    }

    /// Sync the account now, whatever its status (after turning the Tasks API on, or "Check
    /// again"); returns where its access stands.
    pub async fn sync_now(&self, account_id: &str) -> Result<TasksAccessDto, MailError> {
        lock(&self.forced).remove(account_id);
        self.sync_one(account_id, now_ms()).await?;
        let access = db::tasks::access(&self.db, account_id).await?;
        Ok(access_dto(access.as_ref()))
    }

    /// Calendar mode is (or stopped being) in front: check every 15 s instead of 60 s.
    pub fn set_foreground(&self, on: bool) {
        let was = self.foreground.swap(on, Ordering::Relaxed);
        if on && !was {
            self.wake.notify_one();
        }
    }

    /// Check `account_id` (or every account) soon; an account named here is checked even if
    /// its tasks were never checked, so allowing calendar access finds out at once.
    pub fn trigger(&self, account_id: Option<String>) {
        if let Some(id) = account_id {
            lock(&self.forced).insert(id);
        }
        self.wake.notify_one();
    }

    #[cfg(test)]
    pub(super) fn is_forced(&self, account_id: &str) -> bool {
        lock(&self.forced).contains(account_id)
    }

    /// Whether the account's tasks are polled: they work (or failed in passing), or were
    /// never checked but the account allowed calendar access, which includes tasks.
    async fn polled(&self, account_id: &str) -> anyhow::Result<bool> {
        Ok(match db::tasks::access(&self.db, account_id).await? {
            Some(a) => !HELD.contains(&a.status.as_str()),
            None => db::calendar::access(&self.db, account_id)
                .await?
                .is_some_and(|a| a.status == "on"),
        })
    }

    /// One pass: every account whose tasks are polled, plus any triggered account.
    pub async fn tick(&self, now: i64) {
        let accounts = match db::accounts::list_accounts(&self.db).await {
            Ok(a) => a,
            Err(e) => {
                warn!(error = %e, "couldn't list accounts for tasks sync");
                return;
            }
        };
        let forced: HashSet<String> = std::mem::take(&mut *lock(&self.forced));
        for account in accounts {
            let due = forced.contains(&account.id)
                || match self.polled(&account.id).await {
                    Ok(polled) => polled,
                    Err(e) => {
                        warn!(error = %e, "couldn't read tasks access");
                        continue;
                    }
                };
            if !due {
                continue;
            }
            if let Err(e) = self.sync_one(&account.id, now).await {
                warn!(error = %e, "tasks sync failed");
            }
        }
    }

    /// Sync one account and record how it went. Errors are recorded (and emitted) here; the
    /// returned error is only a cache failure.
    async fn sync_one(&self, account_id: &str, now: i64) -> Result<(), MailError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        let before = db::tasks::access(&self.db, account_id)
            .await?
            .map(|a| a.status);
        let api: Arc<dyn TasksApi> = (self.api_for)(account_id);
        let (status, detail) = match sync_account(&self.db, api.as_ref(), account_id, now).await {
            Ok(report) => {
                if report.changed {
                    self.events.emit(SyncEvent::TasksUpdated {
                        account_id: account_id.to_owned(),
                    });
                }
                ("on", None)
            }
            Err(SyncError::Api(e)) if is_transient(&e) => {
                warn!(error = %e, "tasks sync will retry");
                // An account the regular ticks skip was asked for: keep asking until Google
                // answers.
                if !self.polled(account_id).await.unwrap_or(false) {
                    lock(&self.forced).insert(account_id.to_owned());
                }
                return Ok(());
            }
            Err(SyncError::Api(e)) => classify(&e),
            Err(e) => return Err(sync_error(e)),
        };
        db::tasks::set_access(&self.db, account_id, status, detail.as_deref(), now).await?;
        if before.as_deref() != Some(status) {
            self.events.emit(SyncEvent::TasksAccess {
                account_id: account_id.to_owned(),
                status: status.to_owned(),
            });
        }
        Ok(())
    }

    /// Check tasks soon after launch, then every minute (15 s while Calendar mode is in
    /// front), or sooner when triggered.
    pub async fn run(self: Arc<Self>) {
        tokio::time::sleep(FIRST_DELAY).await;
        loop {
            self.tick(now_ms()).await;
            let wait = if self.foreground.load(Ordering::Relaxed) {
                FOREGROUND_INTERVAL
            } else {
                INTERVAL
            };
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::db::accounts::{insert_account, DbAccount};
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use crate::tasks::fake::{task, FakeTasks};
    use serde_json::json;

    pub(in crate::tasks) struct Harness {
        _db: TestDb,
        fakes: HashMap<String, Arc<FakeTasks>>,
        pub(in crate::tasks) events: Arc<RecordingEvents>,
        pub(in crate::tasks) service: Arc<TasksService>,
    }

    pub(in crate::tasks) async fn harness(accounts: &[&str]) -> Harness {
        let db = TestDb::new().await;
        let mut fakes = HashMap::new();
        for id in accounts {
            insert_account(
                &db.pool,
                &DbAccount {
                    id: (*id).into(),
                    email: format!("{id}@example.com"),
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
            let fake = Arc::new(FakeTasks::default());
            fake.add_list("L", "My Tasks");
            fakes.insert((*id).to_owned(), fake);
        }
        let by_account = fakes.clone();
        let api_for: TasksFactory =
            Arc::new(move |account_id: &str| by_account[account_id].clone() as Arc<dyn TasksApi>);
        let events = Arc::new(RecordingEvents::default());
        let service = TasksService::new(db.pool.clone(), api_for, events.clone());
        Harness {
            _db: db,
            fakes,
            events,
            service,
        }
    }

    impl Harness {
        pub(in crate::tasks) fn fake(&self, account: &str) -> &FakeTasks {
            &self.fakes[account]
        }

        pub(in crate::tasks) fn db(&self) -> &SqlitePool {
            &self.service.db
        }

        /// Sync the account once, as allowing calendar access does.
        pub(in crate::tasks) async fn grant(&self, account: &str) {
            let access = self.service.sync_now(account).await.unwrap();
            assert_eq!(access.status, "on");
            self.events.take();
        }

        pub(in crate::tasks) async fn titles(&self, account: &str, list: &str) -> Vec<String> {
            self.service
                .tasks(account, list)
                .await
                .unwrap()
                .into_iter()
                .map(|t| t.title)
                .collect()
        }
    }

    fn disabled() -> GmailError {
        GmailError::Api {
            status: 403,
            reason: Some("SERVICE_DISABLED".into()),
            message: "Google Tasks API has not been used in project 42 before or it is disabled."
                .into(),
        }
    }

    #[tokio::test]
    async fn accounts_list_access_and_lists_and_tasks_come_in_outline_order() {
        let h = harness(&["a", "b"]).await;
        h.fake("a").put("L", task("p", "Trip"));
        h.fake("a").put("L", task("q", "Taxes"));
        h.fake("a").put(
            "L",
            json!({"id": "s2", "title": "Book hotel", "parent": "p"}),
        );
        h.fake("a").put(
            "L",
            json!({"id": "s1", "title": "Pack", "parent": "p",
                             "position": "00000000000000000000"}),
        );
        h.fake("a")
            .put("L", json!({"id": "s2", "position": "00000000000000000001"}));
        h.grant("a").await;

        let accounts = h.service.accounts().await.unwrap();
        assert_eq!(accounts[0].access.status, "on");
        assert!(accounts[0].access.synced_at.is_some());
        assert_eq!(accounts[0].lists[0].title, "My Tasks");
        assert_eq!(accounts[1].access.status, "unknown");
        assert!(accounts[1].lists.is_empty());

        assert_eq!(
            h.titles("a", "L").await,
            vec!["Trip", "Pack", "Book hotel", "Taxes"]
        );
        let tasks = h.service.tasks("a", "L").await.unwrap();
        assert_eq!(tasks[1].parent.as_deref(), Some("p"));
    }

    #[tokio::test]
    async fn dated_tasks_span_accounts_and_hidden_lists_drop_out() {
        let h = harness(&["a", "b"]).await;
        h.fake("a").put(
            "L",
            json!({"id": "x", "title": "Rent", "due": "2026-11-12T00:00:00.000Z"}),
        );
        h.fake("b").put(
            "L",
            json!({"id": "y", "title": "Dentist", "due": "2026-11-10T00:00:00.000Z",
                   "status": "completed", "completed": "2026-11-10T09:00:00.000Z"}),
        );
        h.fake("b").put("L", task("z", "Someday"));
        h.grant("a").await;
        h.grant("b").await;

        let week = h
            .service
            .dated_tasks("2026-11-09", "2026-11-16")
            .await
            .unwrap();
        let got: Vec<(&str, &str, bool)> = week
            .iter()
            .map(|t| (t.account_id.as_str(), t.title.as_str(), t.completed))
            .collect();
        assert_eq!(got, vec![("b", "Dentist", true), ("a", "Rent", false)]);

        h.service.set_list_hidden("b", "L", true).await.unwrap();
        assert_eq!(h.events.names(), vec!["tasks:updated"]);
        let week = h
            .service
            .dated_tasks("2026-11-09", "2026-11-16")
            .await
            .unwrap();
        assert_eq!(week.len(), 1);
        assert!(h.service.accounts().await.unwrap()[1].lists[0].hidden);
    }

    #[tokio::test]
    async fn only_accounts_that_allowed_calendar_access_are_polled() {
        let h = harness(&["a", "b"]).await;
        h.fake("a").put("L", task("t", "Milk"));
        h.fake("b").put("L", task("t", "Eggs"));
        // `a` allowed calendar access (which includes tasks); `b` never did.
        db::calendar::set_access(h.db(), "a", "on", None, 1)
            .await
            .unwrap();
        h.service.tick(10).await;
        assert_eq!(h.titles("a", "L").await, vec!["Milk"]);
        assert!(h.titles("b", "L").await.is_empty());
        assert_eq!(
            h.events.names(),
            vec!["tasks:updated", "tasks:access"],
            "a's tasks arrived and its access is known"
        );
        let accounts = h.service.accounts().await.unwrap();
        assert_eq!(accounts[0].access.status, "on");
        assert_eq!(accounts[1].access.status, "unknown");

        // Signing in (allowing calendar access) triggers `b`.
        h.service.trigger(Some("b".into()));
        h.service.tick(20).await;
        assert_eq!(h.titles("b", "L").await, vec!["Eggs"]);
        assert!(!h.service.is_forced("b"));
    }

    #[tokio::test]
    async fn tasks_api_off_is_its_own_state_and_leaves_calendar_alone() {
        let h = harness(&["a"]).await;
        db::calendar::set_access(h.db(), "a", "on", None, 1)
            .await
            .unwrap();
        h.fake("a").fail_with(disabled);
        h.service.tick(10).await;

        let accounts = h.service.accounts().await.unwrap();
        let access = &accounts[0].access;
        assert_eq!(access.status, "api_disabled");
        assert_eq!(
            access.enable_url.as_deref(),
            Some("https://console.cloud.google.com/apis/library/tasks.googleapis.com?project=42")
        );
        assert_eq!(h.events.names(), vec!["tasks:access"]);
        // Calendar access is untouched.
        let calendar = db::calendar::access(h.db(), "a").await.unwrap().unwrap();
        assert_eq!(calendar.status, "on");

        // Held: the regular ticks leave it alone until the user checks again.
        h.fake("a").succeed();
        h.fake("a").put("L", task("t", "Milk"));
        h.service.tick(20).await;
        assert!(h.titles("a", "L").await.is_empty());
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "on");
        assert_eq!(access.enable_url, None);
        assert_eq!(h.titles("a", "L").await, vec!["Milk"]);
    }

    #[tokio::test]
    async fn missing_scope_and_errors_are_recorded_and_transient_failures_retry() {
        let h = harness(&["a"]).await;
        h.fake("a").fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        });
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "missing_scope");

        // A server error after it worked: recorded as an error, still polled.
        h.fake("a").succeed();
        h.service.sync_now("a").await.unwrap();
        h.fake("a").fail_with(|| GmailError::Api {
            status: 400,
            reason: None,
            message: "Bad Request".into(),
        });
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "error");
        assert!(access.message.unwrap().contains("Bad Request"));
        assert!(access.synced_at.is_some());

        // Offline: the status stays as it was.
        h.fake("a")
            .fail_with(|| GmailError::Offline("no network".into()));
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "error");
    }

    #[tokio::test]
    async fn a_triggered_account_that_never_answered_is_asked_again() {
        let h = harness(&["a"]).await;
        h.fake("a")
            .fail_with(|| GmailError::Offline("no network".into()));
        h.service.trigger(Some("a".into()));
        h.service.tick(10).await;
        assert!(h.service.is_forced("a"));
        h.fake("a").succeed();
        h.service.tick(20).await;
        assert!(!h.service.is_forced("a"));
        assert_eq!(h.service.accounts().await.unwrap()[0].access.status, "on");
    }

    #[test]
    fn orphaned_subtasks_show_at_the_top_level() {
        let row = |id: &str, parent: Option<&str>, position: &str| DbTask {
            account_id: "a".into(),
            list_id: "L".into(),
            id: id.into(),
            parent: parent.map(str::to_owned),
            position: position.into(),
            title: id.into(),
            notes: None,
            due_date: None,
            status: "needsAction".into(),
            completed_ms: None,
            updated_ms: 0,
            hidden: false,
            etag: String::new(),
            raw: "{}".into(),
        };
        let rows = vec![
            row("b", None, "1"),
            row("orphan", Some("gone"), "0"),
            row("a", None, "0"),
            row("a2", Some("a"), "1"),
            row("a1", Some("a"), "0"),
        ];
        let ids: Vec<&str> = outline(&rows).iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "a1", "a2", "orphan", "b"]);
    }
}
