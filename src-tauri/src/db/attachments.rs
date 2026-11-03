use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbAttachment {
    pub id: String,
    pub message_id: String,
    pub account_id: String,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub attachment_id: Option<String>,
    /// Content-ID without angle brackets.
    pub content_id: Option<String>,
    pub is_inline: i64,
}

pub async fn insert_attachment(pool: &SqlitePool, att: &DbAttachment) -> Result<()> {
    let mut conn = pool.acquire().await?;
    insert_attachment_tx(&mut conn, att).await
}

async fn insert_attachment_tx(conn: &mut SqliteConnection, att: &DbAttachment) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO attachments (
            id, message_id, account_id, filename, mime_type, size, attachment_id,
            content_id, is_inline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, message_id, account_id) DO UPDATE SET
            filename = excluded.filename,
            mime_type = excluded.mime_type,
            size = excluded.size,
            attachment_id = excluded.attachment_id,
            content_id = excluded.content_id,
            is_inline = excluded.is_inline
        "#,
        att.id,
        att.message_id,
        att.account_id,
        att.filename,
        att.mime_type,
        att.size,
        att.attachment_id,
        att.content_id,
        att.is_inline,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn get_attachments_for_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Vec<DbAttachment>> {
    let rows = sqlx::query_as!(
        DbAttachment,
        r#"
        SELECT id, message_id, account_id, filename, mime_type, size, attachment_id,
               content_id, is_inline
        FROM attachments
        WHERE account_id = ? AND message_id = ?
        ORDER BY filename
        "#,
        account_id,
        message_id
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// The attachment of a message carrying this Content-ID (for `cid:` images).
pub async fn get_by_content_id(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    content_id: &str,
) -> Result<Option<DbAttachment>> {
    let row = sqlx::query_as!(
        DbAttachment,
        r#"
        SELECT id, message_id, account_id, filename, mime_type, size, attachment_id,
               content_id, is_inline
        FROM attachments
        WHERE account_id = ? AND message_id = ? AND content_id = ?
        ORDER BY CAST(id AS INTEGER), id
        LIMIT 1
        "#,
        account_id,
        message_id,
        content_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// One attachment by its row id (the index within the message).
pub async fn get_one(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    id: &str,
) -> Result<Option<DbAttachment>> {
    let row = sqlx::query_as!(
        DbAttachment,
        r#"
        SELECT id, message_id, account_id, filename, mime_type, size, attachment_id,
               content_id, is_inline
        FROM attachments
        WHERE account_id = ? AND message_id = ? AND id = ?
        "#,
        account_id,
        message_id,
        id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_attachments_for_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM attachments WHERE account_id = ? AND message_id = ?",
        account_id,
        message_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Replace a message's attachment metadata (used when a full copy is fetched).
pub async fn replace_for_message(
    conn: &mut SqliteConnection,
    account_id: &str,
    message_id: &str,
    attachments: &[DbAttachment],
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM attachments WHERE account_id = ? AND message_id = ?",
        account_id,
        message_id
    )
    .execute(&mut *conn)
    .await?;
    for att in attachments {
        insert_attachment_tx(conn, att).await?;
    }
    Ok(())
}
