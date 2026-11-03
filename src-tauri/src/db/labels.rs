use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
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
    pub threads_total: i64,
    pub threads_unread: i64,
}

/// Insert or update a label's identity and appearance. Counters are only written on insert;
/// `update_counts` owns them afterwards (`labels.list` doesn't return counters).
pub async fn upsert_label_tx(conn: &mut SqliteConnection, label: &DbLabel) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO labels (
            id, account_id, name, type,
            message_list_visibility, label_list_visibility,
            color_background, color_text,
            messages_total, messages_unread, threads_total, threads_unread
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            message_list_visibility = excluded.message_list_visibility,
            label_list_visibility = excluded.label_list_visibility,
            color_background = excluded.color_background,
            color_text = excluded.color_text
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
        label.threads_total,
        label.threads_unread,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_label(pool: &SqlitePool, label: &DbLabel) -> Result<()> {
    let mut conn = pool.acquire().await?;
    upsert_label_tx(&mut conn, label).await
}

/// Make the account's labels exactly `labels`: upsert each, delete the rest.
pub async fn replace_labels(
    conn: &mut SqliteConnection,
    account_id: &str,
    labels: &[DbLabel],
) -> Result<()> {
    for label in labels {
        upsert_label_tx(conn, label).await?;
    }
    let keep = serde_json::to_string(&labels.iter().map(|l| &l.id).collect::<Vec<_>>())?;
    sqlx::query!(
        "DELETE FROM labels WHERE account_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
        account_id,
        keep
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn update_counts(
    conn: &mut SqliteConnection,
    account_id: &str,
    label_id: &str,
    counts: LabelCounts,
) -> Result<()> {
    sqlx::query!(
        r#"UPDATE labels SET messages_total = ?, messages_unread = ?, threads_total = ?, threads_unread = ?
           WHERE account_id = ? AND id = ?"#,
        counts.messages_total,
        counts.messages_unread,
        counts.threads_total,
        counts.threads_unread,
        account_id,
        label_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LabelCounts {
    pub messages_total: i64,
    pub messages_unread: i64,
    pub threads_total: i64,
    pub threads_unread: i64,
}

pub async fn get_labels<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<Vec<DbLabel>> {
    let labels = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread,
           threads_total, threads_unread
           FROM labels WHERE account_id = ? ORDER BY name"#,
        account_id
    )
    .fetch_all(ex)
    .await?;
    Ok(labels)
}

pub async fn get_label<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    label_id: &str,
) -> Result<Option<DbLabel>> {
    let label = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread,
           threads_total, threads_unread
           FROM labels WHERE account_id = ? AND id = ?"#,
        account_id,
        label_id
    )
    .fetch_optional(ex)
    .await?;
    Ok(label)
}
