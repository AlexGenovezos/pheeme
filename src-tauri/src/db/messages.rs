use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

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
}

pub async fn upsert_message(pool: &SqlitePool, msg: &DbMessage) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO messages (
            id, account_id, thread_id, label_ids,
            from_address, from_name, to_addresses, cc_addresses,
            subject, snippet, body_html, body_text,
            date, size_estimate, has_attachment, is_read, is_starred,
            raw_headers, fully_fetched
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
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
            fully_fetched = excluded.fully_fetched
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
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_messages_for_thread(
    pool: &SqlitePool,
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
               raw_headers, fully_fetched
        FROM messages
        WHERE account_id = ? AND thread_id = ?
        ORDER BY date ASC
        "#,
        account_id,
        thread_id
    )
    .fetch_all(pool)
    .await?;
    Ok(messages)
}

pub async fn get_message(
    pool: &SqlitePool,
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
               raw_headers, fully_fetched
        FROM messages WHERE account_id = ? AND id = ?
        "#,
        account_id,
        message_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(msg)
}

pub async fn delete_message(pool: &SqlitePool, account_id: &str, message_id: &str) -> Result<()> {
    sqlx::query!(
        "DELETE FROM messages WHERE account_id = ? AND id = ?",
        account_id,
        message_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_message_labels(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    label_ids_json: &str,
    is_read: i64,
    is_starred: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE messages SET label_ids = ?, is_read = ?, is_starred = ? WHERE account_id = ? AND id = ?",
        label_ids_json,
        is_read,
        is_starred,
        account_id,
        message_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_messages_read(
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
    is_read: bool,
) -> Result<()> {
    let read_val: i64 = if is_read { 1 } else { 0 };
    for id in message_ids {
        sqlx::query!(
            "UPDATE messages SET is_read = ? WHERE account_id = ? AND id = ?",
            read_val,
            account_id,
            id
        )
        .execute(pool)
        .await?;
    }
    Ok(())
}
