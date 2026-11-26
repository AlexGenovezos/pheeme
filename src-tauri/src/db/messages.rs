use crate::gmail::mime::EmailAddress;
use crate::gmail::types::Header;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbMessage {
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    pub label_ids: Option<String>, // JSON array
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>, // JSON array
    pub cc_addresses: Option<String>, // JSON array
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub date: Option<i64>,
    pub size_estimate: Option<i64>,
    pub has_attachment: i64,
    pub is_read: i64,
    pub is_starred: i64,
    pub raw_headers: Option<String>, // JSON
    pub fully_fetched: i64,
    /// `Message-ID` header, with angle brackets.
    pub rfc822_message_id: Option<String>,
}

impl DbMessage {
    pub fn labels(&self) -> Vec<String> {
        parse_labels(self.label_ids.as_deref())
    }

    /// The `To` recipients; empty when none are stored or the column isn't valid JSON.
    pub fn to(&self) -> Vec<EmailAddress> {
        parse_json(self.to_addresses.as_deref())
    }

    /// The `Cc` recipients, read like [`Self::to`].
    pub fn cc(&self) -> Vec<EmailAddress> {
        parse_json(self.cc_addresses.as_deref())
    }

    /// The message's raw headers; empty when none are stored or the column isn't valid JSON.
    pub fn headers(&self) -> Vec<Header> {
        parse_json(self.raw_headers.as_deref())
    }
}

/// A JSON column's value, or the type's default for a missing or unreadable one.
fn parse_json<T: serde::de::DeserializeOwned + Default>(json: Option<&str>) -> T {
    json.and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default()
}

pub fn parse_labels(json: Option<&str>) -> Vec<String> {
    parse_json(json)
}

// Both writes must insert the same columns, including the body-retention timestamp.
macro_rules! insert_message {
    ($msg:ident, $conflict:literal) => {
        sqlx::query!(
            r#"
        INSERT INTO messages (
            id, account_id, thread_id, label_ids,
            from_address, from_name, to_addresses, cc_addresses,
            subject, snippet, body_html, body_text,
            date, size_estimate, has_attachment, is_read, is_starred,
            raw_headers, fully_fetched, rfc822_message_id, body_fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  CASE WHEN ? = 1 THEN unixepoch() * 1000 END)
        ON CONFLICT(id, account_id) "#
                + $conflict,
            $msg.id,
            $msg.account_id,
            $msg.thread_id,
            $msg.label_ids,
            $msg.from_address,
            $msg.from_name,
            $msg.to_addresses,
            $msg.cc_addresses,
            $msg.subject,
            $msg.snippet,
            $msg.body_html,
            $msg.body_text,
            $msg.date,
            $msg.size_estimate,
            $msg.has_attachment,
            $msg.is_read,
            $msg.is_starred,
            $msg.raw_headers,
            $msg.fully_fetched,
            $msg.rfc822_message_id,
            $msg.fully_fetched,
        )
    };
}

/// Insert or update a message. A metadata-only copy (`fully_fetched = 0`) never erases a
/// body that was already cached.
pub async fn upsert_message_tx(conn: &mut SqliteConnection, msg: &DbMessage) -> Result<()> {
    insert_message!(
        msg,
        r#"DO UPDATE SET
            thread_id = excluded.thread_id,
            label_ids = excluded.label_ids,
            from_address = excluded.from_address,
            from_name = excluded.from_name,
            to_addresses = excluded.to_addresses,
            cc_addresses = excluded.cc_addresses,
            subject = excluded.subject,
            snippet = excluded.snippet,
            body_html = CASE WHEN excluded.fully_fetched = 1 THEN excluded.body_html ELSE messages.body_html END,
            body_text = CASE WHEN excluded.fully_fetched = 1 THEN excluded.body_text ELSE messages.body_text END,
            date = excluded.date,
            size_estimate = excluded.size_estimate,
            has_attachment = excluded.has_attachment,
            is_read = excluded.is_read,
            is_starred = excluded.is_starred,
            raw_headers = CASE WHEN excluded.fully_fetched = 1 THEN excluded.raw_headers ELSE messages.raw_headers END,
            body_fetched_at = CASE WHEN excluded.fully_fetched = 1 THEN excluded.body_fetched_at ELSE messages.body_fetched_at END,
            fully_fetched = MAX(excluded.fully_fetched, messages.fully_fetched),
            rfc822_message_id = COALESCE(excluded.rfc822_message_id, messages.rfc822_message_id)
        "#
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_message(pool: &SqlitePool, msg: &DbMessage) -> Result<()> {
    let mut conn = pool.acquire().await?;
    upsert_message_tx(&mut conn, msg).await
}

/// Insert only when the message isn't cached yet; returns whether it was inserted.
/// Backfill uses this so an older fetch never overwrites state that sync already applied.
pub async fn insert_message_if_absent(
    conn: &mut SqliteConnection,
    msg: &DbMessage,
) -> Result<bool> {
    let result = insert_message!(msg, "DO NOTHING")
        .execute(&mut *conn)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Replace a cached message's label set, keeping `is_read`/`is_starred` in step.
/// Returns whether anything changed: false when the message isn't cached or already has
/// exactly these labels (in this order), so callers recompute only threads that changed.
pub async fn set_labels(
    conn: &mut SqliteConnection,
    account_id: &str,
    message_id: &str,
    labels: &[String],
) -> Result<bool> {
    let json = serde_json::to_string(labels)?;
    let is_read: i64 = (!labels.iter().any(|l| l == "UNREAD")).into();
    let is_starred: i64 = labels.iter().any(|l| l == "STARRED").into();
    let done = sqlx::query!(
        r#"UPDATE messages SET label_ids = ?1, is_read = ?2, is_starred = ?3
           WHERE account_id = ?4 AND id = ?5
             AND (label_ids IS NOT ?1 OR is_read != ?2 OR is_starred != ?3)"#,
        json,
        is_read,
        is_starred,
        account_id,
        message_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// `message id -> (thread id, labels)` for the cached ones among `ids`.
pub async fn label_map(
    conn: &mut SqliteConnection,
    account_id: &str,
    ids: &[String],
) -> Result<HashMap<String, (String, Vec<String>)>> {
    let ids_json = serde_json::to_string(ids)?;
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", thread_id AS "thread_id!", label_ids FROM messages
           WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))"#,
        account_id,
        ids_json
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.id, (r.thread_id, parse_labels(r.label_ids.as_deref()))))
        .collect())
}

pub async fn existing_ids(
    conn: &mut SqliteConnection,
    account_id: &str,
    ids: &[String],
) -> Result<HashSet<String>> {
    let ids_json = serde_json::to_string(ids)?;
    let rows = sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM messages
           WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))"#,
        account_id,
        ids_json
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Up to `limit` cached message ids that sort below `below` (every id when `None`), highest
/// first. Gmail's ids are hex numbers that grow over time, so this pages through the cache
/// from about the newest message to the oldest, in an order that stays put while messages
/// come and go.
pub async fn ids_below<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    below: Option<&str>,
    limit: i64,
) -> Result<Vec<String>> {
    // Sorts after every id (ids are ASCII), so the first page needs no query of its own.
    let below = below.unwrap_or("\u{10ffff}");
    // `+account_id` keeps SQLite on the primary key `(id, account_id)`, read downwards from
    // `below`; left to choose, it takes an `account_id` index and sorts the account's ids
    // for every page.
    Ok(sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM messages
           WHERE +account_id = ? AND id < ? ORDER BY id DESC LIMIT ?"#,
        account_id,
        below,
        limit
    )
    .fetch_all(ex)
    .await?)
}

/// Ids of a thread's messages whose body hasn't been fetched yet.
pub async fn unfetched_in_thread<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM messages
           WHERE account_id = ? AND thread_id = ? AND fully_fetched = 0"#,
        account_id,
        thread_id
    )
    .fetch_all(ex)
    .await?)
}

/// The account's cached messages and how many of them have a body (for diagnostics).
pub async fn body_counts<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<(i64, i64)> {
    let row = sqlx::query!(
        r#"SELECT COUNT(*) AS "total!: i64",
                  COALESCE(SUM(fully_fetched != 0 OR body_html IS NOT NULL OR body_text IS NOT NULL), 0)
                    AS "with_bodies!: i64"
           FROM messages WHERE account_id = ?"#,
        account_id
    )
    .fetch_one(ex)
    .await?;
    Ok((row.total, row.with_bodies))
}

/// A cached message in Sent with this `Message-ID` (drafts with the same id don't count).
pub async fn find_sent_by_rfc822<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    rfc822_message_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM messages
           WHERE account_id = ? AND rfc822_message_id = ?
             AND EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = 'SENT')
           LIMIT 1"#,
        account_id,
        rfc822_message_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Oldest date (ms) among the cached messages in `ids`.
pub async fn oldest_date(
    conn: &mut SqliteConnection,
    account_id: &str,
    ids: &[String],
) -> Result<Option<i64>> {
    let ids_json = serde_json::to_string(ids)?;
    Ok(sqlx::query_scalar!(
        r#"SELECT MIN(date) AS "d?: i64" FROM messages
           WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))"#,
        account_id,
        ids_json
    )
    .fetch_one(&mut *conn)
    .await?)
}

/// Store a freshly fetched body without touching labels or flags (which sync and the
/// outbox own).
pub async fn set_body(conn: &mut SqliteConnection, msg: &DbMessage) -> Result<()> {
    sqlx::query!(
        r#"UPDATE messages SET body_html = ?, body_text = ?, raw_headers = ?, has_attachment = ?,
                  fully_fetched = 1, rfc822_message_id = COALESCE(?, rfc822_message_id),
                  body_fetched_at = unixepoch() * 1000
           WHERE account_id = ? AND id = ?"#,
        msg.body_html,
        msg.body_text,
        msg.raw_headers,
        msg.has_attachment,
        msg.rfc822_message_id,
        msg.account_id,
        msg.id
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Drop the cached bodies of up to `limit` messages sent before `sent_before` whose body
/// was downloaded before `fetched_before` (both ms). They go back to metadata only, so
/// opening one downloads the body again. Returns how many were trimmed.
pub async fn trim_old_bodies<'e>(
    ex: impl SqliteExecutor<'e>,
    sent_before: i64,
    fetched_before: i64,
    limit: i64,
) -> Result<u64> {
    let done = sqlx::query!(
        r#"UPDATE messages
           SET body_html = NULL, body_text = NULL, raw_headers = NULL,
               fully_fetched = 0, body_fetched_at = NULL
           WHERE rowid IN (
             SELECT rowid FROM messages
             WHERE body_fetched_at IS NOT NULL AND body_fetched_at < ? AND date < ?
             LIMIT ?
           )"#,
        fetched_before,
        sent_before,
        limit
    )
    .execute(ex)
    .await?;
    Ok(done.rows_affected())
}

/// Drop the cached bodies of up to `limit` messages, whatever their age, except drafts (whose
/// body is what the compose panel edits). Like [`trim_old_bodies`], they go back to metadata
/// only. Returns how many were cleared.
pub async fn clear_bodies<'e>(ex: impl SqliteExecutor<'e>, limit: i64) -> Result<u64> {
    let done = sqlx::query!(
        r#"UPDATE messages
           SET body_html = NULL, body_text = NULL, raw_headers = NULL,
               fully_fetched = 0, body_fetched_at = NULL
           WHERE rowid IN (
             SELECT rowid FROM messages
             WHERE body_fetched_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = 'DRAFT')
             LIMIT ?
           )"#,
        limit
    )
    .execute(ex)
    .await?;
    Ok(done.rows_affected())
}

/// `(account id, thread id)` of every thread with a cached body [`clear_bodies`] would drop.
pub async fn threads_with_bodies(pool: &SqlitePool) -> Result<Vec<(String, String)>> {
    let rows = sqlx::query!(
        r#"SELECT DISTINCT account_id AS "account_id!", thread_id AS "thread_id!" FROM messages
           WHERE body_fetched_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = 'DRAFT')"#
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.account_id, r.thread_id))
        .collect())
}

/// The From address of `thread_id`'s latest message not sent from `own_address`, or `None` when
/// every message is the account's own (or has no sender).
pub async fn latest_sender_other_than(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
    own_address: &str,
) -> Result<Option<String>> {
    let sender = sqlx::query_scalar!(
        r#"SELECT from_address AS "from_address!" FROM messages
           WHERE account_id = ?1 AND thread_id = ?2
             AND from_address IS NOT NULL AND from_address != ''
             AND lower(from_address) != lower(?3)
           ORDER BY date DESC LIMIT 1"#,
        account_id,
        thread_id,
        own_address
    )
    .fetch_optional(pool)
    .await?;
    Ok(sender)
}

/// One sender's mail over a time window ([`sender_stats`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbSenderStats {
    /// Lowercased.
    pub address: String,
    pub name: Option<String>,
    pub messages: i64,
    pub unread: i64,
    /// Messages the account answered: it sent mail in the conversation after them.
    pub replied: i64,
    pub starred: i64,
    /// Messages read, replied to or starred.
    pub engaged: i64,
    pub in_inbox: i64,
    pub in_trash: i64,
    pub in_spam: i64,
    pub promotions: i64,
    pub social: i64,
    pub updates: i64,
    pub forums: i64,
    /// ms since the epoch.
    pub last_date: i64,
    /// Messages the account sent to this address, ever (from `contacts`).
    pub you_wrote: i64,
}

/// Which senders [`sender_stats`] counts and how it ranks them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SenderQuery<'a> {
    pub since_ms: i64,
    pub limit: i64,
    /// Only mail with this label (a `CATEGORY_*` id, for one inbox tab).
    pub category: Option<&'a str>,
    /// Only mail with none of these labels (for Primary: the tabs the account shows).
    pub not_in: Option<&'a [String]>,
    /// Most unread first instead of most mail.
    pub by_unread: bool,
}

impl SenderQuery<'_> {
    pub fn top(since_ms: i64, limit: i64) -> Self {
        Self {
            since_ms,
            limit,
            category: None,
            not_in: None,
            by_unread: false,
        }
    }
}

/// Who sent the account the most mail since `q.since_ms`, most first: received mail only
/// (not the account's own, its drafts or what it sent).
pub async fn sender_stats(
    pool: &SqlitePool,
    account_id: &str,
    own_address: &str,
    q: &SenderQuery<'_>,
) -> Result<Vec<DbSenderStats>> {
    let not_in = q.not_in.map(serde_json::to_string).transpose()?;
    let rows = sqlx::query_as!(
        DbSenderStats,
        r#"WITH sent AS (SELECT thread_id, MAX(date) AS last_sent FROM messages INDEXED BY idx_messages_date
                         WHERE account_id = ?1 AND date >= ?2
                           AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = 'SENT')
                         GROUP BY thread_id)
           SELECT lower(m.from_address) AS "address!: String",
              MAX(m.from_name) AS "name: String",
              COUNT(*) AS "messages!: i64",
              SUM(m.is_read = 0) AS "unread!: i64",
              SUM(COALESCE(s.last_sent > m.date, 0)) AS "replied!: i64",
              SUM(m.is_starred != 0) AS "starred!: i64",
              SUM(m.is_read != 0 OR m.is_starred != 0 OR COALESCE(s.last_sent > m.date, 0)) AS "engaged!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'INBOX')) AS "in_inbox!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'TRASH')) AS "in_trash!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'SPAM')) AS "in_spam!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_PROMOTIONS')) AS "promotions!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_SOCIAL')) AS "social!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_UPDATES')) AS "updates!: i64",
              SUM(EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_FORUMS')) AS "forums!: i64",
              MAX(m.date) AS "last_date!: i64",
              COALESCE((SELECT c.sent_count FROM contacts c
                        WHERE c.account_id = ?1 AND c.address = lower(m.from_address)), 0) AS "you_wrote!: i64"
           FROM messages m
           LEFT JOIN sent s ON s.thread_id = m.thread_id
           WHERE m.account_id = ?1 AND m.date >= ?2
             AND m.from_address IS NOT NULL AND m.from_address != ''
             AND lower(m.from_address) != lower(?3)
             AND NOT EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value IN ('DRAFT', 'SENT'))
             AND (?5 IS NULL OR EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = ?5))
             AND (?7 IS NULL OR NOT EXISTS (
                    SELECT 1 FROM json_each(m.label_ids)
                    WHERE value IN (SELECT value FROM json_each(?7))))
           GROUP BY lower(m.from_address)
           ORDER BY CASE WHEN ?6 THEN SUM(m.is_read = 0) ELSE COUNT(*) END DESC,
                    COUNT(*) DESC, MAX(m.date) DESC
           LIMIT ?4"#,
        account_id,
        q.since_ms,
        own_address,
        q.limit,
        q.category,
        q.by_unread,
        not_in
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Received mail, a day or a place at a time ([`received_by_day`], [`received_by_label`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbReceivedStats {
    /// A local `YYYY-MM-DD` day, an inbox tab (`primary`, `promotions`, `social`, `updates`,
    /// `forums`, or `spam`), or a label id.
    pub key: String,
    /// The day's tab for [`received_by_day`]; the label's name for [`received_by_label`].
    pub group: String,
    pub received: i64,
    pub opened: i64,
    pub replied: i64,
    pub starred: i64,
    /// Read, replied to or starred.
    pub engaged: i64,
}

/// The account's received mail since `since_ms` (not its own, its drafts or what it sent),
/// counted per local day and inbox tab. A message counts as replied when the account sent
/// mail in its conversation after it.
pub async fn received_by_day(
    pool: &SqlitePool,
    account_id: &str,
    since_ms: i64,
    own_address: &str,
) -> Result<Vec<DbReceivedStats>> {
    let rows = sqlx::query_as!(
        DbReceivedStats,
        r#"WITH sent AS (SELECT thread_id, MAX(date) AS last_sent FROM messages INDEXED BY idx_messages_date
                         WHERE account_id = ?1 AND date >= ?2
                           AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = 'SENT')
                         GROUP BY thread_id),
           recv AS (
             SELECT m.date, m.is_read != 0 AS opened, m.is_starred != 0 AS starred,
                    COALESCE(s.last_sent > m.date, 0) AS replied,
                    CASE
                      WHEN EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'SPAM') THEN 'spam'
                      WHEN EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_PROMOTIONS') THEN 'promotions'
                      WHEN EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_SOCIAL') THEN 'social'
                      WHEN EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_UPDATES') THEN 'updates'
                      WHEN EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = 'CATEGORY_FORUMS') THEN 'forums'
                      ELSE 'primary'
                    END AS tab
             FROM messages m INDEXED BY idx_messages_date
             LEFT JOIN sent s ON s.thread_id = m.thread_id
             WHERE m.account_id = ?1 AND m.date >= ?2
               AND m.from_address IS NOT NULL AND m.from_address != ''
               AND lower(m.from_address) != lower(?3)
               AND NOT EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value IN ('DRAFT', 'SENT')))
           SELECT date(date / 1000, 'unixepoch', 'localtime') AS "key!: String",
                  tab AS "group!: String",
                  COUNT(*) AS "received!: i64",
                  SUM(opened) AS "opened!: i64",
                  SUM(replied) AS "replied!: i64",
                  SUM(starred) AS "starred!: i64",
                  SUM(opened OR replied OR starred) AS "engaged!: i64"
           FROM recv
           GROUP BY 1, 2
           ORDER BY 1, 2"#,
        account_id,
        since_ms,
        own_address
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// The same mail as [`received_by_day`], per user label it carries (most mail first, at most
/// `limit` labels).
pub async fn received_by_label(
    pool: &SqlitePool,
    account_id: &str,
    since_ms: i64,
    own_address: &str,
    limit: i64,
) -> Result<Vec<DbReceivedStats>> {
    let rows = sqlx::query_as!(
        DbReceivedStats,
        r#"WITH sent AS (SELECT thread_id, MAX(date) AS last_sent FROM messages INDEXED BY idx_messages_date
                         WHERE account_id = ?1 AND date >= ?2
                           AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = 'SENT')
                         GROUP BY thread_id),
           recv AS (
             SELECT m.label_ids, m.is_read != 0 AS opened, m.is_starred != 0 AS starred,
                    COALESCE(s.last_sent > m.date, 0) AS replied
             FROM messages m INDEXED BY idx_messages_date
             LEFT JOIN sent s ON s.thread_id = m.thread_id
             WHERE m.account_id = ?1 AND m.date >= ?2
               AND m.from_address IS NOT NULL AND m.from_address != ''
               AND lower(m.from_address) != lower(?3)
               AND NOT EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value IN ('DRAFT', 'SENT')))
           SELECT l.id AS "key!: String",
                  l.name AS "group!: String",
                  COUNT(*) AS "received!: i64",
                  SUM(r.opened) AS "opened!: i64",
                  SUM(r.replied) AS "replied!: i64",
                  SUM(r.starred) AS "starred!: i64",
                  SUM(r.opened OR r.replied OR r.starred) AS "engaged!: i64"
           FROM recv r
           JOIN json_each(r.label_ids) j
           JOIN labels l ON l.account_id = ?1 AND l.id = j.value AND l.type = 'user'
           GROUP BY l.id
           ORDER BY COUNT(*) DESC, l.name
           LIMIT ?4"#,
        account_id,
        since_ms,
        own_address,
        limit
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// The newest message from `address` (any case) since `since_ms` whose headers are cached,
/// else the newest one: its id, thread and headers (JSON, `None` when only its metadata is
/// cached). The window keeps the scan to recent mail: without statistics SQLite would
/// otherwise pick an `account_id` index and read the account's whole history per sender.
pub async fn latest_from(
    pool: &SqlitePool,
    account_id: &str,
    address: &str,
    since_ms: i64,
) -> Result<Option<(String, String, Option<String>)>> {
    let row = sqlx::query!(
        r#"SELECT id AS "id!", thread_id AS "thread_id!", raw_headers
           FROM messages INDEXED BY idx_messages_sender
           WHERE account_id = ?1 AND lower(from_address) = lower(?2) AND date >= ?3
           ORDER BY (raw_headers IS NOT NULL) DESC, date DESC LIMIT 1"#,
        account_id,
        address,
        since_ms
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.id, r.thread_id, r.raw_headers)))
}

pub async fn get_messages_for_thread<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<DbMessage>> {
    let messages = sqlx::query_as!(
        DbMessage,
        r#"
        SELECT id, account_id, thread_id, label_ids,
               from_address, from_name, to_addresses, cc_addresses,
               subject, snippet, body_html, body_text,
               date, size_estimate, has_attachment, is_read, is_starred,
               raw_headers, fully_fetched, rfc822_message_id
        FROM messages
        WHERE account_id = ? AND thread_id = ?
        ORDER BY date ASC, id ASC
        "#,
        account_id,
        thread_id
    )
    .fetch_all(ex)
    .await?;
    Ok(messages)
}

/// One cached message's id, labels and date: what label changes need, without the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageLabels {
    pub id: String,
    pub labels: Vec<String>,
    pub date: Option<i64>,
}

/// A thread's cached messages, oldest first, without their bodies. The outbox reads these
/// inside write transactions, where loading every body would hold the write lock for long.
pub async fn labels_for_thread<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<MessageLabels>> {
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", label_ids, date FROM messages
           WHERE account_id = ? AND thread_id = ?
           ORDER BY date ASC, id ASC"#,
        account_id,
        thread_id
    )
    .fetch_all(ex)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| MessageLabels {
            id: r.id,
            labels: parse_labels(r.label_ids.as_deref()),
            date: r.date,
        })
        .collect())
}

/// [`get_messages_for_thread`] without the bodies and headers (they read as `None`): what
/// deriving the thread row needs. Threads are recomputed inside every sync and outbox write.
pub async fn thread_messages_without_bodies<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<DbMessage>> {
    let messages = sqlx::query_as!(
        DbMessage,
        r#"
        SELECT id, account_id, thread_id, label_ids,
               from_address, from_name, to_addresses, cc_addresses,
               subject, snippet, NULL AS "body_html: String", NULL AS "body_text: String",
               date, size_estimate, has_attachment, is_read, is_starred,
               NULL AS "raw_headers: String", fully_fetched, rfc822_message_id
        FROM messages
        WHERE account_id = ? AND thread_id = ?
        ORDER BY date ASC, id ASC
        "#,
        account_id,
        thread_id
    )
    .fetch_all(ex)
    .await?;
    Ok(messages)
}

pub async fn get_message<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    message_id: &str,
) -> Result<Option<DbMessage>> {
    let msg = sqlx::query_as!(
        DbMessage,
        r#"
        SELECT id, account_id, thread_id, label_ids,
               from_address, from_name, to_addresses, cc_addresses,
               subject, snippet, body_html, body_text,
               date, size_estimate, has_attachment, is_read, is_starred,
               raw_headers, fully_fetched, rfc822_message_id
        FROM messages WHERE account_id = ? AND id = ?
        "#,
        account_id,
        message_id
    )
    .fetch_optional(ex)
    .await?;
    Ok(msg)
}

pub async fn delete_message<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    message_id: &str,
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM messages WHERE account_id = ? AND id = ?",
        account_id,
        message_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, thread: &str) -> DbMessage {
        DbMessage {
            id: id.into(),
            account_id: "a".into(),
            thread_id: thread.into(),
            label_ids: Some(r#"["INBOX"]"#.into()),
            from_address: Some("x@y.com".into()),
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: Some("Hi".into()),
            snippet: Some("snip".into()),
            body_html: Some("<p>body</p>".into()),
            body_text: Some("body".into()),
            date: Some(1),
            size_estimate: None,
            has_attachment: 0,
            is_read: 1,
            is_starred: 0,
            raw_headers: Some("[]".into()),
            fully_fetched: 1,
            rfc822_message_id: None,
        }
    }

    #[tokio::test]
    async fn thread_reads_for_label_work_leave_the_bodies_on_disk() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        upsert_message(&db.pool, &message("m1", "t1"))
            .await
            .unwrap();
        let full = get_messages_for_thread(&db.pool, "a", "t1").await.unwrap();
        let light = thread_messages_without_bodies(&db.pool, "a", "t1")
            .await
            .unwrap();
        assert_eq!(light.len(), 1);
        assert_eq!(
            (
                &light[0].body_html,
                &light[0].body_text,
                &light[0].raw_headers
            ),
            (&None, &None, &None)
        );
        assert_eq!(
            (&light[0].subject, &light[0].snippet, light[0].labels()),
            (&full[0].subject, &full[0].snippet, full[0].labels())
        );
        assert_eq!(
            labels_for_thread(&db.pool, "a", "t1").await.unwrap(),
            [MessageLabels {
                id: "m1".into(),
                labels: vec!["INBOX".into()],
                date: Some(1),
            }]
        );
    }

    #[tokio::test]
    async fn ids_below_pages_from_the_highest_id_down() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        for id in ["19a1", "19a3", "19a2", "18ff"] {
            upsert_message(&db.pool, &message(id, id)).await.unwrap();
        }
        let first = ids_below(&db.pool, "a", None, 3).await.unwrap();
        assert_eq!(first, ["19a3", "19a2", "19a1"]);
        let rest = ids_below(&db.pool, "a", first.last().map(String::as_str), 3)
            .await
            .unwrap();
        assert_eq!(rest, ["18ff"]);
        assert!(ids_below(&db.pool, "a", Some("18ff"), 3)
            .await
            .unwrap()
            .is_empty());
        assert!(ids_below(&db.pool, "b", None, 3).await.unwrap().is_empty());

        // Each page is a walk down the primary key from `below`: no sort, no full scan.
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            "EXPLAIN QUERY PLAN SELECT id FROM messages
             WHERE +account_id = 'a' AND id < 'x' ORDER BY id DESC LIMIT 3",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert!(
            plan.iter()
                .all(|(_, _, _, step)| !step.contains("TEMP B-TREE"))
                && plan.iter().any(|(_, _, _, step)| step.contains("id<?")),
            "{plan:?}"
        );
    }

    #[tokio::test]
    async fn latest_from_reads_only_the_window() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            "EXPLAIN QUERY PLAN SELECT id FROM messages INDEXED BY idx_messages_date
             WHERE date >= 0 AND account_id = 'a' AND lower(from_address) = 'x'
             ORDER BY (raw_headers IS NOT NULL) DESC, date DESC LIMIT 1",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert!(
            plan.iter().any(
                |(_, _, _, step)| step.contains("idx_messages_date") && step.contains("date>?")
            ),
            "{plan:?}"
        );
        assert!(latest_from(&db.pool, "a", "x@y.com", 0)
            .await
            .unwrap()
            .is_none());
    }
}
