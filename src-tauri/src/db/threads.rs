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

/// [`upsert_thread`] inside the caller's transaction.
pub async fn upsert_thread_tx(
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

pub async fn delete_thread(pool: &SqlitePool, account_id: &str, thread_id: &str) -> Result<()> {
    sqlx::query!(
        "DELETE FROM threads WHERE account_id = ? AND id = ?",
        account_id,
        thread_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Replaces the thread's label set, keeping each row's `last_message_date`
/// in step with the thread. A no-op for a thread that doesn't exist.
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
    /// Drives the index, e.g. "INBOX" or "CATEGORY_SOCIAL".
    pub label_id: &'a str,
    /// Intersection, e.g. Social tab = INBOX + CATEGORY_SOCIAL.
    pub also_label_id: Option<&'a str>,
    /// Threads carrying any of these labels are skipped (Primary = INBOX minus the other
    /// categories). Empty = no filter.
    pub exclude_label_ids: &'a [String],
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
    let fetch_limit = q.limit.saturating_add(1);

    let account_ids = serde_json::to_string(q.account_ids)?;
    let exclude = serde_json::to_string(q.exclude_label_ids)?;

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
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?4)))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?5
        "#,
                q.label_id,
                account_ids,
                q.also_label_id,
                exclude,
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
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?7)))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?8
        "#,
                q.label_id,
                account_ids,
                c.last_message_date,
                c.account_id,
                c.thread_id,
                q.also_label_id,
                exclude,
                fetch_limit,
            )
            .fetch_all(pool)
            .await?
        }
    };
    Ok(page_from_rows(rows, q.limit as usize))
}

/// Every thread not labelled `SPAM` or `TRASH` (the All Mail view), newest first with the
/// same ordering and cursor as [`list_threads`]. Undated threads sort as date 0.
///
/// Served by the expression indexes `idx_threads_account_date` (one account, by account
/// equality) and `idx_threads_all_date` (several accounts, ordered across accounts), which
/// are on the same `COALESCE(last_message_date, 0)` the queries order and compare by: no
/// sort, and the cursor seeks. Each query names its index (`INDEXED BY`): without
/// `ANALYZE` statistics the planner would otherwise pick the per-account index and sort for
/// the multi-account pages. The scalar `<= date` bound repeats the first term of the
/// tuple comparison because SQLite only seeks on the scalar form.
pub async fn list_all_mail(
    pool: &SqlitePool,
    account_ids: &[String],
    before: Option<&ThreadCursor>,
    limit: i64,
) -> Result<ThreadPage> {
    if limit <= 0 {
        anyhow::bail!("thread list limit must be positive");
    }
    if account_ids.is_empty() {
        // `IN ()` would walk the whole global index to find nothing.
        return Ok(ThreadPage {
            threads: Vec::new(),
            next: None,
        });
    }
    let fetch_limit = limit.saturating_add(1);

    let rows = if let [one] = account_ids {
        match before {
            None => {
                sqlx::query_as!(
                    ThreadRow,
                    r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               COALESCE(t.last_message_date, 0) AS "cursor_date!: i64"
        FROM threads t INDEXED BY idx_threads_account_date
        WHERE t.account_id = ?1
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = t.account_id AND e.thread_id = t.id
                  AND e.label_id IN ('SPAM', 'TRASH'))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?2
        "#,
                    one,
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
               COALESCE(t.last_message_date, 0) AS "cursor_date!: i64"
        FROM threads t INDEXED BY idx_threads_account_date
        WHERE t.account_id = ?1
          AND COALESCE(t.last_message_date, 0) <= ?2
          AND (COALESCE(t.last_message_date, 0), t.account_id, t.id) < (?2, ?3, ?4)
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = t.account_id AND e.thread_id = t.id
                  AND e.label_id IN ('SPAM', 'TRASH'))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?5
        "#,
                    one,
                    c.last_message_date,
                    c.account_id,
                    c.thread_id,
                    fetch_limit,
                )
                .fetch_all(pool)
                .await?
            }
        }
    } else {
        let accounts = serde_json::to_string(account_ids)?;
        match before {
            None => {
                sqlx::query_as!(
                    ThreadRow,
                    r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               COALESCE(t.last_message_date, 0) AS "cursor_date!: i64"
        FROM threads t INDEXED BY idx_threads_all_date
        WHERE t.account_id IN (SELECT value FROM json_each(?1))
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = t.account_id AND e.thread_id = t.id
                  AND e.label_id IN ('SPAM', 'TRASH'))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?2
        "#,
                    accounts,
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
               COALESCE(t.last_message_date, 0) AS "cursor_date!: i64"
        FROM threads t INDEXED BY idx_threads_all_date
        WHERE t.account_id IN (SELECT value FROM json_each(?1))
          AND COALESCE(t.last_message_date, 0) <= ?2
          AND (COALESCE(t.last_message_date, 0), t.account_id, t.id) < (?2, ?3, ?4)
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = t.account_id AND e.thread_id = t.id
                  AND e.label_id IN ('SPAM', 'TRASH'))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?5
        "#,
                    accounts,
                    c.last_message_date,
                    c.account_id,
                    c.thread_id,
                    fetch_limit,
                )
                .fetch_all(pool)
                .await?
            }
        }
    };
    Ok(page_from_rows(rows, limit as usize))
}

/// Trims the extra look-ahead row off `rows` and turns it into the next cursor.
fn page_from_rows(mut rows: Vec<ThreadRow>, page_limit: usize) -> ThreadPage {
    let has_more = rows.len() > page_limit;
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
    ThreadPage { threads, next }
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

    pub fn merge(&mut self, other: RecomputeResult) {
        self.created.extend(other.created);
        self.updated.extend(other.updated);
        self.removed.extend(other.removed);
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

/// Unread thread counts across `account_ids` for `INBOX` and each inbox category tab.
/// A category is `INBOX ∩ CATEGORY_x`; `CATEGORY_PERSONAL` (Primary) is the unread inbox
/// minus the other four categories, so an account without category labels still has its
/// whole inbox under Primary. Labels with no unread threads are omitted.
pub async fn unread_counts(
    pool: &SqlitePool,
    account_ids: &[String],
) -> Result<Vec<(String, i64)>> {
    let accounts = serde_json::to_string(account_ids)?;
    let rows = sqlx::query!(
        r#"
        SELECT label_id AS "label_id!", COUNT(*) AS "count!: i64"
        FROM (
            SELECT x.label_id AS label_id
            FROM thread_labels i
            JOIN thread_labels u
              ON u.account_id = i.account_id AND u.thread_id = i.thread_id AND u.label_id = 'UNREAD'
            JOIN thread_labels x
              ON x.account_id = i.account_id AND x.thread_id = i.thread_id
             AND x.label_id IN ('INBOX', 'CATEGORY_SOCIAL',
                                'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')
            WHERE i.label_id = 'INBOX' AND i.account_id IN (SELECT value FROM json_each(?1))
            UNION ALL
            SELECT 'CATEGORY_PERSONAL' AS label_id
            FROM thread_labels i
            JOIN thread_labels u
              ON u.account_id = i.account_id AND u.thread_id = i.thread_id AND u.label_id = 'UNREAD'
            WHERE i.label_id = 'INBOX' AND i.account_id IN (SELECT value FROM json_each(?1))
              AND NOT EXISTS (
                    SELECT 1 FROM thread_labels c
                    WHERE c.account_id = i.account_id AND c.thread_id = i.thread_id
                      AND c.label_id IN ('CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
                                         'CATEGORY_UPDATES', 'CATEGORY_FORUMS'))
        )
        GROUP BY label_id
        ORDER BY label_id
        "#,
        accounts
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| (r.label_id, r.count)).collect())
}

/// Unread and total thread counts for one label of one account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelCount {
    pub label_id: String,
    pub unread: i64,
    pub total: i64,
}

/// Thread counts per label id for one account, counted from the cached threads (not
/// Gmail's own counters) in a single pass over the account's `thread_labels`. Labels with
/// no threads are omitted; labels with no unread threads report `unread: 0`.
pub async fn label_counts(pool: &SqlitePool, account_id: &str) -> Result<Vec<LabelCount>> {
    let rows = sqlx::query!(
        r#"
        SELECT tl.label_id AS "label_id!",
               COUNT(*) AS "total!: i64",
               COUNT(u.label_id) AS "unread!: i64"
        FROM thread_labels tl
        LEFT JOIN thread_labels u
          ON u.account_id = tl.account_id AND u.thread_id = tl.thread_id AND u.label_id = 'UNREAD'
        WHERE tl.account_id = ?
        GROUP BY tl.label_id
        ORDER BY tl.label_id
        "#,
        account_id
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| LabelCount {
            label_id: r.label_id,
            unread: r.unread,
            total: r.total,
        })
        .collect())
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
            exclude_label_ids: &[],
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
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?4)))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?5
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
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?7)))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?8
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
                exclude_label_ids: &[],
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
            .bind("[]")
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
            .bind("[]")
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
            .split("#[cfg(test)]")
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
            exclude_label_ids: &[],
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
                exclude_label_ids: &[],
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

    const OTHERS: [&str; 4] = [
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
    ];

    /// Pages through INBOX with `exclude`, returning the thread ids.
    async fn inbox_excluding(pool: &SqlitePool, exclude: &[String], limit: i64) -> Vec<String> {
        let accounts = labels(&["a1"]);
        let mut out = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_threads(
                pool,
                &ThreadQuery {
                    account_ids: &accounts,
                    label_id: "INBOX",
                    also_label_id: None,
                    exclude_label_ids: exclude,
                    before: cursor.as_ref(),
                    limit,
                },
            )
            .await
            .unwrap();
            out.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => return out,
            }
        }
    }

    #[tokio::test]
    async fn primary_excludes_other_categories() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "plain", Some(300), &["INBOX"]).await;
        seed(
            &pool,
            "a1",
            "personal",
            Some(200),
            &["INBOX", "CATEGORY_PERSONAL"],
        )
        .await;
        seed(
            &pool,
            "a1",
            "social",
            Some(100),
            &["INBOX", "CATEGORY_SOCIAL"],
        )
        .await;

        let exclude = labels(&OTHERS);
        assert_eq!(
            inbox_excluding(&pool, &exclude, 50).await,
            vec!["plain", "personal"]
        );
        // One row per page exercises the cursor variant of the query.
        assert_eq!(
            inbox_excluding(&pool, &exclude, 1).await,
            vec!["plain", "personal"]
        );
        assert_eq!(
            inbox_excluding(&pool, &[], 50).await,
            vec!["plain", "personal", "social"]
        );
    }

    #[tokio::test]
    async fn primary_count_matches_inbox_without_categories() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(200), &["INBOX", "UNREAD"]).await;
        seed(&pool, "a1", "t2", Some(100), &["INBOX", "UNREAD"]).await;
        seed(&pool, "a1", "t3", Some(50), &["INBOX"]).await;
        seed(
            &pool,
            "a1",
            "t4",
            Some(40),
            &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        )
        .await;

        let counts = unread_counts(&pool, &labels(&["a1"])).await.unwrap();
        let count = |id: &str| counts.iter().find(|(l, _)| l == id).map(|(_, n)| *n);
        assert_eq!(count("CATEGORY_PERSONAL"), Some(2));
        assert_eq!(count("INBOX"), Some(3));
        assert_eq!(count("CATEGORY_PROMOTIONS"), Some(1));

        // Without any category labels Primary is the whole inbox.
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(200), &["INBOX", "UNREAD"]).await;
        seed(&pool, "a1", "t2", Some(100), &["INBOX", "UNREAD"]).await;
        let counts = unread_counts(&pool, &labels(&["a1"])).await.unwrap();
        assert_eq!(
            counts,
            vec![("CATEGORY_PERSONAL".to_owned(), 2), ("INBOX".to_owned(), 2)]
        );
    }

    #[tokio::test]
    async fn all_mail_skips_spam_and_trash_and_pages() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(500), &["INBOX"]).await;
        seed(&pool, "a2", "t2", Some(400), &["CATEGORY_PROMOTIONS"]).await;
        seed(&pool, "a1", "spam", Some(450), &["SPAM"]).await;
        seed(&pool, "a2", "trash", Some(350), &["TRASH"]).await;
        seed(&pool, "a1", "t3", Some(300), &[]).await;
        seed(&pool, "a1", "t4", Some(200), &["SENT"]).await;

        let accounts = labels(&["a1", "a2"]);
        let first = list_all_mail(&pool, &accounts, None, 2).await.unwrap();
        let ids = |p: &ThreadPage| -> Vec<(String, String)> {
            p.threads
                .iter()
                .map(|t| (t.account_id.clone(), t.id.clone()))
                .collect()
        };
        assert_eq!(ids(&first), vec![pair("a1", "t1"), pair("a2", "t2")]);
        let cursor = first.next.clone().expect("more rows");
        let second = list_all_mail(&pool, &accounts, Some(&cursor), 2)
            .await
            .unwrap();
        assert_eq!(ids(&second), vec![pair("a1", "t3"), pair("a1", "t4")]);
        assert_eq!(second.next, None);

        // One account only.
        let only = list_all_mail(&pool, &labels(&["a2"]), None, 10)
            .await
            .unwrap();
        assert_eq!(ids(&only), vec![pair("a2", "t2")]);

        assert!(list_all_mail(&pool, &accounts, None, 0).await.is_err());
    }

    #[tokio::test]
    async fn all_mail_cursor_is_stable_across_accounts_and_ties() {
        let pool = seeded_pool().await;
        for a in ["a1", "a2"] {
            for i in 1..=3 {
                seed(&pool, a, &format!("t{i}"), Some(500), &["INBOX"]).await;
            }
        }
        seed(&pool, "a1", "undated", None, &[]).await;

        let accounts = labels(&["a1", "a2"]);
        let mut got = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_all_mail(&pool, &accounts, cursor.as_ref(), 2)
                .await
                .unwrap();
            got.extend(page.threads.into_iter().map(|t| (t.account_id, t.id)));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(
            got,
            vec![
                pair("a2", "t3"),
                pair("a2", "t2"),
                pair("a2", "t1"),
                pair("a1", "t3"),
                pair("a1", "t2"),
                pair("a1", "t1"),
                pair("a1", "undated"),
            ]
        );
    }

    #[tokio::test]
    async fn label_counts_per_label() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(300), &["Label_1", "UNREAD"]).await;
        seed(&pool, "a1", "t2", Some(200), &["Label_1"]).await;
        seed(
            &pool,
            "a1",
            "t3",
            Some(100),
            &["INBOX", "STARRED", "UNREAD"],
        )
        .await;
        seed(&pool, "a1", "t4", Some(90), &["STARRED"]).await;
        // Another account's mail doesn't leak in.
        seed(
            &pool,
            "a2",
            "t5",
            Some(100),
            &["Label_1", "STARRED", "UNREAD"],
        )
        .await;

        let counts = label_counts(&pool, "a1").await.unwrap();
        let count = |id: &str| {
            counts
                .iter()
                .find(|c| c.label_id == id)
                .map(|c| (c.unread, c.total))
        };
        assert_eq!(count("Label_1"), Some((1, 2)));
        assert_eq!(count("STARRED"), Some((1, 2)));
        assert_eq!(count("INBOX"), Some((1, 1)));
        assert_eq!(count("Label_2"), None);
    }

    #[tokio::test]
    async fn all_mail_single_account_pages_and_empty_account_list() {
        let pool = seeded_pool().await;
        for i in 1..=3 {
            seed(&pool, "a1", &format!("t{i}"), Some(500), &["INBOX"]).await;
        }
        seed(&pool, "a1", "undated", None, &[]).await;
        seed(&pool, "a1", "old", Some(10), &["SENT"]).await;
        seed(&pool, "a2", "other", Some(900), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let mut got = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_all_mail(&pool, &accounts, cursor.as_ref(), 2)
                .await
                .unwrap();
            got.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(got, vec!["t3", "t2", "t1", "old", "undated"]);

        let none = list_all_mail(&pool, &[], None, 10).await.unwrap();
        assert!(none.threads.is_empty() && none.next.is_none());
    }

    /// The four SQL texts of `list_all_mail` (single/multi account x first/cursor page),
    /// read from this file so the plan test runs exactly what production runs.
    fn all_mail_sql() -> Vec<String> {
        let production = include_str!("threads.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        let start = production.find("pub async fn list_all_mail").unwrap();
        let end = production.find("fn page_from_rows").unwrap();
        let sqls: Vec<String> = production[start..end]
            .split("r#\"")
            .skip(1)
            .map(|chunk| chunk.split("\"#").next().unwrap().to_owned())
            .collect();
        assert_eq!(sqls.len(), 4, "expected four All Mail queries");
        sqls
    }

    #[tokio::test]
    async fn all_mail_pages_use_expression_indexes_without_sort() {
        let pool = seeded_pool().await;
        for (a, t, d) in [("a1", "t1", 300), ("a2", "t2", 200), ("a1", "t3", 100)] {
            seed(&pool, a, t, Some(d), &["INBOX"]).await;
        }
        let both = serde_json::to_string(&labels(&["a1", "a2"])).unwrap();
        let sqls = all_mail_sql();

        // (name, sql, expected index, binds), in the order the queries appear.
        enum B<'a> {
            S(&'a str),
            I(i64),
        }
        use B::{I, S};
        let cases: [(&str, &str, &str, Vec<B>); 4] = [
            (
                "single first",
                &sqls[0],
                "idx_threads_account_date",
                vec![S("a1"), I(10)],
            ),
            (
                "single cursor",
                &sqls[1],
                "idx_threads_account_date",
                vec![S("a1"), I(250), S("zz"), S("zz"), I(10)],
            ),
            (
                "multi first",
                &sqls[2],
                "idx_threads_all_date",
                vec![S(&both), I(10)],
            ),
            (
                "multi cursor",
                &sqls[3],
                "idx_threads_all_date",
                vec![S(&both), I(250), S("zz"), S("zz"), I(10)],
            ),
        ];
        for (name, sql, index, binds) in cases {
            let mut query = sqlx::query(Box::leak(
                format!("EXPLAIN QUERY PLAN {sql}").into_boxed_str(),
            ));
            for b in &binds {
                query = match b {
                    S(v) => query.bind(*v),
                    I(v) => query.bind(*v),
                };
            }
            let rows = query.fetch_all(&pool).await.unwrap();
            let plan = column(&rows, "detail").join("\n");
            println!("{name} plan:\n{plan}");
            assert!(plan.contains(index), "{name} should use {index}:\n{plan}");
            assert!(!plan.contains("TEMP B-TREE"), "{name} sorts:\n{plan}");
            if name.ends_with("cursor") {
                assert!(
                    plan.contains("<expr><?"),
                    "{name} should seek at the cursor:\n{plan}"
                );
            }
        }
    }
}
