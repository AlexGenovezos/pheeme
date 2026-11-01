use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbLabel {
    pub id: String,
    pub account_id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    pub label_type: String,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
    pub color_background: Option<String>,
    pub color_text: Option<String>,
    pub messages_total: i64,
    pub messages_unread: i64,
}

pub async fn upsert_label(pool: &SqlitePool, label: &DbLabel) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO labels (
            id, account_id, name, type,
            message_list_visibility, label_list_visibility,
            color_background, color_text,
            messages_total, messages_unread
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            message_list_visibility = excluded.message_list_visibility,
            label_list_visibility = excluded.label_list_visibility,
            color_background = excluded.color_background,
            color_text = excluded.color_text,
            messages_total = excluded.messages_total,
            messages_unread = excluded.messages_unread
        "#,
        label.id,
        label.account_id,
        label.name,
        label.label_type,
        label.message_list_visibility,
        label.label_list_visibility,
        label.color_background,
        label.color_text,
        label.messages_total,
        label.messages_unread,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_labels(pool: &SqlitePool, account_id: &str) -> Result<Vec<DbLabel>> {
    let labels = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread
           FROM labels WHERE account_id = ? ORDER BY name"#,
        account_id
    )
    .fetch_all(pool)
    .await?;
    Ok(labels)
}

pub async fn get_label(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
) -> Result<Option<DbLabel>> {
    let label = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread
           FROM labels WHERE account_id = ? AND id = ?"#,
        account_id,
        label_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(label)
}

pub async fn delete_label(pool: &SqlitePool, account_id: &str, label_id: &str) -> Result<()> {
    sqlx::query!(
        "DELETE FROM labels WHERE account_id = ? AND id = ?",
        account_id,
        label_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_label_unread(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    messages_total: i64,
    messages_unread: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE labels SET messages_total = ?, messages_unread = ? WHERE account_id = ? AND id = ?",
        messages_total,
        messages_unread,
        account_id,
        label_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
