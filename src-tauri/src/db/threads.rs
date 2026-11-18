use crate::db::messages::{self, DbMessage};
use anyhow::Result;
use counts::CountDeltas;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashMap};

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
    let mut deltas = CountDeltas::default();
    upsert_thread_tx(&mut tx, thread, label_ids, &mut deltas).await?;
    deltas.flush(&mut tx, &thread.account_id).await?;
    bump_version(&mut tx, &thread.account_id).await?;
    tx.commit().await?;
    Ok(())
}

/// Upsert the thread row and replace its label set inside the caller's transaction, adding
/// the change to `deltas`. Returns whether the thread existed before.
async fn upsert_thread_tx(
    conn: &mut SqliteConnection,
    thread: &DbThread,
    label_ids: &[String],
    deltas: &mut CountDeltas,
) -> Result<bool> {
    let old_unread = sqlx::query_scalar!(
        "SELECT unread_count FROM threads WHERE account_id = ? AND id = ?",
        thread.account_id,
        thread.id
    )
    .fetch_optional(&mut *conn)
    .await?;
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

    let old_labels = replace_thread_labels(
        conn,
        &thread.account_id,
        &thread.id,
        thread.last_message_date,
        label_ids,
    )
    .await?;
    if let Some(old_unread) = old_unread {
        deltas.add(&old_labels, old_unread, -1);
    }
    deltas.add(label_ids, thread.unread_count, 1);
    Ok(old_unread.is_some())
}

/// Marks the account's threads changed, inside the transaction that changes them, so
/// [`label_counts`] counts again. Every write to `threads` or `thread_labels` comes here.
async fn bump_version(conn: &mut SqliteConnection, account_id: &str) -> Result<()> {
    sqlx::query!(
        "INSERT INTO thread_versions (account_id, version) VALUES (?, 1)
         ON CONFLICT (account_id) DO UPDATE SET version = version + 1",
        account_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Deletes and re-inserts the thread's label rows inside the caller's
/// transaction, stamping each with the thread's `last_message_date`. Returns the labels it
/// had. Counts are the caller's to keep ([`CountDeltas`]).
async fn replace_thread_labels(
    tx: &mut sqlx::SqliteConnection,
    account_id: &str,
    thread_id: &str,
    last_message_date: Option<i64>,
    label_ids: &[String],
) -> Result<Vec<String>> {
    let old = delete_thread_labels(tx, account_id, thread_id).await?;

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
    Ok(old)
}

/// Deletes the thread's label rows, returning their label ids.
async fn delete_thread_labels(
    tx: &mut sqlx::SqliteConnection,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        "DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ? RETURNING label_id",
        account_id,
        thread_id
    )
    .fetch_all(&mut *tx)
    .await?)
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
        "SELECT last_message_date, unread_count FROM threads WHERE account_id = ? AND id = ?",
        account_id,
        thread_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = row {
        let old = replace_thread_labels(
            &mut tx,
            account_id,
            thread_id,
            row.last_message_date,
            label_ids,
        )
        .await?;
        let mut deltas = CountDeltas::default();
        deltas.add(&old, row.unread_count, -1);
        deltas.add(label_ids, row.unread_count, 1);
        deltas.flush(&mut tx, account_id).await?;
        bump_version(&mut tx, account_id).await?;
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

pub(super) struct ThreadRow {
    pub(super) id: String,
    pub(super) account_id: String,
    pub(super) subject: Option<String>,
    pub(super) snippet: Option<String>,
    pub(super) history_id: Option<String>,
    pub(super) last_message_date: Option<i64>,
    pub(super) message_count: i64,
    pub(super) unread_count: i64,
    pub(super) has_attachment: i64,
    pub(super) from_name: Option<String>,
    pub(super) from_address: Option<String>,
    pub(super) is_starred: i64,
    pub(super) cursor_date: i64,
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
pub(super) fn page_from_rows(mut rows: Vec<ThreadRow>, page_limit: usize) -> ThreadPage {
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
    let mut deltas = CountDeltas::default();
    let unique: BTreeSet<&String> = thread_ids.iter().collect();
    for thread_id in unique {
        let msgs =
            messages::thread_messages_without_bodies(&mut *conn, account_id, thread_id).await?;
        match derive_thread(account_id, thread_id, &msgs) {
            Some((thread, labels)) => {
                if upsert_thread_tx(conn, &thread, &labels, &mut deltas).await? {
                    result.updated.push(thread_id.clone());
                } else {
                    result.created.push(thread_id.clone());
                }
            }
            None => {
                // The labels first: deleting the thread would cascade them away unseen.
                let old_labels = delete_thread_labels(conn, account_id, thread_id).await?;
                let old_unread = sqlx::query_scalar!(
                    "DELETE FROM threads WHERE account_id = ? AND id = ? RETURNING unread_count",
                    account_id,
                    thread_id
                )
                .fetch_optional(&mut *conn)
                .await?;
                if let Some(old_unread) = old_unread {
                    deltas.add(&old_labels, old_unread, -1);
                    result.removed.push(thread_id.clone());
                }
            }
        }
    }
    if !result.is_empty() {
        deltas.flush(&mut *conn, account_id).await?;
        bump_version(&mut *conn, account_id).await?;
    }
    Ok(result)
}

/// Unread thread counts across `account_ids` for `INBOX` and each inbox category tab.
/// A category is `INBOX ∩ CATEGORY_x`; `CATEGORY_PERSONAL` (Primary) is the unread inbox
/// minus the account's `excludes` (the categories whose tabs it shows; an account missing
/// from the map excludes nothing), so an account without category labels still has its
/// whole inbox under Primary. Labels with no unread threads are omitted.
///
/// Read from `inbox_unread_counts`, which `recompute_threads` keeps ([`counts`]): the
/// unread inbox threads grouped by the other tabs' categories they carry.
pub async fn unread_counts(
    pool: &SqlitePool,
    account_ids: &[String],
    excludes: &HashMap<String, Vec<String>>,
) -> Result<Vec<(String, i64)>> {
    let accounts = serde_json::to_string(account_ids)?;
    let rows = sqlx::query!(
        r#"SELECT account_id AS "account_id!", categories AS "categories!", threads AS "threads!: i64"
           FROM inbox_unread_counts
           WHERE account_id IN (SELECT value FROM json_each(?1)) AND threads > 0"#,
        accounts
    )
    .fetch_all(pool)
    .await?;
    let mut out: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows {
        let categories: Vec<&str> = row
            .categories
            .split(',')
            .filter(|c| !c.is_empty())
            .collect();
        *out.entry("INBOX".to_owned()).or_default() += row.threads;
        for category in &categories {
            *out.entry((*category).to_owned()).or_default() += row.threads;
        }
        let excluded = excludes.get(&row.account_id);
        if !categories
            .iter()
            .any(|c| excluded.is_some_and(|ex| ex.iter().any(|e| e == c)))
        {
            *out.entry("CATEGORY_PERSONAL".to_owned()).or_default() += row.threads;
        }
    }
    Ok(out.into_iter().filter(|(_, n)| *n > 0).collect())
}

/// The unread inbox threads of one account in one inbox tab, as [`unread_counts`] counts
/// them: `INBOX ∩ category`, or for Primary (`category` `None`) the unread inbox minus
/// `excludes`. Walks the `UNREAD` rows like [`unread_counts`].
pub async fn unread_inbox_tab_threads(
    pool: &SqlitePool,
    account_id: &str,
    category: Option<&str>,
    excludes: &[String],
) -> Result<Vec<String>> {
    let excluded = serde_json::to_string(excludes)?;
    let rows = sqlx::query_scalar!(
        r#"
        SELECT u.thread_id AS "thread_id!"
        FROM thread_labels u INDEXED BY idx_thread_labels_listing
        CROSS JOIN thread_labels i
          ON i.account_id = u.account_id AND i.thread_id = u.thread_id AND i.label_id = 'INBOX'
        WHERE u.label_id = 'UNREAD' AND u.account_id = ?1
          AND (?2 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels c
                WHERE c.account_id = u.account_id AND c.thread_id = u.thread_id
                  AND c.label_id = ?2))
          AND NOT EXISTS (
                SELECT 1 FROM json_each(?3) ex CROSS JOIN thread_labels c
                  ON c.account_id = u.account_id AND c.thread_id = u.thread_id
                 AND c.label_id = ex.value)
        "#,
        account_id,
        category,
        excluded
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Unread and total thread counts for one label of one account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelCount {
    pub label_id: String,
    pub unread: i64,
    pub total: i64,
}

/// An account's [`LabelCount`]s and the version of its threads they were counted at.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LabelCounts {
    pub version: i64,
    pub counts: Vec<LabelCount>,
}

/// The count row for All Mail (every thread outside Spam and Trash), beside the labels.
pub const ALL_MAIL: &str = "ALL";

/// Thread counts per label id for one account, plus an [`ALL_MAIL`] row last. A thread
/// counts as unread exactly when the lists show it unread (`unread_count > 0`), so Spam and
/// Trash count their unread threads although a wholly spammed or trashed thread has no
/// `UNREAD` label. Labels with no threads (and All Mail when empty) are omitted; no unread
/// threads is `unread: 0`.
///
/// Read from `label_thread_counts`, which `recompute_threads` keeps ([`counts`]). The counts
/// come with the version of the account's threads they were read at ([`bump_version`]):
/// given the `known` version, and nothing has changed since, this answers `None`.
pub async fn label_counts(
    pool: &SqlitePool,
    account_id: &str,
    known: Option<i64>,
) -> Result<Option<LabelCounts>> {
    // One snapshot for the version and the counts, so a sync landing between them can't slip
    // past the version.
    let mut tx = pool.begin().await?;
    let version = sqlx::query_scalar!(
        r#"SELECT COALESCE((SELECT version FROM thread_versions WHERE account_id = ?), 0) AS "v!: i64""#,
        account_id
    )
    .fetch_one(&mut *tx)
    .await?;
    if known == Some(version) {
        tx.commit().await?;
        return Ok(None);
    }
    let rows = sqlx::query!(
        r#"SELECT label_id AS "label_id!", total AS "total!: i64", unread AS "unread!: i64"
           FROM label_thread_counts
           WHERE account_id = ? AND total > 0
           ORDER BY label_id = 'ALL', label_id"#,
        account_id
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let counts = rows
        .into_iter()
        .map(|r| LabelCount {
            label_id: r.label_id,
            unread: r.unread,
            total: r.total,
        })
        .collect();
    Ok(Some(LabelCounts { version, counts }))
}

/// How big an account's cached mailbox is, for Send diagnostics: the list and count reads grow
/// with these, not with the message count alone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MailboxShape {
    pub threads: i64,
    pub inbox_threads: i64,
    /// Threads carrying `UNREAD`, anywhere.
    pub unread_threads: i64,
    /// Rows of `thread_labels`: one per label per thread.
    pub thread_label_rows: i64,
}

pub async fn mailbox_shape(pool: &SqlitePool, account_id: &str) -> Result<MailboxShape> {
    let row = sqlx::query!(
        r#"SELECT
              (SELECT COUNT(*) FROM threads WHERE account_id = ?1) AS "threads!: i64",
              (SELECT COUNT(*) FROM thread_labels
               WHERE label_id = 'INBOX' AND account_id = ?1) AS "inbox!: i64",
              (SELECT COUNT(*) FROM thread_labels
               WHERE label_id = 'UNREAD' AND account_id = ?1) AS "unread!: i64",
              (SELECT COUNT(*) FROM thread_labels WHERE account_id = ?1) AS "rows!: i64""#,
        account_id
    )
    .fetch_one(pool)
    .await?;
    Ok(MailboxShape {
        threads: row.threads,
        inbox_threads: row.inbox,
        unread_threads: row.unread,
        thread_label_rows: row.rows,
    })
}

mod counts;
#[cfg(test)]
mod tests;
