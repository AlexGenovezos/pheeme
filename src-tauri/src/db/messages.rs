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
}

pub fn parse_labels(json: Option<&str>) -> Vec<String> {
    json.and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default()
}

/// Insert or update a message. A metadata-only copy (`fully_fetched = 0`) never erases a
/// body that was already cached.
pub async fn upsert_message_tx(conn: &mut SqliteConnection, msg: &DbMessage) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO messages (
            id, account_id, thread_id, label_ids,
            from_address, from_name, to_addresses, cc_addresses,
            subject, snippet, body_html, body_text,
            date, size_estimate, has_attachment, is_read, is_starred,
            raw_headers, fully_fetched, rfc822_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
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
            fully_fetched = MAX(excluded.fully_fetched, messages.fully_fetched),
            rfc822_message_id = COALESCE(excluded.rfc822_message_id, messages.rfc822_message_id)
        "#,
        msg.id,
        msg.account_id,
        msg.thread_id,
        msg.label_ids,
        msg.from_address,
        msg.from_name,
        msg.to_addresses,
        msg.cc_addresses,
        msg.subject,
        msg.snippet,
        msg.body_html,
        msg.body_text,
        msg.date,
        msg.size_estimate,
        msg.has_attachment,
        msg.is_read,
        msg.is_starred,
        msg.raw_headers,
        msg.fully_fetched,
        msg.rfc822_message_id,
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
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 AS "one!: i64" FROM messages WHERE account_id = ? AND id = ?"#,
        msg.account_id,
        msg.id
    )
    .fetch_optional(&mut *conn)
    .await?
    .is_some();
    if exists {
        return Ok(false);
    }
    upsert_message_tx(conn, msg).await?;
    Ok(true)
}

/// Replace a cached message's label set, keeping `is_read`/`is_starred` in step.
/// Returns false when the message isn't cached.
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
        "UPDATE messages SET label_ids = ?, is_read = ?, is_starred = ? WHERE account_id = ? AND id = ?",
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
    Ok(label_map(conn, account_id, ids)
        .await?
        .into_keys()
        .collect())
}

/// Every cached message as `(id, thread id)`, newest first.
pub async fn all_ids<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Vec<(String, String)>> {
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", thread_id AS "thread_id!" FROM messages
           WHERE account_id = ? ORDER BY date DESC"#,
        account_id
    )
    .fetch_all(ex)
    .await?;
    Ok(rows.into_iter().map(|r| (r.id, r.thread_id)).collect())
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
                  fully_fetched = 1, rfc822_message_id = COALESCE(?, rfc822_message_id)
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
