//! Calendar event templates (`event_templates`): rows as stored, `fields` as JSON text.
//! [`crate::calendar::templates`] checks names and fields before anything is written.
use anyhow::Result;
use sqlx::SqliteExecutor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateRow {
    pub id: String,
    pub name: String,
    pub fields: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// Every template, by name (ignoring capitals).
pub async fn list<'e>(ex: impl SqliteExecutor<'e>) -> Result<Vec<TemplateRow>> {
    Ok(sqlx::query_as!(
        TemplateRow,
        r#"SELECT id AS "id!", name, fields, created_ms, updated_ms
           FROM event_templates ORDER BY name COLLATE NOCASE, id"#
    )
    .fetch_all(ex)
    .await?)
}

pub async fn get<'e>(ex: impl SqliteExecutor<'e>, id: &str) -> Result<Option<TemplateRow>> {
    Ok(sqlx::query_as!(
        TemplateRow,
        r#"SELECT id AS "id!", name, fields, created_ms, updated_ms
           FROM event_templates WHERE id = ?"#,
        id
    )
    .fetch_optional(ex)
    .await?)
}

/// The template called `name`, ignoring capitals.
pub async fn by_name<'e>(ex: impl SqliteExecutor<'e>, name: &str) -> Result<Option<TemplateRow>> {
    Ok(sqlx::query_as!(
        TemplateRow,
        r#"SELECT id AS "id!", name, fields, created_ms, updated_ms
           FROM event_templates WHERE name = ? COLLATE NOCASE"#,
        name
    )
    .fetch_optional(ex)
    .await?)
}

pub async fn insert<'e>(ex: impl SqliteExecutor<'e>, row: &TemplateRow) -> Result<()> {
    sqlx::query!(
        "INSERT INTO event_templates (id, name, fields, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?)",
        row.id,
        row.name,
        row.fields,
        row.created_ms,
        row.updated_ms
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// A new name and fields for template `id` (saving over it).
pub async fn update<'e>(
    ex: impl SqliteExecutor<'e>,
    id: &str,
    name: &str,
    fields: &str,
    updated_ms: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE event_templates SET name = ?, fields = ?, updated_ms = ? WHERE id = ?",
        name,
        fields,
        updated_ms,
        id
    )
    .execute(ex)
    .await?;
    Ok(())
}

pub async fn rename<'e>(
    ex: impl SqliteExecutor<'e>,
    id: &str,
    name: &str,
    updated_ms: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE event_templates SET name = ?, updated_ms = ? WHERE id = ?",
        name,
        updated_ms,
        id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Whether there was a template `id` to delete.
pub async fn delete<'e>(ex: impl SqliteExecutor<'e>, id: &str) -> Result<bool> {
    let done = sqlx::query!("DELETE FROM event_templates WHERE id = ?", id)
        .execute(ex)
        .await?;
    Ok(done.rows_affected() > 0)
}
