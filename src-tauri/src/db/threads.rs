use crate::db::messages::{self, DbMessage};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeSet, HashMap};

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

/// Threads in the inbox with at least one cached message from `sender` (compared lowercased).
pub async fn inbox_threads_from(
    pool: &SqlitePool,
    account_id: &str,
    sender: &str,
) -> Result<Vec<String>> {
    let ids = sqlx::query_scalar!(
        r#"SELECT DISTINCT tl.thread_id AS "thread_id!" FROM thread_labels tl
           JOIN messages m ON m.thread_id = tl.thread_id AND m.account_id = tl.account_id
           WHERE tl.label_id = 'INBOX' AND tl.account_id = ?1
             AND lower(m.from_address) = lower(?2)"#,
        account_id,
        sender
    )
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// System label ids (INBOX, CATEGORY_*, SPAM, TRASH, SENT…) of many threads in one query,
/// keyed by `(account_id, thread_id)` and sorted ascending. Threads without any are absent.
/// Seeks the primary key of `thread_labels` per thread.
pub async fn system_label_ids_for(
    pool: &SqlitePool,
    keys: &[(String, String)],
) -> Result<HashMap<(String, String), Vec<String>>> {
    let mut out: HashMap<(String, String), Vec<String>> = HashMap::new();
    if keys.is_empty() {
        return Ok(out);
    }
    let keys = serde_json::to_string(keys)?;
    // One row holding a JSON array, like `labels::user_label_ids_for`: sqlx copies every
    // value of every row it returns.
    let found = sqlx::query_scalar!(
        r#"SELECT json_group_array(json_array(tl.account_id, tl.thread_id, tl.label_id))
                  AS "found!: String"
           FROM json_each(?1) k
           JOIN thread_labels tl
             ON tl.account_id = json_extract(k.value, '$[0]')
            AND tl.thread_id = json_extract(k.value, '$[1]')
           WHERE NOT EXISTS (
                 SELECT 1 FROM labels l
                 WHERE l.account_id = tl.account_id AND l.id = tl.label_id
                   AND l.type = 'user')"#,
        keys
    )
    .fetch_one(pool)
    .await?;
    let found: Vec<(String, String, String)> = serde_json::from_str(&found)?;
    for (account_id, thread_id, label_id) in found {
        out.entry((account_id, thread_id))
            .or_default()
            .push(label_id);
    }
    for ids in out.values_mut() {
        ids.sort();
    }
    Ok(out)
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
    /// None lists all rows; Some lists unread rows plus these account/thread pairs.
    pub read_filter: Option<&'a [(String, String)]>,
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
    if let Some(keep) = q.read_filter {
        // An unread thread outside Spam and Trash carries `UNREAD` (see `label_counts`); one
        // wholly in Spam or Trash carries only those, so those two keep the label walk.
        if !matches!(q.label_id, "SPAM" | "TRASH") {
            return list_unread(pool, q, keep).await;
        }
    }
    let fetch_limit = q.limit.saturating_add(1);

    let read_filter = q.read_filter.map(serde_json::to_string).transpose()?;
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
          AND (?6 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?6)))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?5
        "#,
                q.label_id,
                account_ids,
                q.also_label_id,
                exclude,
                fetch_limit,
                read_filter,
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
          AND (?9 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?9)))
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
                read_filter,
            )
            .fetch_all(pool)
            .await?
        }
    };
    Ok(page_from_rows(rows, q.limit as usize))
}

/// [`list_threads`] with "Unread only" on: walks the account's `UNREAD` rows, newest first,
/// instead of every row of the label. A tab with a few unread threads among a hundred
/// thousand (Updates, while Promotions holds the unread mail) then reads the unread rows, not
/// the whole Inbox. The second arm adds the threads read during this visit (`keep`), which
/// no longer carry `UNREAD`, and skips those the first arm returns. Both arms come out in the
/// listing order, so SQLite merges them and stops at the limit. A thread's label rows
/// all carry its date, so `u`'s date, account and id order and page it like `tl`'s.
async fn list_unread(
    pool: &SqlitePool,
    q: &ThreadQuery<'_>,
    keep: &[(String, String)],
) -> Result<ThreadPage> {
    let fetch_limit = q.limit.saturating_add(1);
    let keep = serde_json::to_string(keep)?;
    let account_ids = serde_json::to_string(q.account_ids)?;
    let exclude = serde_json::to_string(q.exclude_label_ids)?;

    let rows = match q.before {
        None => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT u.thread_id AS "id!", u.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               u.last_message_date AS "cursor_date!"
        FROM thread_labels u INDEXED BY idx_thread_labels_listing
        CROSS JOIN thread_labels tl
            ON tl.account_id = u.account_id AND tl.thread_id = u.thread_id AND tl.label_id = ?1
        CROSS JOIN threads t ON t.account_id = u.account_id AND t.id = u.thread_id
        WHERE u.label_id = 'UNREAD'
          AND u.account_id IN (SELECT value FROM json_each(?2))
          AND t.unread_count > 0
          AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = u.account_id AND x.thread_id = u.thread_id
                  AND x.label_id = ?3))
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = u.account_id AND e.thread_id = u.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?4)))
        UNION ALL
        SELECT tl.thread_id, tl.account_id, t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count,
               t.unread_count, t.has_attachment,
               t.from_name, t.from_address, t.is_starred,
               tl.last_message_date
        FROM json_each(?6) k
        CROSS JOIN thread_labels tl
            ON tl.account_id = k.value ->> 0 AND tl.thread_id = k.value ->> 1
           AND tl.label_id = ?1
        CROSS JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.account_id IN (SELECT value FROM json_each(?2))
          AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?3))
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?4)))
          AND NOT (t.unread_count > 0 AND EXISTS (
                SELECT 1 FROM thread_labels r
                WHERE r.account_id = tl.account_id AND r.thread_id = tl.thread_id
                  AND r.label_id = 'UNREAD'))
        ORDER BY 13 DESC, 2 DESC, 1 DESC
        LIMIT ?5
        "#,
                q.label_id,
                account_ids,
                q.also_label_id,
                exclude,
                fetch_limit,
                keep,
            )
            .fetch_all(pool)
            .await?
        }
        Some(c) => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT u.thread_id AS "id!", u.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               u.last_message_date AS "cursor_date!"
        FROM thread_labels u INDEXED BY idx_thread_labels_listing
        CROSS JOIN thread_labels tl
            ON tl.account_id = u.account_id AND tl.thread_id = u.thread_id AND tl.label_id = ?1
        CROSS JOIN threads t ON t.account_id = u.account_id AND t.id = u.thread_id
        WHERE u.label_id = 'UNREAD'
          AND u.account_id IN (SELECT value FROM json_each(?2))
          AND (u.last_message_date, u.account_id, u.thread_id) < (?3, ?4, ?5)
          AND t.unread_count > 0
          AND (?6 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = u.account_id AND x.thread_id = u.thread_id
                  AND x.label_id = ?6))
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = u.account_id AND e.thread_id = u.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?7)))
        UNION ALL
        SELECT tl.thread_id, tl.account_id, t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count,
               t.unread_count, t.has_attachment,
               t.from_name, t.from_address, t.is_starred,
               tl.last_message_date
        FROM json_each(?9) k
        CROSS JOIN thread_labels tl
            ON tl.account_id = k.value ->> 0 AND tl.thread_id = k.value ->> 1
           AND tl.label_id = ?1
        CROSS JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.account_id IN (SELECT value FROM json_each(?2))
          AND (tl.last_message_date, tl.account_id, tl.thread_id) < (?3, ?4, ?5)
          AND (?6 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?6))
          AND NOT EXISTS (
                SELECT 1 FROM thread_labels e
                WHERE e.account_id = tl.account_id AND e.thread_id = tl.thread_id
                  AND e.label_id IN (SELECT value FROM json_each(?7)))
          AND NOT (t.unread_count > 0 AND EXISTS (
                SELECT 1 FROM thread_labels r
                WHERE r.account_id = tl.account_id AND r.thread_id = tl.thread_id
                  AND r.label_id = 'UNREAD'))
        ORDER BY 13 DESC, 2 DESC, 1 DESC
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
                keep,
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
    read_filter: Option<&[(String, String)]>,
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
    let read_filter = read_filter.map(serde_json::to_string).transpose()?;

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
          AND (?3 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?3)))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?2
        "#,
                    one,
                    fetch_limit,
                    read_filter,
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
          AND (?6 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?6)))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?5
        "#,
                    one,
                    c.last_message_date,
                    c.account_id,
                    c.thread_id,
                    fetch_limit,
                    read_filter,
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
          AND (?3 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?3)))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?2
        "#,
                    accounts,
                    fetch_limit,
                    read_filter,
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
          AND (?6 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?6)))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?5
        "#,
                    accounts,
                    c.last_message_date,
                    c.account_id,
                    c.thread_id,
                    fetch_limit,
                    read_filter,
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
/// minus the account's `excludes` (the categories whose tabs it shows; an account missing
/// from the map excludes nothing), so an account without category labels still has its
/// whole inbox under Primary. Labels with no unread threads are omitted.
///
/// Walks the `UNREAD` rows of `idx_thread_labels_listing`, not the inbox: a large inbox is
/// mostly read, and these counts rerun on every sync event. `CROSS JOIN` keeps that order
/// (SQLite has no statistics to choose it).
pub async fn unread_counts(
    pool: &SqlitePool,
    account_ids: &[String],
    excludes: &HashMap<String, Vec<String>>,
) -> Result<Vec<(String, i64)>> {
    let accounts = serde_json::to_string(account_ids)?;
    // `[account_id, label_id]` pairs, parsed once into `ex` and matched per account in the
    // Primary branch.
    let pairs: Vec<(&str, &str)> = account_ids
        .iter()
        .filter_map(|a| excludes.get(a).map(|labels| (a, labels)))
        .flat_map(|(a, labels)| labels.iter().map(move |l| (a.as_str(), l.as_str())))
        .collect();
    let excluded = serde_json::to_string(&pairs)?;
    let rows = sqlx::query!(
        r#"
        WITH ex(account_id, label_id) AS MATERIALIZED (
            SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)
        )
        SELECT label_id AS "label_id!", COUNT(*) AS "count!: i64"
        FROM (
            SELECT x.label_id AS label_id
            FROM thread_labels u INDEXED BY idx_thread_labels_listing
            CROSS JOIN thread_labels i
              ON i.account_id = u.account_id AND i.thread_id = u.thread_id AND i.label_id = 'INBOX'
            CROSS JOIN thread_labels x
              ON x.account_id = u.account_id AND x.thread_id = u.thread_id
             AND x.label_id IN ('INBOX', 'CATEGORY_SOCIAL',
                                'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')
            WHERE u.label_id = 'UNREAD' AND u.account_id IN (SELECT value FROM json_each(?1))
            UNION ALL
            SELECT 'CATEGORY_PERSONAL' AS label_id
            FROM thread_labels u INDEXED BY idx_thread_labels_listing
            CROSS JOIN thread_labels i
              ON i.account_id = u.account_id AND i.thread_id = u.thread_id AND i.label_id = 'INBOX'
            WHERE u.label_id = 'UNREAD' AND u.account_id IN (SELECT value FROM json_each(?1))
              AND NOT EXISTS (
                    SELECT 1 FROM ex CROSS JOIN thread_labels c
                      ON c.account_id = u.account_id AND c.thread_id = u.thread_id
                     AND c.label_id = ex.label_id
                    WHERE ex.account_id = u.account_id)
        )
        GROUP BY label_id
        ORDER BY label_id
        "#,
        accounts,
        excluded
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

/// The count row for All Mail (every thread outside Spam and Trash), beside the labels.
pub const ALL_MAIL: &str = "ALL";

/// Thread counts per label id for one account, counted from the cached threads (not
/// Gmail's own counters), plus an [`ALL_MAIL`] row. A thread counts as unread exactly when
/// the lists show it unread (`unread_count > 0`), so Spam and Trash count their unread
/// threads although a wholly spammed or trashed thread has no `UNREAD` label. Labels with
/// no threads (and All Mail when empty) are omitted; no unread threads is `unread: 0`.
///
/// These rerun on every sync event, so the unread side only visits candidate threads:
/// `is_read` mirrors each message's `UNREAD` label, so an unread thread carries `UNREAD`
/// unless all its messages are spammed or trashed, and then it carries `SPAM` or `TRASH`.
pub async fn label_counts(pool: &SqlitePool, account_id: &str) -> Result<Vec<LabelCount>> {
    // One snapshot for all three queries, so a sync landing between them can't skew them.
    let mut tx = pool.begin().await?;
    let totals = sqlx::query!(
        r#"
        SELECT label_id AS "label_id!", COUNT(*) AS "total!: i64"
        FROM thread_labels
        WHERE account_id = ?
        GROUP BY label_id
        ORDER BY label_id
        "#,
        account_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let unread: HashMap<String, i64> = sqlx::query!(
        r#"
        SELECT x.label_id AS "label_id!", COUNT(*) AS "unread!: i64"
        FROM (
            SELECT DISTINCT c.thread_id AS thread_id
            FROM thread_labels c INDEXED BY idx_thread_labels_listing
            WHERE c.label_id IN ('UNREAD', 'SPAM', 'TRASH') AND c.account_id = ?1
        ) u
        CROSS JOIN threads t ON t.account_id = ?1 AND t.id = u.thread_id
        CROSS JOIN thread_labels x ON x.account_id = ?1 AND x.thread_id = u.thread_id
        WHERE t.unread_count > 0
        GROUP BY x.label_id
        "#,
        account_id
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|r| (r.label_id, r.unread))
    .collect();
    // The same predicate as `list_all_mail`: every thread minus those in Spam or Trash. Its
    // unread threads aren't spammed or trashed, so all of them carry `UNREAD`.
    let all = sqlx::query!(
        r#"
        SELECT
            (SELECT COUNT(*) FROM threads WHERE account_id = ?1)
            - (SELECT COUNT(DISTINCT thread_id)
               FROM thread_labels INDEXED BY idx_thread_labels_listing
               WHERE label_id IN ('SPAM', 'TRASH') AND account_id = ?1) AS "total!: i64",
            (SELECT COUNT(*)
             FROM thread_labels u INDEXED BY idx_thread_labels_listing
             CROSS JOIN threads t ON t.account_id = u.account_id AND t.id = u.thread_id
             WHERE u.label_id = 'UNREAD' AND u.account_id = ?1 AND t.unread_count > 0
               AND NOT EXISTS (
                    SELECT 1 FROM thread_labels e
                    WHERE e.account_id = u.account_id AND e.thread_id = u.thread_id
                      AND e.label_id IN ('SPAM', 'TRASH'))) AS "unread!: i64"
        "#,
        account_id
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut counts: Vec<LabelCount> = totals
        .into_iter()
        .map(|r| LabelCount {
            unread: unread.get(&r.label_id).copied().unwrap_or(0),
            label_id: r.label_id,
            total: r.total,
        })
        .collect();
    if all.total > 0 {
        counts.push(LabelCount {
            label_id: ALL_MAIL.to_owned(),
            unread: all.unread,
            total: all.total,
        });
    }
    Ok(counts)
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

    /// Every tab shown: Primary excludes all four other categories in each account.
    fn every_tab(ids: &[String]) -> HashMap<String, Vec<String>> {
        ids.iter().map(|a| (a.clone(), labels(&OTHERS))).collect()
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

    /// A thread under `l`; it has an unread message when `l` has `UNREAD` (as derived).
    async fn seed(pool: &SqlitePool, account_id: &str, id: &str, date: Option<i64>, l: &[&str]) {
        let mut t = thread(account_id, id, date);
        t.unread_count = l.contains(&"UNREAD").into();
        upsert_thread(pool, &t, &labels(l)).await.unwrap();
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
            read_filter: None,
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
          AND (?6 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?6)))
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
          AND (?9 IS NULL OR t.unread_count > 0 OR
               json_array(t.account_id, t.id) IN (SELECT value FROM json_each(?9)))
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
    async fn unread_filter_pages_labels_categories_and_account_scoped_retained_rows() {
        let pool = seeded_pool().await;
        for (a, id, date, labs) in [
            (
                "a1",
                "read",
                600,
                vec!["INBOX", "Label_nested", "CATEGORY_SOCIAL"],
            ),
            (
                "a2",
                "read",
                550,
                vec!["INBOX", "Label_nested", "CATEGORY_SOCIAL"],
            ),
            (
                "a1",
                "social",
                500,
                vec!["INBOX", "Label_nested", "CATEGORY_SOCIAL", "UNREAD"],
            ),
            (
                "a2",
                "social",
                400,
                vec!["INBOX", "Label_nested", "CATEGORY_SOCIAL", "UNREAD"],
            ),
            (
                "a1",
                "primary",
                300,
                vec!["INBOX", "Label_nested", "UNREAD"],
            ),
            ("a1", "archived", 200, vec!["Label_nested", "UNREAD"]),
            ("a1", "trash", 100, vec!["TRASH", "UNREAD"]),
        ] {
            seed(&pool, a, id, Some(date), &labs).await;
        }
        let accounts = labels(&["a1", "a2"]);
        let q = ThreadQuery {
            read_filter: Some(&[]),
            ..query(&accounts, None, 1)
        };
        assert_eq!(
            page_all(&pool, &q).await,
            vec![
                pair("a1", "social"),
                pair("a2", "social"),
                pair("a1", "primary")
            ]
        );
        let label = ThreadQuery {
            label_id: "Label_nested",
            ..q
        };
        assert_eq!(page_all(&pool, &label).await.len(), 4);
        let social = ThreadQuery {
            also_label_id: Some("CATEGORY_SOCIAL"),
            ..q
        };
        assert_eq!(
            page_all(&pool, &social).await,
            vec![pair("a1", "social"), pair("a2", "social")]
        );
        let exclude = labels(&["CATEGORY_SOCIAL"]);
        let primary = ThreadQuery {
            exclude_label_ids: &exclude,
            ..q
        };
        assert_eq!(page_all(&pool, &primary).await, vec![pair("a1", "primary")]);
        let keep = vec![pair("a1", "read"), pair("a1", "archived")];
        let retained = ThreadQuery {
            read_filter: Some(&keep),
            ..social
        };
        assert_eq!(
            page_all(&pool, &retained).await,
            vec![
                pair("a1", "read"),
                pair("a1", "social"),
                pair("a2", "social")
            ]
        );
        // Retention never overrides mailbox membership, including a remote archive.
        update_thread_labels(&pool, "a1", "read", &labels(&["Label_nested"]))
            .await
            .unwrap();
        assert_eq!(
            page_all(&pool, &retained).await,
            vec![pair("a1", "social"), pair("a2", "social")]
        );
    }

    #[tokio::test]
    async fn all_mail_unread_filter_applies_to_single_and_multi_account_cursor_pages() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "read", Some(600), &["INBOX"]).await;
        seed(&pool, "a2", "read", Some(550), &["INBOX"]).await;
        seed(&pool, "a1", "u1", Some(500), &["INBOX", "UNREAD"]).await;
        seed(&pool, "a1", "u2", Some(400), &["UNREAD"]).await;
        seed(&pool, "a2", "u3", Some(300), &["UNREAD"]).await;
        seed(&pool, "a1", "trash", Some(200), &["TRASH", "UNREAD"]).await;
        for accounts in [labels(&["a1"]), labels(&["a1", "a2"])] {
            let keep = [pair("a1", "read")];
            for retained in [&[][..], &keep[..]] {
                let mut cursor = None;
                let mut found = vec![];
                loop {
                    let page = list_all_mail(&pool, &accounts, cursor.as_ref(), 1, Some(retained))
                        .await
                        .unwrap();
                    found.extend(page.threads.into_iter().map(|t| t.id));
                    match page.next {
                        Some(next) => cursor = Some(next),
                        None => break,
                    }
                }
                let mut expected = vec![];
                if !retained.is_empty() {
                    expected.push("read");
                }
                expected.extend(["u1", "u2"]);
                if accounts.len() == 2 {
                    expected.push("u3");
                }
                assert_eq!(found, expected);
            }
        }
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
                read_filter: None,
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
        sqlx::query(sqlx::AssertSqlSafe(format!("{prefix}{FIRST_PAGE_SQL}")))
            .bind("INBOX")
            .bind(account_ids)
            .bind(None::<&str>)
            .bind("[]")
            .bind(10_i64)
            .bind(None::<&str>)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    async fn run_cursor_page(
        pool: &SqlitePool,
        prefix: &str,
        account_ids: &str,
    ) -> Vec<sqlx::sqlite::SqliteRow> {
        sqlx::query(sqlx::AssertSqlSafe(format!("{prefix}{CURSOR_PAGE_SQL}")))
            .bind("INBOX")
            .bind(account_ids)
            .bind(250_i64)
            .bind("zz")
            .bind("zz")
            .bind(None::<&str>)
            .bind("[]")
            .bind(10_i64)
            .bind(None::<&str>)
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
            exclude_label_ids: &[],
            read_filter: None,
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
                read_filter: None,
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
                    read_filter: None,
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

        let a1 = labels(&["a1"]);
        let counts = unread_counts(&pool, &a1, &every_tab(&a1)).await.unwrap();
        let count = |id: &str| counts.iter().find(|(l, _)| l == id).map(|(_, n)| *n);
        assert_eq!(count("CATEGORY_PERSONAL"), Some(2));
        assert_eq!(count("INBOX"), Some(3));
        assert_eq!(count("CATEGORY_PROMOTIONS"), Some(1));

        // Without any category labels Primary is the whole inbox.
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(200), &["INBOX", "UNREAD"]).await;
        seed(&pool, "a1", "t2", Some(100), &["INBOX", "UNREAD"]).await;
        let a1 = labels(&["a1"]);
        let counts = unread_counts(&pool, &a1, &every_tab(&a1)).await.unwrap();
        assert_eq!(
            counts,
            vec![("CATEGORY_PERSONAL".to_owned(), 2), ("INBOX".to_owned(), 2)]
        );
    }

    #[tokio::test]
    async fn unread_counts_primary_absorbs_hidden_tabs_per_account() {
        let pool = seeded_pool().await;
        for account in ["a1", "a2"] {
            seed(&pool, account, "plain", Some(200), &["INBOX", "UNREAD"]).await;
            seed(
                &pool,
                account,
                "social",
                Some(100),
                &["INBOX", "UNREAD", "CATEGORY_SOCIAL"],
            )
            .await;
        }
        // a1 hides Social; a2 shows every tab.
        let excludes = HashMap::from([
            (
                "a1".to_owned(),
                labels(&["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]),
            ),
            ("a2".to_owned(), labels(&OTHERS)),
        ]);
        let counts = unread_counts(&pool, &labels(&["a1", "a2"]), &excludes)
            .await
            .unwrap();
        assert_eq!(
            counts,
            vec![
                ("CATEGORY_PERSONAL".to_owned(), 3),
                ("CATEGORY_SOCIAL".to_owned(), 2),
                ("INBOX".to_owned(), 4),
            ]
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
        let first = list_all_mail(&pool, &accounts, None, 2, None)
            .await
            .unwrap();
        let ids = |p: &ThreadPage| -> Vec<(String, String)> {
            p.threads
                .iter()
                .map(|t| (t.account_id.clone(), t.id.clone()))
                .collect()
        };
        assert_eq!(ids(&first), vec![pair("a1", "t1"), pair("a2", "t2")]);
        let cursor = first.next.clone().expect("more rows");
        let second = list_all_mail(&pool, &accounts, Some(&cursor), 2, None)
            .await
            .unwrap();
        assert_eq!(ids(&second), vec![pair("a1", "t3"), pair("a1", "t4")]);
        assert_eq!(second.next, None);

        // One account only.
        let only = list_all_mail(&pool, &labels(&["a2"]), None, 10, None)
            .await
            .unwrap();
        assert_eq!(ids(&only), vec![pair("a2", "t2")]);

        assert!(list_all_mail(&pool, &accounts, None, 0, None)
            .await
            .is_err());
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
            let page = list_all_mail(&pool, &accounts, cursor.as_ref(), 2, None)
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

    /// Accounts `a1` and `a2` with the threads that bend the label derivation: partly or
    /// wholly spammed or trashed, unread or not, and optimistic read changes. See
    /// [`counts_match_a_full_scan`].
    async fn derivation_edge_cases() -> SqlitePool {
        let pool = seeded_pool().await;
        let msg = |account: &str, id: &str, thread: &str, labels: &[&str]| DbMessage {
            id: id.into(),
            account_id: account.into(),
            thread_id: thread.into(),
            label_ids: Some(serde_json::to_string(labels).unwrap()),
            from_address: None,
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: None,
            // Three dates, so the lists both order by date and break ties.
            date: Some(100 + id[1..].parse::<i64>().unwrap() % 3),
            size_estimate: None,
            has_attachment: 0,
            is_read: (!labels.contains(&"UNREAD")).into(),
            is_starred: 0,
            raw_headers: None,
            fully_fetched: 1,
            rfc822_message_id: None,
        };
        let mailbox: &[(&str, &str, &str, &[&str])] = &[
            ("a1", "m1", "t1", &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]),
            (
                "a1",
                "m2",
                "t2",
                &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
            ),
            ("a1", "m3", "t3", &["INBOX", "CATEGORY_SOCIAL"]),
            ("a1", "m4", "t4", &["INBOX", "UNREAD"]),
            ("a1", "m5", "t5", &["Label_1", "UNREAD"]),
            ("a1", "m6", "t6", &["SENT"]),
            // Partly trashed: an unread message in the Inbox, a read one in Trash.
            ("a1", "m7", "t7", &["INBOX", "UNREAD"]),
            ("a1", "m8", "t7", &["TRASH"]),
            // Partly trashed the other way: the unread message is the trashed one.
            ("a1", "m9", "t8", &["INBOX"]),
            ("a1", "m10", "t8", &["TRASH", "UNREAD"]),
            // Wholly spammed or trashed and unread: the thread keeps only SPAM / TRASH.
            ("a1", "m11", "t9", &["SPAM", "UNREAD"]),
            ("a1", "m12", "t10", &["TRASH", "UNREAD"]),
            ("a1", "m13", "t11", &["SPAM", "UNREAD"]),
            ("a1", "m14", "t11", &["TRASH"]),
            // Read across the board, in Spam and Trash.
            ("a1", "m15", "t12", &["SPAM"]),
            ("a1", "m16", "t13", &["TRASH"]),
            // Two messages, one unread, in two categories.
            ("a1", "m17", "t14", &["INBOX", "CATEGORY_UPDATES"]),
            ("a1", "m18", "t14", &["INBOX", "UNREAD", "CATEGORY_FORUMS"]),
            // The same thread id in another account.
            ("a2", "m1", "t1", &["INBOX", "UNREAD", "CATEGORY_SOCIAL"]),
            ("a2", "m2", "t2", &["INBOX"]),
            ("a2", "m3", "t3", &["TRASH", "UNREAD"]),
        ];
        let mut tx = crate::db::begin_write(&pool).await.unwrap();
        for (account, id, thread, labels) in mailbox {
            crate::db::messages::upsert_message_tx(&mut tx, &msg(account, id, thread, labels))
                .await
                .unwrap();
        }
        // An optimistic change through the outbox path: mark t3 unread, t4 read.
        crate::db::messages::set_labels(
            &mut tx,
            "a1",
            "m3",
            &labels(&["INBOX", "CATEGORY_SOCIAL", "UNREAD"]),
        )
        .await
        .unwrap();
        crate::db::messages::set_labels(&mut tx, "a1", "m4", &labels(&["INBOX"]))
            .await
            .unwrap();
        for account in ["a1", "a2"] {
            let ids: Vec<String> = mailbox
                .iter()
                .filter(|m| m.0 == account)
                .map(|m| m.2.to_string())
                .collect();
            recompute_threads(&mut tx, account, &ids).await.unwrap();
        }
        tx.commit().await.unwrap();
        pool
    }

    /// The count queries skip most rows by relying on how thread labels are derived: an
    /// unread thread carries `UNREAD`, or only `SPAM`/`TRASH` when all its messages are
    /// spammed or trashed. Compare them with a plain scan of every row, over a mailbox with
    /// the cases that bend that rule, so a change to the derivation can't skew the counts.
    #[tokio::test]
    async fn counts_match_a_full_scan() {
        let pool = derivation_edge_cases().await;

        for account in ["a1", "a2"] {
            let mut expected: Vec<(String, i64, i64)> = sqlx::query_as(
                "SELECT tl.label_id, SUM(t.unread_count > 0), COUNT(*)
                 FROM thread_labels tl
                 JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
                 WHERE tl.account_id = ? GROUP BY tl.label_id ORDER BY tl.label_id",
            )
            .bind(account)
            .fetch_all(&pool)
            .await
            .unwrap();
            let (unread, total): (i64, i64) = sqlx::query_as(
                "SELECT COALESCE(SUM(t.unread_count > 0), 0), COUNT(*) FROM threads t
                 WHERE t.account_id = ? AND NOT EXISTS (
                   SELECT 1 FROM thread_labels e WHERE e.account_id = t.account_id
                     AND e.thread_id = t.id AND e.label_id IN ('SPAM', 'TRASH'))",
            )
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
            expected.push((ALL_MAIL.to_owned(), unread, total));
            let actual: Vec<(String, i64, i64)> = label_counts(&pool, account)
                .await
                .unwrap()
                .into_iter()
                .map(|c| (c.label_id, c.unread, c.total))
                .collect();
            assert_eq!(actual, expected, "label counts of {account}");
        }

        let categories =
            "('CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')";
        for scope in [&["a1"][..], &["a2"], &["a1", "a2"]] {
            let ids = labels(scope);
            let json = serde_json::to_string(&ids).unwrap();
            let expected: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT label_id, COUNT(*) FROM (
                   SELECT x.label_id AS label_id FROM thread_labels i
                   JOIN thread_labels u ON u.account_id = i.account_id
                     AND u.thread_id = i.thread_id AND u.label_id = 'UNREAD'
                   JOIN thread_labels x ON x.account_id = i.account_id
                     AND x.thread_id = i.thread_id
                     AND (x.label_id = 'INBOX' OR x.label_id IN {categories})
                   WHERE i.label_id = 'INBOX' AND i.account_id IN (SELECT value FROM json_each(?1))
                   UNION ALL
                   SELECT 'CATEGORY_PERSONAL' FROM thread_labels i
                   JOIN thread_labels u ON u.account_id = i.account_id
                     AND u.thread_id = i.thread_id AND u.label_id = 'UNREAD'
                   WHERE i.label_id = 'INBOX' AND i.account_id IN (SELECT value FROM json_each(?1))
                     AND NOT EXISTS (SELECT 1 FROM thread_labels c
                       WHERE c.account_id = i.account_id AND c.thread_id = i.thread_id
                         AND c.label_id IN {categories}))
                 GROUP BY label_id ORDER BY label_id"
            )))
            .bind(&json)
            .fetch_all(&pool)
            .await
            .unwrap();
            assert!(!expected.is_empty());
            assert_eq!(
                unread_counts(&pool, &ids, &every_tab(&ids)).await.unwrap(),
                expected,
                "{scope:?}"
            );
        }
    }

    #[tokio::test]
    async fn special_mailbox_counts_match_their_lists() {
        let pool = seeded_pool().await;
        let msg = |id: &str, labels: &str, read: i64| DbMessage {
            id: id.into(),
            account_id: "a1".into(),
            thread_id: id.replace('m', "t"),
            label_ids: Some(labels.into()),
            from_address: None,
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: None,
            date: Some(100),
            size_estimate: None,
            has_attachment: 0,
            is_read: read,
            is_starred: 0,
            raw_headers: None,
            fully_fetched: 1,
            rfc822_message_id: None,
        };
        let mut tx = crate::db::begin_write(&pool).await.unwrap();
        for m in [
            msg("m1", r#"["INBOX","UNREAD"]"#, 0),
            msg("m2", r#"["SENT"]"#, 1),
            // Wholly spammed / trashed and unread: derive_thread keeps only SPAM / TRASH.
            msg("m3", r#"["SPAM","UNREAD"]"#, 0),
            msg("m4", r#"["TRASH","UNREAD"]"#, 0),
            msg("m5", r#"["TRASH"]"#, 1),
            // One thread in both Spam and Trash: All Mail leaves it out once.
            msg("m6", r#"["SPAM"]"#, 1),
            DbMessage {
                thread_id: "t6".into(),
                ..msg("m7", r#"["TRASH"]"#, 1)
            },
        ] {
            crate::db::messages::upsert_message_tx(&mut tx, &m)
                .await
                .unwrap();
        }
        let ids: Vec<String> = (1..=6).map(|i| format!("t{i}")).collect();
        recompute_threads(&mut tx, "a1", &ids).await.unwrap();
        tx.commit().await.unwrap();

        let counts = label_counts(&pool, "a1").await.unwrap();
        let count = |id: &str| {
            counts
                .iter()
                .find(|c| c.label_id == id)
                .map(|c| (c.unread, c.total))
        };
        // All Mail is everything outside Spam and Trash, as `list_all_mail` lists it.
        let all = list_all_mail(&pool, &labels(&["a1"]), None, 50, None)
            .await
            .unwrap();
        let all_unread = all.threads.iter().filter(|t| t.unread_count > 0).count() as i64;
        assert_eq!(
            count(ALL_MAIL),
            Some((all_unread, all.threads.len() as i64))
        );
        assert_eq!(count(ALL_MAIL), Some((1, 2)));
        assert_eq!(count("SPAM"), Some((1, 2)));
        assert_eq!(count("TRASH"), Some((1, 3)));
        assert_eq!(count("INBOX"), Some((1, 1)));
        assert_eq!(
            label_counts(&pool, "a2").await.unwrap(),
            [],
            "an empty account has no rows, All Mail included"
        );
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
            let page = list_all_mail(&pool, &accounts, cursor.as_ref(), 2, None)
                .await
                .unwrap();
            got.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(got, vec!["t3", "t2", "t1", "old", "undated"]);

        let none = list_all_mail(&pool, &[], None, 10, None).await.unwrap();
        assert!(none.threads.is_empty() && none.next.is_none());
    }

    /// The unread list walks `UNREAD` rows rather than the label's, relying on the same
    /// derivation as the counts. Compare it with a scan of the label's rows, page by page,
    /// for every mailbox shape the app lists.
    #[tokio::test]
    async fn unread_lists_match_a_full_scan() {
        let pool = derivation_edge_cases().await;
        let categories = labels(&[
            "CATEGORY_SOCIAL",
            "CATEGORY_PROMOTIONS",
            "CATEGORY_UPDATES",
            "CATEGORY_FORUMS",
        ]);
        let keeps = [
            vec![],
            // Read now (t4), read all along (a2 t2, t6), wholly spam (t9), and a thread
            // that's unread anyway (t1).
            vec![
                pair("a1", "t4"),
                pair("a2", "t2"),
                pair("a1", "t6"),
                pair("a1", "t9"),
                pair("a1", "t1"),
            ],
        ];
        let mut checked = 0;
        for scope in [&["a1"][..], &["a2"], &["a1", "a2"]] {
            let accounts = labels(scope);
            for label in ["INBOX", "Label_1", "SENT", "UNREAD", "SPAM", "TRASH"] {
                for also in [None, Some("CATEGORY_SOCIAL"), Some("CATEGORY_FORUMS")] {
                    for exclude in [&[][..], &categories[..]] {
                        for keep in &keeps {
                            let expected: Vec<(String, String)> = sqlx::query_as(
                                "SELECT tl.account_id, tl.thread_id FROM thread_labels tl
                                 JOIN threads t ON t.account_id = tl.account_id
                                   AND t.id = tl.thread_id
                                 WHERE tl.label_id = ?1
                                   AND tl.account_id IN (SELECT value FROM json_each(?2))
                                   AND (?3 IS NULL OR EXISTS (SELECT 1 FROM thread_labels x
                                     WHERE x.account_id = tl.account_id
                                       AND x.thread_id = tl.thread_id AND x.label_id = ?3))
                                   AND NOT EXISTS (SELECT 1 FROM thread_labels e
                                     WHERE e.account_id = tl.account_id
                                       AND e.thread_id = tl.thread_id
                                       AND e.label_id IN (SELECT value FROM json_each(?4)))
                                   AND (t.unread_count > 0 OR json_array(t.account_id, t.id)
                                     IN (SELECT value FROM json_each(?5)))
                                 ORDER BY tl.last_message_date DESC, tl.account_id DESC,
                                   tl.thread_id DESC",
                            )
                            .bind(label)
                            .bind(serde_json::to_string(&accounts).unwrap())
                            .bind(also)
                            .bind(serde_json::to_string(exclude).unwrap())
                            .bind(serde_json::to_string(keep).unwrap())
                            .fetch_all(&pool)
                            .await
                            .unwrap();
                            for limit in [1, 2, 50] {
                                let q = ThreadQuery {
                                    account_ids: &accounts,
                                    label_id: label,
                                    also_label_id: also,
                                    exclude_label_ids: exclude,
                                    read_filter: Some(keep),
                                    before: None,
                                    limit,
                                };
                                assert_eq!(
                                    page_all(&pool, &q).await,
                                    expected,
                                    "{label} also {also:?} excluding {} keeping {} \
                                     of {scope:?}, pages of {limit}",
                                    exclude.len(),
                                    keep.len(),
                                );
                            }
                            checked += !expected.is_empty() as usize;
                        }
                    }
                }
            }
        }
        // Most shapes list something: the comparison isn't vacuous.
        assert!(checked > 40, "only {checked} non-empty lists");
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
            let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")));
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
