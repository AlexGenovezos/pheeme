//! Google Tasks cache: `task_lists`, `tasks` and `tasks_access` (migration 012).

use anyhow::Result;
use sqlx::{SqliteExecutor, SqlitePool};
use std::collections::HashSet;

/// One of an account's task lists, with Pheeme's sync bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbTaskList {
    pub account_id: String,
    pub id: String,
    pub title: String,
    pub sort_order: i64,
    pub etag: Option<String>,
    pub updated_ms: Option<i64>,
    /// Unticked in Pheeme's sidebar (local only, kept across syncs).
    pub hidden: bool,
    pub synced_through_ms: Option<i64>,
    pub full_synced_at: Option<i64>,
}

/// A task list as Google lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskListRow {
    pub id: String,
    pub title: String,
    pub etag: Option<String>,
    pub updated_ms: Option<i64>,
}

/// One cached task. See migration 012 for the columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbTask {
    pub account_id: String,
    pub list_id: String,
    pub id: String,
    pub parent: Option<String>,
    pub position: String,
    pub title: String,
    pub notes: Option<String>,
    pub due_date: Option<String>,
    pub status: String,
    pub completed_ms: Option<i64>,
    pub updated_ms: i64,
    pub hidden: bool,
    pub etag: String,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbTasksAccess {
    pub status: String,
    pub detail: Option<String>,
    pub checked_at: i64,
    pub synced_at: Option<i64>,
}

/// Store the account's task lists in Google's order: upsert each (keeping Pheeme's `hidden`
/// and sync bookkeeping) and delete lists no longer there, with their tasks. Returns whether
/// anything changed.
pub async fn replace_task_lists(
    pool: &SqlitePool,
    account_id: &str,
    lists: &[TaskListRow],
) -> Result<bool> {
    let mut tx = super::begin_write(pool).await?;
    let existing: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id AS "id!: String" FROM task_lists WHERE account_id = ?"#,
        account_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let listed: HashSet<&str> = lists.iter().map(|l| l.id.as_str()).collect();
    let mut changed = false;
    for id in existing.iter().filter(|id| !listed.contains(id.as_str())) {
        sqlx::query!(
            "DELETE FROM task_lists WHERE account_id = ? AND id = ?",
            account_id,
            id
        )
        .execute(&mut *tx)
        .await?;
        changed = true;
    }
    for (order, l) in lists.iter().enumerate() {
        let order = i64::try_from(order)?;
        let done = sqlx::query!(
            "INSERT INTO task_lists (account_id, id, title, sort_order, etag, updated_ms)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, id) DO UPDATE SET
                 title = excluded.title,
                 sort_order = excluded.sort_order,
                 etag = excluded.etag,
                 updated_ms = excluded.updated_ms
             WHERE task_lists.title IS NOT excluded.title
                OR task_lists.sort_order IS NOT excluded.sort_order
                OR task_lists.etag IS NOT excluded.etag",
            account_id,
            l.id,
            l.title,
            order,
            l.etag,
            l.updated_ms
        )
        .execute(&mut *tx)
        .await?;
        changed |= done.rows_affected() > 0;
    }
    tx.commit().await?;
    Ok(changed)
}

/// Store one list Google confirmed (created or renamed); a new one goes last.
pub async fn save_task_list(pool: &SqlitePool, account_id: &str, list: &TaskListRow) -> Result<()> {
    sqlx::query!(
        "INSERT INTO task_lists (account_id, id, title, sort_order, etag, updated_ms)
         VALUES (?1, ?2, ?3,
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM task_lists WHERE account_id = ?1),
                 ?4, ?5)
         ON CONFLICT (account_id, id) DO UPDATE SET
             title = excluded.title,
             etag = excluded.etag,
             updated_ms = excluded.updated_ms",
        account_id,
        list.id,
        list.title,
        list.etag,
        list.updated_ms
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Forget a list and its tasks (Google confirmed it is deleted).
pub async fn delete_task_list<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM task_lists WHERE account_id = ? AND id = ?",
        account_id,
        list_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// The account's task lists (every account's with `None`), in Google's order.
pub async fn task_lists<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: Option<&str>,
) -> Result<Vec<DbTaskList>> {
    Ok(sqlx::query_as!(
        DbTaskList,
        r#"SELECT account_id, id, title, sort_order, etag, updated_ms, hidden AS "hidden: bool",
                  synced_through_ms, full_synced_at
           FROM task_lists
           WHERE ?1 IS NULL OR account_id = ?1
           ORDER BY account_id, sort_order"#,
        account_id
    )
    .fetch_all(ex)
    .await?)
}

/// Show or hide a list's dated tasks on the calendar (Pheeme's sidebar checkbox).
pub async fn set_list_hidden<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
    hidden: bool,
) -> Result<()> {
    sqlx::query!(
        "UPDATE task_lists SET hidden = ? WHERE account_id = ? AND id = ?",
        hidden,
        account_id,
        list_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Read the list in full on its next sync (after a change Google may have spread further
/// than the task written, such as a delete that takes subtasks along).
pub async fn needs_full_sync<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
) -> Result<()> {
    sqlx::query!(
        "UPDATE task_lists SET full_synced_at = NULL WHERE account_id = ? AND id = ?",
        account_id,
        list_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

async fn upsert_task(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    account_id: &str,
    list_id: &str,
    t: &DbTask,
) -> Result<bool> {
    let done = sqlx::query!(
        "INSERT INTO tasks (account_id, list_id, id, parent, position, title, notes, due_date,
             status, completed_ms, updated_ms, hidden, etag, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, list_id, id) DO UPDATE SET
             parent = excluded.parent,
             position = excluded.position,
             title = excluded.title,
             notes = excluded.notes,
             due_date = excluded.due_date,
             status = excluded.status,
             completed_ms = excluded.completed_ms,
             updated_ms = excluded.updated_ms,
             hidden = excluded.hidden,
             etag = excluded.etag,
             raw = excluded.raw
         WHERE tasks.raw IS NOT excluded.raw",
        account_id,
        list_id,
        t.id,
        t.parent,
        t.position,
        t.title,
        t.notes,
        t.due_date,
        t.status,
        t.completed_ms,
        t.updated_ms,
        t.hidden,
        t.etag,
        t.raw
    )
    .execute(&mut **tx)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Replace a list's tasks with a full listing and record it as read in full at `now_ms`,
/// polled from here on from `synced_through_ms`. Returns whether any task changed.
pub async fn replace_tasks(
    pool: &SqlitePool,
    account_id: &str,
    list_id: &str,
    tasks: &[DbTask],
    synced_through_ms: Option<i64>,
    now_ms: i64,
) -> Result<bool> {
    let mut tx = super::begin_write(pool).await?;
    let existing: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id AS "id!: String" FROM tasks WHERE account_id = ? AND list_id = ?"#,
        account_id,
        list_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let listed: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let mut changed = false;
    for id in existing.iter().filter(|id| !listed.contains(id.as_str())) {
        sqlx::query!(
            "DELETE FROM tasks WHERE account_id = ? AND list_id = ? AND id = ?",
            account_id,
            list_id,
            id
        )
        .execute(&mut *tx)
        .await?;
        changed = true;
    }
    for t in tasks {
        changed |= upsert_task(&mut tx, account_id, list_id, t).await?;
    }
    let updated = sqlx::query!(
        "UPDATE task_lists SET synced_through_ms = ?, full_synced_at = ?
         WHERE account_id = ? AND id = ?",
        synced_through_ms,
        now_ms,
        account_id,
        list_id
    )
    .execute(&mut *tx)
    .await?;
    anyhow::ensure!(
        updated.rows_affected() == 1,
        "no task list {list_id} to record a sync on"
    );
    tx.commit().await?;
    Ok(changed)
}

/// Apply a poll's changes (or one write's result) to a list in a single transaction, moving
/// its poll mark to `synced_through_ms` when given. Returns whether any task changed.
pub async fn apply_task_changes(
    pool: &SqlitePool,
    account_id: &str,
    list_id: &str,
    upserts: &[DbTask],
    deleted_ids: &[String],
    synced_through_ms: Option<i64>,
) -> Result<bool> {
    let mut tx = super::begin_write(pool).await?;
    let mut changed = false;
    for id in deleted_ids {
        let done = sqlx::query!(
            "DELETE FROM tasks WHERE account_id = ? AND list_id = ? AND id = ?",
            account_id,
            list_id,
            id
        )
        .execute(&mut *tx)
        .await?;
        changed |= done.rows_affected() > 0;
    }
    for t in upserts {
        changed |= upsert_task(&mut tx, account_id, list_id, t).await?;
    }
    if let Some(mark) = synced_through_ms {
        let updated = sqlx::query!(
            "UPDATE task_lists SET synced_through_ms = ? WHERE account_id = ? AND id = ?",
            mark,
            account_id,
            list_id
        )
        .execute(&mut *tx)
        .await?;
        anyhow::ensure!(
            updated.rows_affected() == 1,
            "no task list {list_id} to record a sync on"
        );
    }
    tx.commit().await?;
    Ok(changed)
}

/// Forget a task and its subtasks (Google confirmed the delete, or the task left the list).
pub async fn remove_task_with_subtasks<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
    task_id: &str,
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM tasks WHERE account_id = ?1 AND list_id = ?2 AND (id = ?3 OR parent = ?3)",
        account_id,
        list_id,
        task_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// A list's tasks, completed and hidden ones too, by position.
pub async fn tasks<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
) -> Result<Vec<DbTask>> {
    Ok(sqlx::query_as!(
        DbTask,
        r#"SELECT account_id, list_id, id, parent, position, title, notes, due_date, status,
                  completed_ms, updated_ms, hidden AS "hidden: bool", etag, raw
           FROM tasks WHERE account_id = ? AND list_id = ?
           ORDER BY position, id"#,
        account_id,
        list_id
    )
    .fetch_all(ex)
    .await?)
}

pub async fn task<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    list_id: &str,
    task_id: &str,
) -> Result<Option<DbTask>> {
    Ok(sqlx::query_as!(
        DbTask,
        r#"SELECT account_id, list_id, id, parent, position, title, notes, due_date, status,
                  completed_ms, updated_ms, hidden AS "hidden: bool", etag, raw
           FROM tasks WHERE account_id = ? AND list_id = ? AND id = ?"#,
        account_id,
        list_id,
        task_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Tasks due on `[from_date, to_date)` (`YYYY-MM-DD`) in lists that aren't hidden, every
/// account's, by date.
pub async fn dated_tasks<'e>(
    ex: impl SqliteExecutor<'e>,
    from_date: &str,
    to_date: &str,
) -> Result<Vec<DbTask>> {
    Ok(sqlx::query_as!(
        DbTask,
        r#"SELECT t.account_id, t.list_id, t.id, t.parent, t.position, t.title, t.notes,
                  t.due_date, t.status, t.completed_ms, t.updated_ms, t.hidden AS "hidden: bool",
                  t.etag, t.raw
           FROM tasks t
           JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
           WHERE t.due_date >= ? AND t.due_date < ? AND l.hidden = 0
           ORDER BY t.due_date, t.account_id, l.sort_order, t.position, t.id"#,
        from_date,
        to_date
    )
    .fetch_all(ex)
    .await?)
}

pub async fn access<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Option<DbTasksAccess>> {
    Ok(sqlx::query_as!(
        DbTasksAccess,
        "SELECT status, detail, checked_at, synced_at FROM tasks_access WHERE account_id = ?",
        account_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Record a sync attempt at `now_ms`; `on` also records it as the last sync that worked.
pub async fn set_access<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    status: &str,
    detail: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO tasks_access (account_id, status, detail, checked_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?2 = 'on' THEN ?4 END)
         ON CONFLICT (account_id) DO UPDATE SET
             status = excluded.status,
             detail = excluded.detail,
             checked_at = excluded.checked_at,
             synced_at = CASE WHEN ?2 = 'on' THEN ?4 ELSE tasks_access.synced_at END",
        account_id,
        status,
        detail,
        now_ms
    )
    .execute(ex)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn list(id: &str, title: &str, etag: &str) -> TaskListRow {
        TaskListRow {
            id: id.into(),
            title: title.into(),
            etag: Some(etag.into()),
            updated_ms: None,
        }
    }

    fn task(id: &str, raw: &str) -> DbTask {
        DbTask {
            account_id: "a".into(),
            list_id: "L".into(),
            id: id.into(),
            parent: None,
            position: "0".into(),
            title: id.into(),
            notes: None,
            due_date: None,
            status: "needsAction".into(),
            completed_ms: None,
            updated_ms: 1,
            hidden: false,
            etag: raw.into(),
            raw: raw.into(),
        }
    }

    #[tokio::test]
    async fn lists_keep_hidden_and_report_changes() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        let two = [list("L", "Mine", "1"), list("M", "Work", "1")];
        assert!(replace_task_lists(pool, "a", &two).await.unwrap());
        assert!(!replace_task_lists(pool, "a", &two).await.unwrap());
        set_list_hidden(pool, "a", "M", true).await.unwrap();
        let renamed = [list("L", "Mine", "1"), list("M", "Job", "2")];
        assert!(replace_task_lists(pool, "a", &renamed).await.unwrap());
        let got = task_lists(pool, Some("a")).await.unwrap();
        assert_eq!(got[1].title, "Job");
        assert!(got[1].hidden);

        replace_tasks(pool, "a", "M", &[task("t", "r")], Some(5), 9)
            .await
            .unwrap();
        // A list that is gone takes its tasks along.
        assert!(replace_task_lists(pool, "a", &[list("L", "Mine", "1")])
            .await
            .unwrap());
        assert!(tasks(pool, "a", "M").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn task_changes_report_only_real_changes() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_task_lists(pool, "a", &[list("L", "Mine", "1")])
            .await
            .unwrap();
        assert!(replace_tasks(
            pool,
            "a",
            "L",
            &[task("t1", "a"), task("t2", "a")],
            Some(5),
            9
        )
        .await
        .unwrap());
        let l = &task_lists(pool, Some("a")).await.unwrap()[0];
        assert_eq!((l.synced_through_ms, l.full_synced_at), (Some(5), Some(9)));

        // The same versions again: nothing changed.
        assert!(
            !apply_task_changes(pool, "a", "L", &[task("t1", "a")], &[], Some(6))
                .await
                .unwrap()
        );
        assert!(
            apply_task_changes(pool, "a", "L", &[task("t1", "b")], &[], None)
                .await
                .unwrap()
        );
        assert!(
            !apply_task_changes(pool, "a", "L", &[], &["nope".into()], None)
                .await
                .unwrap()
        );
        assert!(
            apply_task_changes(pool, "a", "L", &[], &["t2".into()], None)
                .await
                .unwrap()
        );
        let l = &task_lists(pool, Some("a")).await.unwrap()[0];
        assert_eq!(l.synced_through_ms, Some(6));
        let ids: Vec<String> = tasks(pool, "a", "L")
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec!["t1"]);

        needs_full_sync(pool, "a", "L").await.unwrap();
        let l = &task_lists(pool, Some("a")).await.unwrap()[0];
        assert_eq!(l.full_synced_at, None);
    }

    #[tokio::test]
    async fn saved_lists_go_last_and_access_keeps_last_success() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_task_lists(pool, "a", &[list("L", "Mine", "1")])
            .await
            .unwrap();
        save_task_list(pool, "a", &list("N", "New", "1"))
            .await
            .unwrap();
        save_task_list(pool, "a", &list("L", "Renamed", "2"))
            .await
            .unwrap();
        let got: Vec<(String, String, i64)> = task_lists(pool, Some("a"))
            .await
            .unwrap()
            .into_iter()
            .map(|l| (l.id, l.title, l.sort_order))
            .collect();
        assert_eq!(
            got,
            vec![
                ("L".into(), "Renamed".into(), 0),
                ("N".into(), "New".into(), 1)
            ]
        );

        set_access(pool, "a", "on", None, 7).await.unwrap();
        set_access(pool, "a", "api_disabled", Some("123"), 8)
            .await
            .unwrap();
        let got = access(pool, "a").await.unwrap().unwrap();
        assert_eq!(got.status, "api_disabled");
        assert_eq!(got.detail.as_deref(), Some("123"));
        assert_eq!(got.synced_at, Some(7));
    }

    #[tokio::test]
    async fn dated_tasks_skip_hidden_lists() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_task_lists(pool, "a", &[list("L", "Mine", "1"), list("M", "Work", "1")])
            .await
            .unwrap();
        let due = |id: &str, list: &str, date: &str| {
            let mut t = task(id, id);
            t.list_id = list.into();
            t.due_date = Some(date.into());
            t
        };
        replace_tasks(pool, "a", "L", &[due("t1", "L", "2026-11-12")], None, 1)
            .await
            .unwrap();
        replace_tasks(
            pool,
            "a",
            "M",
            &[due("t2", "M", "2026-11-11"), due("t3", "M", "2026-11-20")],
            None,
            1,
        )
        .await
        .unwrap();
        let ids = |rows: Vec<DbTask>| rows.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(
            ids(dated_tasks(pool, "2026-11-09", "2026-11-16").await.unwrap()),
            vec!["t2", "t1"]
        );
        set_list_hidden(pool, "a", "M", true).await.unwrap();
        assert_eq!(
            ids(dated_tasks(pool, "2026-11-09", "2026-11-16").await.unwrap()),
            vec!["t1"]
        );
    }
}
