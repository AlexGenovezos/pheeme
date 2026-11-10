//! Keeping an account's task lists and tasks current. The Tasks API has no sync token, so
//! each list is polled with `updatedMin` (deleted tasks included, to see deletions), and read
//! in full every 6 hours to catch anything a poll can't see.

use super::convert;
use super::TasksApi;
use crate::db::tasks::{self as cache, DbTaskList};
use crate::gmail::tasks::TasksQuery;
use crate::gmail::GmailError;
use sqlx::SqlitePool;
use tracing::warn;

/// How often each list is read in full.
pub const FULL_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
/// Polls ask from this far before the newest change seen, in case Google records a change
/// with a slightly earlier time than one already read.
pub const OVERLAP_MS: i64 = 60 * 1000;
/// Pages of the list of lists read per sync, so a broken page token can't loop forever.
const MAX_LIST_PAGES: usize = 20;
/// Pages of 100 tasks per list per sync.
const MAX_TASK_PAGES: usize = 200;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Any list or task row changed.
    pub changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Api(GmailError),
    #[error("tasks cache: {0}")]
    Db(#[from] anyhow::Error),
}

impl From<GmailError> for SyncError {
    fn from(e: GmailError) -> Self {
        SyncError::Api(e)
    }
}

/// The access status an error means: `missing_scope` (allow calendar access again),
/// `api_disabled` (with the Google Cloud project number when Google gave it) or `error`.
pub fn classify(e: &GmailError) -> (&'static str, Option<String>) {
    if e.is_missing_scope() {
        ("missing_scope", None)
    } else if e.is_api_disabled() {
        ("api_disabled", e.disabled_api_project())
    } else {
        ("error", Some(e.to_string()))
    }
}

/// An error that stops the whole account's sync (rather than one list's).
fn is_account_wide(e: &GmailError) -> bool {
    e.is_missing_scope() || e.is_api_disabled() || !e.is_not_found()
}

/// Bring the account's task lists and tasks up to date. `report` says what was committed,
/// even when a later list fails, so the UI still hears about it.
pub async fn sync_account(
    db: &SqlitePool,
    api: &dyn TasksApi,
    account_id: &str,
    now_ms: i64,
    report: &mut SyncReport,
) -> Result<(), SyncError> {
    let mut rows = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_LIST_PAGES {
        let page = api.list_task_lists(page_token.as_deref()).await?;
        rows.extend(page.items.iter().map(convert::task_list));
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    report.changed |= cache::replace_task_lists(db, account_id, &rows).await?;
    for list in cache::task_lists(db, Some(account_id)).await? {
        match sync_list(db, api, &list, now_ms).await {
            Ok(changed) => report.changed |= changed,
            Err(SyncError::Api(e)) if !is_account_wide(&e) => {
                // Deleted since it was listed: the next sync drops it.
                warn!(error = %e, "skipping a task list Google couldn't find");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Sync one list: in full when it never was, or 6 hours ago, otherwise only what changed
/// since the newest change seen. Returns whether any task changed.
async fn sync_list(
    db: &SqlitePool,
    api: &dyn TasksApi,
    list: &DbTaskList,
    now_ms: i64,
) -> Result<bool, SyncError> {
    let poll_from = match (list.synced_through_ms, list.full_synced_at) {
        (Some(mark), Some(at)) if now_ms - at < FULL_INTERVAL_MS => Some(mark - OVERLAP_MS),
        _ => None,
    };
    let updated_min = poll_from.map(convert::rfc3339);
    let mut items = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_TASK_PAGES {
        let page = api
            .list_tasks(
                &list.id,
                TasksQuery {
                    updated_min: updated_min.as_deref(),
                    show_deleted: poll_from.is_some(),
                    page_token: page_token.as_deref(),
                },
            )
            .await?;
        items.extend(page.items);
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    let newest = items
        .iter()
        .filter_map(|t| convert::ms(t.updated.as_deref()))
        .max();
    let mark = match (list.synced_through_ms, newest) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    let (account_id, list_id) = (&list.account_id, &list.id);
    if poll_from.is_none() {
        let rows: Vec<_> = items
            .iter()
            .filter(|t| !t.deleted)
            .map(|t| convert::task(account_id, list_id, t))
            .collect();
        return Ok(cache::replace_tasks(db, account_id, list_id, &rows, newest, now_ms).await?);
    }
    let (mut upserts, mut deleted) = (Vec::new(), Vec::new());
    for t in &items {
        if t.deleted {
            deleted.push(t.id.clone());
        } else {
            upserts.push(convert::task(account_id, list_id, t));
        }
    }
    Ok(cache::apply_task_changes(db, account_id, list_id, &upserts, &deleted, mark).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::tasks::fake::{task, FakeTasks};
    use serde_json::json;

    async fn cached(pool: &SqlitePool, list: &str) -> Vec<(String, String)> {
        cache::tasks(pool, "a", list)
            .await
            .unwrap()
            .into_iter()
            .map(|t| (t.id, t.title))
            .collect()
    }

    fn fake_with_tasks() -> FakeTasks {
        let fake = FakeTasks::default();
        fake.add_list("L", "My Tasks");
        fake.add_list("W", "Work");
        for (id, title) in [("t1", "Milk"), ("t2", "Bread"), ("t3", "Eggs")] {
            fake.put("L", task(id, title));
        }
        fake.put("W", task("w1", "Report"));
        fake
    }

    const HOUR: i64 = 60 * 60 * 1000;

    async fn sync(
        pool: &SqlitePool,
        api: &dyn TasksApi,
        account_id: &str,
        now_ms: i64,
    ) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();
        sync_account(pool, api, account_id, now_ms, &mut report).await?;
        Ok(report)
    }

    #[tokio::test]
    async fn first_sync_reads_every_list_in_full() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_tasks();
        let report = sync(&db.pool, &fake, "a", HOUR).await.unwrap();
        assert!(report.changed);
        assert_eq!(
            cached(&db.pool, "L").await,
            vec![
                ("t1".into(), "Milk".into()),
                ("t2".into(), "Bread".into()),
                ("t3".into(), "Eggs".into())
            ]
        );
        assert_eq!(
            cached(&db.pool, "W").await,
            vec![("w1".into(), "Report".into())]
        );
        // Full reads: no updatedMin, no deleted tasks.
        assert_eq!(
            fake.reads(),
            vec![("L".into(), None, false), ("W".into(), None, false)]
        );
        let lists = cache::task_lists(&db.pool, Some("a")).await.unwrap();
        assert_eq!(lists[0].title, "My Tasks");
        assert_eq!(lists[0].full_synced_at, Some(HOUR));
        assert!(lists[0].synced_through_ms.is_some());
    }

    #[tokio::test]
    async fn later_syncs_poll_with_updated_min_and_apply_changes_and_deletions() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_tasks();
        sync(&db.pool, &fake, "a", HOUR).await.unwrap();
        fake.reads();
        let mark = cache::task_lists(&db.pool, Some("a")).await.unwrap()[0]
            .synced_through_ms
            .unwrap();

        // Nothing changed: polls, and nothing is reported.
        let report = sync(&db.pool, &fake, "a", 2 * HOUR).await.unwrap();
        assert!(!report.changed);
        let reads = fake.reads();
        assert_eq!(
            reads[0].1.as_deref(),
            Some(convert::rfc3339(mark - OVERLAP_MS).as_str())
        );
        assert!(reads[0].2, "polls ask for deleted tasks");

        fake.put(
            "L",
            json!({"id": "t2", "title": "Rye bread", "notes": "Sliced"}),
        );
        fake.put("L", task("t4", "Butter"));
        fake.remove("L", "t1");
        let report = sync(&db.pool, &fake, "a", 2 * HOUR).await.unwrap();
        assert!(report.changed);
        assert_eq!(
            cached(&db.pool, "L").await,
            vec![
                ("t2".into(), "Rye bread".into()),
                ("t3".into(), "Eggs".into()),
                ("t4".into(), "Butter".into())
            ]
        );
        let t2 = cache::task(&db.pool, "a", "L", "t2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(t2.notes.as_deref(), Some("Sliced"));
        let new_mark = cache::task_lists(&db.pool, Some("a")).await.unwrap()[0]
            .synced_through_ms
            .unwrap();
        assert!(new_mark > mark);
        // The untouched list stays as it was.
        assert_eq!(
            cached(&db.pool, "W").await,
            vec![("w1".into(), "Report".into())]
        );
    }

    #[tokio::test]
    async fn every_six_hours_lists_are_read_in_full_and_vanished_tasks_go() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_tasks();
        sync(&db.pool, &fake, "a", HOUR).await.unwrap();
        // Gone without a trace: a poll can't see it.
        fake.forget("L", "t2");
        sync(&db.pool, &fake, "a", 2 * HOUR).await.unwrap();
        assert_eq!(cached(&db.pool, "L").await.len(), 3);
        fake.reads();

        let report = sync(&db.pool, &fake, "a", HOUR + FULL_INTERVAL_MS)
            .await
            .unwrap();
        assert!(report.changed);
        assert_eq!(
            cached(&db.pool, "L").await,
            vec![("t1".into(), "Milk".into()), ("t3".into(), "Eggs".into())]
        );
        assert_eq!(
            fake.reads(),
            vec![("L".into(), None, false), ("W".into(), None, false)]
        );
        let lists = cache::task_lists(&db.pool, Some("a")).await.unwrap();
        assert_eq!(lists[0].full_synced_at, Some(HOUR + FULL_INTERVAL_MS));
    }

    #[tokio::test]
    async fn new_renamed_and_removed_lists_follow_google() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_tasks();
        sync(&db.pool, &fake, "a", HOUR).await.unwrap();
        fake.remove_list("W");
        fake.rename_list("L", "Groceries");
        fake.add_list("N", "New");
        fake.put("N", task("n1", "First"));
        let report = sync(&db.pool, &fake, "a", 2 * HOUR).await.unwrap();
        assert!(report.changed);
        let titles: Vec<String> = cache::task_lists(&db.pool, Some("a"))
            .await
            .unwrap()
            .into_iter()
            .map(|l| l.title)
            .collect();
        assert_eq!(titles, vec!["Groceries", "New"]);
        assert!(cached(&db.pool, "W").await.is_empty());
        assert_eq!(
            cached(&db.pool, "N").await,
            vec![("n1".into(), "First".into())]
        );
    }

    #[tokio::test]
    async fn subtasks_hidden_and_completed_tasks_are_kept() {
        let db = TestDb::with_account("a").await;
        let fake = FakeTasks::default();
        fake.add_list("L", "My Tasks");
        fake.put("L", task("p", "Trip"));
        fake.put(
            "L",
            json!({"id": "s", "title": "Pack", "parent": "p",
                             "due": "2026-11-12T00:00:00.000Z"}),
        );
        fake.put(
            "L",
            json!({"id": "c", "title": "Done", "status": "completed",
                             "completed": "2026-11-01T00:00:05.000Z", "hidden": true}),
        );
        sync(&db.pool, &fake, "a", HOUR).await.unwrap();
        let s = cache::task(&db.pool, "a", "L", "s").await.unwrap().unwrap();
        assert_eq!(s.parent.as_deref(), Some("p"));
        assert_eq!(s.due_date.as_deref(), Some("2026-11-12"));
        let c = cache::task(&db.pool, "a", "L", "c").await.unwrap().unwrap();
        assert!(c.hidden);
        assert_eq!(c.status, "completed");
        assert!(c.completed_ms.is_some());
    }

    #[tokio::test]
    async fn a_list_google_lost_is_skipped_but_account_errors_stop_the_sync() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_tasks();
        fake.fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("SERVICE_DISABLED".into()),
            message: "Google Tasks API has not been used in project 42 before or it is disabled."
                .into(),
        });
        let Err(SyncError::Api(e)) = sync(&db.pool, &fake, "a", HOUR).await else {
            panic!("expected an API error");
        };
        assert_eq!(classify(&e), ("api_disabled", Some("42".into())));
        fake.succeed();

        // A list deleted between listing lists and reading its tasks.
        struct LosesW(FakeTasks);
        #[async_trait::async_trait]
        impl TasksApi for LosesW {
            async fn list_task_lists(
                &self,
                p: Option<&str>,
            ) -> Result<crate::gmail::tasks::TaskListsPage, GmailError> {
                self.0.list_task_lists(p).await
            }
            async fn insert_task_list(
                &self,
                t: &str,
            ) -> Result<crate::gmail::tasks::ApiTaskList, GmailError> {
                self.0.insert_task_list(t).await
            }
            async fn patch_task_list(
                &self,
                l: &str,
                t: &str,
            ) -> Result<crate::gmail::tasks::ApiTaskList, GmailError> {
                self.0.patch_task_list(l, t).await
            }
            async fn delete_task_list(&self, l: &str) -> Result<(), GmailError> {
                self.0.delete_task_list(l).await
            }
            async fn list_tasks(
                &self,
                l: &str,
                q: TasksQuery<'_>,
            ) -> Result<crate::gmail::tasks::TasksPage, GmailError> {
                if l == "W" {
                    return Err(GmailError::Api {
                        status: 404,
                        reason: None,
                        message: "Not Found".into(),
                    });
                }
                self.0.list_tasks(l, q).await
            }
            async fn insert_task(
                &self,
                l: &str,
                b: serde_json::Value,
                p: crate::gmail::tasks::TaskPlacement<'_>,
            ) -> Result<crate::gmail::tasks::ApiTask, GmailError> {
                self.0.insert_task(l, b, p).await
            }
            async fn patch_task(
                &self,
                l: &str,
                t: &str,
                b: serde_json::Value,
            ) -> Result<crate::gmail::tasks::ApiTask, GmailError> {
                self.0.patch_task(l, t, b).await
            }
            async fn delete_task(&self, l: &str, t: &str) -> Result<(), GmailError> {
                self.0.delete_task(l, t).await
            }
            async fn move_task(
                &self,
                l: &str,
                t: &str,
                p: crate::gmail::tasks::TaskPlacement<'_>,
                d: Option<&str>,
            ) -> Result<crate::gmail::tasks::ApiTask, GmailError> {
                self.0.move_task(l, t, p, d).await
            }
        }
        let api = LosesW(fake_with_tasks());
        sync(&db.pool, &api, "a", HOUR).await.unwrap();
        assert_eq!(cached(&db.pool, "L").await.len(), 3);
        assert!(cached(&db.pool, "W").await.is_empty());
    }
}
