use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbThread {
    pub id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub history_id: Option<String>,
    pub label_ids: Option<String>, // JSON array
    pub last_message_date: Option<i64>,
    pub message_count: i64,
    pub unread_count: i64,
    pub has_attachment: i64,
}

pub async fn upsert_thread(pool: &SqlitePool, thread: &DbThread) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO threads (
            id, account_id, subject, snippet, history_id,
            label_ids, last_message_date, message_count, unread_count, has_attachment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            subject = excluded.subject,
            snippet = excluded.snippet,
            history_id = excluded.history_id,
            label_ids = excluded.label_ids,
            last_message_date = excluded.last_message_date,
            message_count = excluded.message_count,
            unread_count = excluded.unread_count,
            has_attachment = excluded.has_attachment
        "#,
        thread.id,
        thread.account_id,
        thread.subject,
        thread.snippet,
        thread.history_id,
        thread.label_ids,
        thread.last_message_date,
        thread.message_count,
        thread.unread_count,
        thread.has_attachment,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_threads_by_label(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<DbThread>> {
    // label_ids is a JSON array; use EXISTS + json_each to filter
    let threads = sqlx::query_as!(
        DbThread,
        r#"
        SELECT id, account_id, subject, snippet, history_id,
               label_ids, last_message_date, message_count, unread_count, has_attachment
        FROM threads
        WHERE account_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(label_ids) WHERE value = ?
          )
        ORDER BY last_message_date DESC
        LIMIT ? OFFSET ?
        "#,
        account_id,
        label_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?;
    Ok(threads)
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
               label_ids, last_message_date, message_count, unread_count, has_attachment
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

pub async fn update_thread_labels(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
    label_ids_json: &str,
) -> Result<()> {
    sqlx::query!(
        "UPDATE threads SET label_ids = ? WHERE account_id = ? AND id = ?",
        label_ids_json,
        account_id,
        thread_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
