use crate::db::messages::{self, DbMessage};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbThread {
    pub id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub history_id: Option<String>,
    pub last_message_date: Option<i64>,
    pub message_count: i64,
    pub unread_count: i64,
    pub has_attachment: i64,
    /// Sender of the latest message.
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub is_starred: i64,
}

/// Upserts the thread row and replaces its label set (`thread_labels`) in one
/// transaction. Never use `INSERT OR REPLACE` on `threads`: the implicit delete
/// would cascade away the thread's `thread_labels` rows.
///
/// Test-only: production derives thread rows from messages via [`recompute_threads`].
#[cfg(test)]
pub async fn upsert_thread(
    pool: &SqlitePool,
    thread: &DbThread,
    label_ids: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    upsert_thread_tx(&mut tx, thread, label_ids).await?;
    tx.commit().await?;
    Ok(())
}

/// Upsert the thread row and replace its label set inside the caller's transaction.
async fn upsert_thread_tx(
    conn: &mut SqliteConnection,
    thread: &DbThread,
    label_ids: &[String],
) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO threads (
            id, account_id, subject, snippet, history_id,
            last_message_date, message_count, unread_count, has_attachment,
            from_name, from_address, is_starred
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            subject = excluded.subject,
            snippet = excluded.snippet,
            history_id = excluded.history_id,
            last_message_date = excluded.last_message_date,
            message_count = excluded.message_count,
            unread_count = excluded.unread_count,
            has_attachment = excluded.has_attachment,
            from_name = excluded.from_name,
            from_address = excluded.from_address,
            is_starred = excluded.is_starred
        "#,
        thread.id,
        thread.account_id,
        thread.subject,
        thread.snippet,
        thread.history_id,
        thread.last_message_date,
        thread.message_count,
        thread.unread_count,
        thread.has_attachment,
        thread.from_name,
        thread.from_address,
        thread.is_starred,
    )
    .execute(&mut *conn)
    .await?;

    replace_thread_labels(
        conn,
        &thread.account_id,
        &thread.id,
        thread.last_message_date,
        label_ids,
    )
    .await
}

/// Deletes and re-inserts the thread's label rows inside the caller's
/// transaction, stamping each with the thread's `last_message_date`.
async fn replace_thread_labels(
    tx: &mut sqlx::SqliteConnection,
    account_id: &str,
    thread_id: &str,
    last_message_date: Option<i64>,
    label_ids: &[String],
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?",
        account_id,
        thread_id
    )
    .execute(&mut *tx)
    .await?;

    for label_id in label_ids {
        sqlx::query!(
            r#"
            INSERT INTO thread_labels (account_id, thread_id, label_id, last_message_date)
            VALUES (?, ?, ?, COALESCE(?, 0))
            ON CONFLICT(account_id, thread_id, label_id) DO NOTHING
            "#,
            account_id,
            thread_id,
            label_id,
            last_message_date
        )
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

pub async fn get_thread(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<Option<DbThread>> {
    let thread = sqlx::query_as!(
        DbThread,
        r#"
        SELECT id, account_id, subject, snippet, history_id,
               last_message_date, message_count, unread_count, has_attachment,
               from_name, from_address, is_starred
        FROM threads WHERE account_id = ? AND id = ?
        "#,
        account_id,
        thread_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(thread)
}

/// Replaces the thread's label set, keeping each row's `last_message_date`
/// in step with the thread. A no-op for a thread that doesn't exist.
///
/// Test-only: production derives labels from messages via [`recompute_threads`].
#[cfg(test)]
pub async fn update_thread_labels(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
    label_ids: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        "SELECT last_message_date FROM threads WHERE account_id = ? AND id = ?",
        account_id,
        thread_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = row {
        replace_thread_labels(
            &mut tx,
            account_id,
            thread_id,
            row.last_message_date,
            label_ids,
        )
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Label ids of a thread, sorted ascending.
pub async fn get_thread_label_ids(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<String>> {
    let rows = sqlx::query!(
        r#"
        SELECT label_id FROM thread_labels
        WHERE account_id = ? AND thread_id = ?
        ORDER BY label_id ASC
        "#,
        account_id,
        thread_id
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.label_id).collect())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadCursor {
    pub last_message_date: i64,
    pub account_id: String,
    pub thread_id: String,
}

pub struct ThreadQuery<'a> {
    /// One id is a per-account view; all ids is All Inboxes.
    pub account_ids: &'a [String],
    /// Drives the index, e.g. "INBOX" or "CATEGORY_PRIMARY".
    pub label_id: &'a str,
    /// Intersection, e.g. Primary tab = CATEGORY_PRIMARY + INBOX.
    pub also_label_id: Option<&'a str>,
    pub before: Option<&'a ThreadCursor>,
    pub limit: i64,
}

pub struct ThreadPage {
    pub threads: Vec<DbThread>,
    /// `Some` when more rows exist.
    pub next: Option<ThreadCursor>,
}

struct ThreadRow {
    id: String,
    account_id: String,
    subject: Option<String>,
    snippet: Option<String>,
    history_id: Option<String>,
    last_message_date: Option<i64>,
    message_count: i64,
    unread_count: i64,
    has_attachment: i64,
    from_name: Option<String>,
    from_address: Option<String>,
    is_starred: i64,
    cursor_date: i64,
}

/// Lists threads newest first (`last_message_date DESC, account_id DESC,
/// thread_id DESC`) straight off `idx_thread_labels_listing`, paged by keyset.
pub async fn list_threads(pool: &SqlitePool, q: &ThreadQuery<'_>) -> Result<ThreadPage> {
    if q.limit <= 0 {
        anyhow::bail!("thread list limit must be positive");
    }
    let page_limit = q.limit as usize;
    let fetch_limit = q.limit.saturating_add(1);

    let account_ids = serde_json::to_string(q.account_ids)?;

    // Two queries rather than `?3 IS NULL OR (...) < (...)`: the plain row-value
    // comparison lets SQLite seek into `idx_thread_labels_listing` at the cursor.
    let rows = match q.before {
        None => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?3))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?4
        "#,
                q.label_id,
                account_ids,
                q.also_label_id,
                fetch_limit,
            )
            .fetch_all(pool)
            .await?
        }
        Some(c) => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (tl.last_message_date, tl.account_id, tl.thread_id) < (?3, ?4, ?5)
          AND (?6 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?6))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?7
        "#,
                q.label_id,
                account_ids,
                c.last_message_date,
                c.account_id,
                c.thread_id,
                q.also_label_id,
                fetch_limit,
            )
            .fetch_all(pool)
            .await?
        }
    };

    let has_more = rows.len() > page_limit;
    let mut rows = rows;
    rows.truncate(page_limit);

    let next = if has_more {
        rows.last().map(|r| ThreadCursor {
            last_message_date: r.cursor_date,
            account_id: r.account_id.clone(),
            thread_id: r.id.clone(),
        })
    } else {
        None
    };
    let threads = rows
        .into_iter()
        .map(|r| DbThread {
            id: r.id,
            account_id: r.account_id,
            subject: r.subject,
            snippet: r.snippet,
            history_id: r.history_id,
            last_message_date: r.last_message_date,
            message_count: r.message_count,
            unread_count: r.unread_count,
            has_attachment: r.has_attachment,
            from_name: r.from_name,
            from_address: r.from_address,
            is_starred: r.is_starred,
        })
        .collect();
    Ok(ThreadPage { threads, next })
}

/// Inbox category labels, in tab order. `CATEGORY_PERSONAL` is the Primary tab.
pub const CATEGORY_LABELS: [&str; 5] = [
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];

/// The thread row and label set implied by a thread's cached messages (sorted by date
/// ascending), or `None` when it has none.
///
/// A trashed (or spam) message only puts the thread in Trash (or Spam): its other labels
/// don't count, so trashing a message takes the thread out of the Inbox right away. Counts
/// and the sender come from the messages that aren't trashed/spam, unless all of them are.
pub fn derive_thread(
    account_id: &str,
    thread_id: &str,
    messages: &[DbMessage],
) -> Option<(DbThread, Vec<String>)> {
    if messages.is_empty() {
        return None;
    }
    let mut labels = BTreeSet::new();
    let mut visible = Vec::new();
    for msg in messages {
        let own = msg.labels();
        if own.iter().any(|l| l == "TRASH") {
            labels.insert("TRASH".to_owned());
        } else if own.iter().any(|l| l == "SPAM") {
            labels.insert("SPAM".to_owned());
        } else {
            labels.extend(own);
            visible.push(msg);
        }
    }
    if visible.is_empty() {
        visible = messages.iter().collect();
    }
    let latest = visible
        .iter()
        .max_by_key(|m| m.date.unwrap_or(i64::MIN))
        .expect("non-empty");
    let thread = DbThread {
        id: thread_id.to_owned(),
        account_id: account_id.to_owned(),
        subject: visible.iter().find_map(|m| m.subject.clone()),
        snippet: latest.snippet.clone(),
        history_id: None,
        last_message_date: visible.iter().filter_map(|m| m.date).max(),
        message_count: visible.len() as i64,
        unread_count: visible.iter().filter(|m| m.is_read == 0).count() as i64,
        has_attachment: visible.iter().any(|m| m.has_attachment != 0).into(),
        from_name: latest.from_name.clone(),
        from_address: latest.from_address.clone(),
        is_starred: visible.iter().any(|m| m.is_starred != 0).into(),
    };
    Some((thread, labels.into_iter().collect()))
}

/// Thread ids touched by a write, by what happened to them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecomputeResult {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

impl RecomputeResult {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.updated.is_empty() && self.removed.is_empty()
    }
}

/// Rebuild the thread rows and `thread_labels` of `thread_ids` from their cached messages,
/// deleting threads that no longer have any.
pub async fn recompute_threads(
    conn: &mut SqliteConnection,
    account_id: &str,
    thread_ids: &[String],
) -> Result<RecomputeResult> {
    let mut result = RecomputeResult::default();
    let unique: BTreeSet<&String> = thread_ids.iter().collect();
    for thread_id in unique {
        let existed = sqlx::query_scalar!(
            r#"SELECT 1 AS "one!: i64" FROM threads WHERE account_id = ? AND id = ?"#,
            account_id,
            thread_id
        )
        .fetch_optional(&mut *conn)
        .await?
        .is_some();
        let msgs = messages::get_messages_for_thread(&mut *conn, account_id, thread_id).await?;
        match derive_thread(account_id, thread_id, &msgs) {
            Some((thread, labels)) => {
                upsert_thread_tx(conn, &thread, &labels).await?;
                if existed {
                    result.updated.push(thread_id.clone());
                } else {
                    result.created.push(thread_id.clone());
                }
            }
            None if existed => {
                sqlx::query!(
                    "DELETE FROM threads WHERE account_id = ? AND id = ?",
                    account_id,
                    thread_id
                )
                .execute(&mut *conn)
                .await?;
                result.removed.push(thread_id.clone());
            }
            None => {}
        }
    }
    Ok(result)
}

/// Unread thread counts across `account_ids` for `INBOX` and each inbox category tab
/// (`INBOX ∩ CATEGORY_x`). Labels with no unread threads are omitted.
pub async fn unread_counts(
    pool: &SqlitePool,
    account_ids: &[String],
) -> Result<Vec<(String, i64)>> {
    let accounts = serde_json::to_string(account_ids)?;
    let rows = sqlx::query!(
        r#"
        SELECT x.label_id AS "label_id!", COUNT(*) AS "count!: i64"
        FROM thread_labels i
        JOIN thread_labels u
          ON u.account_id = i.account_id AND u.thread_id = i.thread_id AND u.label_id = 'UNREAD'
        JOIN thread_labels x
          ON x.account_id = i.account_id AND x.thread_id = i.thread_id
         AND x.label_id IN ('INBOX', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
                            'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')
        WHERE i.label_id = 'INBOX' AND i.account_id IN (SELECT value FROM json_each(?))
        GROUP BY x.label_id
        ORDER BY x.label_id
        "#,
        accounts
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| (r.label_id, r.count)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::accounts::{insert_account, DbAccount};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    fn labels(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn account(id: &str) -> DbAccount {
        DbAccount {
            id: id.into(),
            email: format!("{id}@example.com"),
            display_name: None,
            profile_photo_url: None,
            client_id: "client-1".into(),
            history_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn thread(account_id: &str, id: &str, date: Option<i64>) -> DbThread {
        DbThread {
            id: id.into(),
            account_id: account_id.into(),
            subject: None,
            snippet: None,
            history_id: None,
            last_message_date: date,
            message_count: 1,
            unread_count: 0,
            has_attachment: 0,
            from_name: None,
            from_address: None,
            is_starred: 0,
        }
    }

    /// In-memory pool with accounts `a1` and `a2`.
    async fn seeded_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        for id in ["a1", "a2"] {
            insert_account(&pool, &account(id)).await.unwrap();
        }
        pool
    }

    async fn seed(pool: &SqlitePool, account_id: &str, id: &str, date: Option<i64>, l: &[&str]) {
        upsert_thread(pool, &thread(account_id, id, date), &labels(l))
            .await
            .unwrap();
    }

    fn query<'a>(
        account_ids: &'a [String],
        before: Option<&'a ThreadCursor>,
        limit: i64,
    ) -> ThreadQuery<'a> {
        ThreadQuery {
            account_ids,
            label_id: "INBOX",
            also_label_id: None,
            before,
            limit,
        }
    }

    const FIRST_PAGE_SQL: &str = r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?3))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?4
        "#;

    const CURSOR_PAGE_SQL: &str = r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (tl.last_message_date, tl.account_id, tl.thread_id) < (?3, ?4, ?5)
          AND (?6 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?6))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?7
        "#;

    /// Pages through the whole listing, returning `(account_id, id)` pairs.
    async fn page_all(pool: &SqlitePool, q: &ThreadQuery<'_>) -> Vec<(String, String)> {
        let mut out = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_threads(
                pool,
                &ThreadQuery {
                    before: cursor.as_ref(),
                    ..*q
                },
            )
            .await
            .unwrap();
            out.extend(page.threads.into_iter().map(|t| (t.account_id, t.id)));
            match page.next {
                Some(next) => cursor = Some(next),
                None => return out,
            }
        }
    }

    fn pair(a: &str, t: &str) -> (String, String) {
        (a.to_string(), t.to_string())
    }

    #[tokio::test]
    async fn list_threads_orders_newest_first_across_accounts() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(300), &["INBOX"]).await;
        seed(&pool, "a1", "t2", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t3", Some(200), &["INBOX"]).await;

        let accounts = labels(&["a1", "a2"]);
        let page = list_threads(&pool, &query(&accounts, None, 50))
            .await
            .unwrap();

        let dates: Vec<_> = page.threads.iter().map(|t| t.last_message_date).collect();
        assert_eq!(dates, vec![Some(300), Some(200), Some(100)]);
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn list_threads_same_thread_id_in_two_accounts() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t1", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1", "a2"]);
        let first = list_threads(&pool, &query(&accounts, None, 1))
            .await
            .unwrap();
        assert_eq!(first.threads.len(), 1);
        let cursor = first.next.clone().expect("full page has a cursor");
        let second = list_threads(&pool, &query(&accounts, Some(&cursor), 1))
            .await
            .unwrap();
        assert_eq!(second.threads.len(), 1);
        assert_eq!(second.next, None);

        let mut seen: Vec<_> = first
            .threads
            .iter()
            .chain(&second.threads)
            .map(|t| (t.account_id.clone(), t.id.clone()))
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![("a1".into(), "t1".into()), ("a2".into(), "t1".into())]
        );
    }

    #[tokio::test]
    async fn list_threads_keyset_pages_ties_without_gaps() {
        let pool = seeded_pool().await;
        for i in 0..25 {
            seed(&pool, "a1", &format!("t{i:02}"), Some(500), &["INBOX"]).await;
        }

        let accounts = labels(&["a1"]);
        let mut sizes = vec![];
        let mut all = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_threads(&pool, &query(&accounts, cursor.as_ref(), 10))
                .await
                .unwrap();
            sizes.push(page.threads.len());
            all.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(sizes, vec![10, 10, 5]);
        let mut unique = all.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 25);
        assert_eq!(all.len(), 25);
    }

    #[tokio::test]
    async fn list_threads_includes_undated_threads_last() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 2))
            .await
            .unwrap();

        let order: Vec<_> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(order, vec!["dated", "undated"]);
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn list_threads_cursor_for_undated_row_uses_zero_date() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated-a", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-b", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 2))
            .await
            .unwrap();

        assert_eq!(page.threads.len(), 2);
        assert_eq!(page.threads[0].id, "dated");
        assert_eq!(page.next.as_ref().map(|c| c.last_message_date), Some(0));
    }

    #[tokio::test]
    async fn list_threads_pages_through_undated_threads() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated-a", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-b", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-c", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let mut seen = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        let mut pages = 0;
        loop {
            let page = list_threads(&pool, &query(&accounts, cursor.as_ref(), 1))
                .await
                .unwrap();
            pages += 1;
            assert!(pages <= 4, "paging did not terminate");
            seen.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(seen, vec!["dated", "undated-c", "undated-b", "undated-a"]);
    }

    #[tokio::test]
    async fn list_threads_rejects_non_positive_limit() {
        let pool = seeded_pool().await;
        let accounts = labels(&["a1"]);

        let error = match list_threads(&pool, &query(&accounts, None, 0)).await {
            Ok(_) => panic!("zero limit should be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("limit must be positive"));
    }

    #[tokio::test]
    async fn list_threads_intersects_also_label() {
        let pool = seeded_pool().await;
        seed(
            &pool,
            "a1",
            "inbox",
            Some(200),
            &["INBOX", "CATEGORY_PRIMARY"],
        )
        .await;
        seed(&pool, "a1", "archived", Some(300), &["CATEGORY_PRIMARY"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(
            &pool,
            &ThreadQuery {
                account_ids: &accounts,
                label_id: "CATEGORY_PRIMARY",
                also_label_id: Some("INBOX"),
                before: None,
                limit: 50,
            },
        )
        .await
        .unwrap();

        let order: Vec<_> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(order, vec!["inbox"]);
    }

    #[tokio::test]
    async fn list_threads_respects_account_filter() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t2", Some(200), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 50))
            .await
            .unwrap();

        assert!(page.threads.iter().all(|t| t.account_id == "a1"));
        assert_eq!(page.threads.len(), 1);
    }

    async fn run_first_page(
        pool: &SqlitePool,
        prefix: &str,
        account_ids: &str,
    ) -> Vec<sqlx::sqlite::SqliteRow> {
        sqlx::query(&format!("{prefix}{FIRST_PAGE_SQL}"))
            .bind("INBOX")
            .bind(account_ids)
            .bind(None::<&str>)
            .bind(10_i64)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    async fn run_cursor_page(
        pool: &SqlitePool,
        prefix: &str,
        account_ids: &str,
    ) -> Vec<sqlx::sqlite::SqliteRow> {
        sqlx::query(&format!("{prefix}{CURSOR_PAGE_SQL}"))
            .bind("INBOX")
            .bind(account_ids)
            .bind(250_i64)
            .bind("zz")
            .bind("zz")
            .bind(None::<&str>)
            .bind(10_i64)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    fn column(rows: &[sqlx::sqlite::SqliteRow], name: &str) -> Vec<String> {
        rows.iter().map(|r| r.get::<String, _>(name)).collect()
    }

    #[tokio::test]
    async fn list_threads_uses_listing_index_without_sort() {
        // FIRST_PAGE_SQL and CURSOR_PAGE_SQL are copies of the queries in
        // list_threads (query_as! needs literals); the row checks below fail
        // if they drift apart.
        let production = include_str!("threads.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let production = normalize(production);
        for (name, sql) in [
            ("FIRST_PAGE_SQL", FIRST_PAGE_SQL),
            ("CURSOR_PAGE_SQL", CURSOR_PAGE_SQL),
        ] {
            assert!(
                production.contains(&normalize(sql)),
                "{name} drifted from the query in list_threads"
            );
        }

        let pool = seeded_pool().await;
        for (a, t, d) in [("a1", "t1", 300), ("a2", "t2", 200), ("a1", "t3", 100)] {
            seed(&pool, a, t, Some(d), &["INBOX"]).await;
        }
        let accounts = labels(&["a1", "a2"]);
        let account_json = serde_json::to_string(&accounts).unwrap();

        let first = list_threads(&pool, &query(&accounts, None, 10))
            .await
            .unwrap();
        let first_ids: Vec<_> = first.threads.iter().map(|t| t.id.clone()).collect();
        assert_eq!(
            column(&run_first_page(&pool, "", &account_json).await, "id!"),
            first_ids
        );

        let cursor = ThreadCursor {
            last_message_date: 250,
            account_id: "zz".into(),
            thread_id: "zz".into(),
        };
        let second = list_threads(&pool, &query(&accounts, Some(&cursor), 10))
            .await
            .unwrap();
        let second_ids: Vec<_> = second.threads.iter().map(|t| t.id.clone()).collect();
        assert_eq!(second_ids, vec!["t2", "t3"]);
        assert_eq!(
            column(&run_cursor_page(&pool, "", &account_json).await, "id!"),
            second_ids
        );

        let prefix = "EXPLAIN QUERY PLAN ";
        let first_plan = column(
            &run_first_page(&pool, prefix, &account_json).await,
            "detail",
        )
        .join("\n");
        let cursor_plan = column(
            &run_cursor_page(&pool, prefix, &account_json).await,
            "detail",
        )
        .join("\n");
        println!("first page plan:\n{first_plan}\ncursor page plan:\n{cursor_plan}");
        for plan in [&first_plan, &cursor_plan] {
            assert!(plan.contains("idx_thread_labels_listing"), "{plan}");
            assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        }
        assert!(
            cursor_plan.contains("(last_message_date,account_id,thread_id)<"),
            "{cursor_plan}"
        );
    }

    #[tokio::test]
    async fn list_threads_cursor_page_applies_label_account_and_also_filters() {
        let pool = seeded_pool().await;
        let rows: [(&str, &str, i64, &[&str]); 12] = [
            ("a1", "p1", 120, &["INBOX", "CATEGORY_PRIMARY"]),
            ("a2", "p2", 110, &["INBOX", "CATEGORY_PRIMARY"]),
            ("a1", "s1", 100, &["SENT"]),
            ("a1", "n1", 90, &["CATEGORY_PRIMARY"]),
            ("a2", "n2", 80, &["CATEGORY_PRIMARY"]),
            ("a1", "p3", 70, &["INBOX", "CATEGORY_PRIMARY"]),
            ("a1", "so1", 60, &["INBOX", "CATEGORY_SOCIAL"]),
            ("a2", "p4", 50, &["INBOX", "CATEGORY_PRIMARY"]),
            ("a1", "p5", 40, &["INBOX", "CATEGORY_PRIMARY"]),
            ("a2", "so2", 30, &["INBOX", "CATEGORY_SOCIAL"]),
            ("a1", "n3", 20, &["CATEGORY_PRIMARY"]),
            ("a1", "p6", 10, &["INBOX", "CATEGORY_PRIMARY"]),
        ];
        for (a, t, d, l) in rows {
            seed(&pool, a, t, Some(d), l).await;
        }

        let accounts = labels(&["a1"]);
        let q = |limit| ThreadQuery {
            account_ids: &accounts,
            label_id: "CATEGORY_PRIMARY",
            also_label_id: Some("INBOX"),
            before: None,
            limit,
        };
        let all = page_all(&pool, &q(100)).await;
        assert!(all.len() >= 3);
        assert_eq!(
            all,
            vec![
                pair("a1", "p1"),
                pair("a1", "p3"),
                pair("a1", "p5"),
                pair("a1", "p6")
            ]
        );
        assert_eq!(page_all(&pool, &q(1)).await, all);
    }

    #[tokio::test]
    async fn list_threads_also_label_is_per_account() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(250), &["CATEGORY_PRIMARY"]).await;
        seed(&pool, "a2", "t1", Some(150), &["INBOX"]).await;
        seed(&pool, "a1", "m3", Some(300), &["INBOX", "CATEGORY_PRIMARY"]).await;
        seed(&pool, "a1", "m2", Some(200), &["INBOX", "CATEGORY_PRIMARY"]).await;
        seed(&pool, "a1", "m1", Some(100), &["INBOX", "CATEGORY_PRIMARY"]).await;

        let accounts = labels(&["a1", "a2"]);
        let got = page_all(
            &pool,
            &ThreadQuery {
                account_ids: &accounts,
                label_id: "CATEGORY_PRIMARY",
                also_label_id: Some("INBOX"),
                before: None,
                limit: 1,
            },
        )
        .await;

        assert_eq!(
            got,
            vec![pair("a1", "m3"), pair("a1", "m2"), pair("a1", "m1")]
        );
    }

    #[tokio::test]
    async fn list_threads_ties_across_accounts_at_page_boundary() {
        let pool = seeded_pool().await;
        for a in ["a1", "a2"] {
            for i in 1..=5 {
                seed(&pool, a, &format!("t{i}"), Some(500), &["INBOX"]).await;
            }
        }

        let accounts = labels(&["a1", "a2"]);
        let got = page_all(&pool, &query(&accounts, None, 3)).await;

        let expected: Vec<_> = ["a2", "a1"]
            .into_iter()
            .flat_map(|a| (1..=5).rev().map(move |i| pair(a, &format!("t{i}"))))
            .collect();
        assert_eq!(got, expected);
    }

    #[tokio::test]
    async fn list_threads_exact_multiple_of_limit_has_no_empty_trailing_page() {
        let pool = seeded_pool().await;
        for i in 0..20 {
            seed(&pool, "a1", &format!("t{i:02}"), Some(i), &["INBOX"]).await;
        }

        let accounts = labels(&["a1"]);
        let first = list_threads(&pool, &query(&accounts, None, 10))
            .await
            .unwrap();
        let cursor = first.next.clone().expect("first page has a cursor");
        let second = list_threads(&pool, &query(&accounts, Some(&cursor), 10))
            .await
            .unwrap();

        assert_eq!([first.threads.len(), second.threads.len()], [10, 10]);
        assert_eq!(second.next, None);
    }

    #[tokio::test]
    async fn list_threads_reflects_relabel_and_redate() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(300), &["INBOX"]).await;
        seed(&pool, "a1", "t2", Some(200), &["INBOX"]).await;
        seed(&pool, "a1", "t3", Some(100), &["INBOX"]).await;
        let accounts = labels(&["a1"]);
        let ids = || async {
            list_threads(&pool, &query(&accounts, None, 10))
                .await
                .unwrap()
                .threads
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };

        update_thread_labels(&pool, "a1", "t1", &labels(&["SENT"]))
            .await
            .unwrap();
        assert_eq!(ids().await, vec!["t2", "t3"]);

        seed(&pool, "a1", "t3", Some(400), &["INBOX"]).await;
        assert_eq!(ids().await, vec!["t3", "t2"]);
    }

    #[tokio::test]
    async fn list_threads_empty_account_list_returns_empty_page() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(100), &["INBOX"]).await;

        let page = list_threads(&pool, &query(&[], None, 10)).await.unwrap();

        assert!(page.threads.is_empty());
        assert_eq!(page.next, None);
    }
}
