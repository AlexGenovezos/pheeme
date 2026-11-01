use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbAccount {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub profile_photo_url: Option<String>,
    pub client_id: String,
    pub history_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn insert_account(pool: &SqlitePool, account: &DbAccount) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO accounts (
            id, email, display_name, profile_photo_url, client_id,
            history_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        account.id,
        account.email,
        account.display_name,
        account.profile_photo_url,
        account.client_id,
        account.history_id,
        account.created_at,
        account.updated_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_account(pool: &SqlitePool, account_id: &str) -> Result<Option<DbAccount>> {
    let account = sqlx::query_as!(
        DbAccount,
        r#"
        SELECT id, email, display_name, profile_photo_url, client_id,
               history_id, created_at, updated_at
        FROM accounts WHERE id = ?
        "#,
        account_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(account)
}

pub async fn get_account_by_email(pool: &SqlitePool, email: &str) -> Result<Option<DbAccount>> {
    let account = sqlx::query_as!(
        DbAccount,
        r#"
        SELECT id, email, display_name, profile_photo_url, client_id,
               history_id, created_at, updated_at
        FROM accounts WHERE email = ?
        "#,
        email
    )
    .fetch_optional(pool)
    .await?;
    Ok(account)
}

pub async fn list_accounts(pool: &SqlitePool) -> Result<Vec<DbAccount>> {
    let accounts = sqlx::query_as!(
        DbAccount,
        r#"
        SELECT id, email, display_name, profile_photo_url, client_id,
               history_id, created_at, updated_at
        FROM accounts ORDER BY created_at ASC
        "#
    )
    .fetch_all(pool)
    .await?;
    Ok(accounts)
}

pub async fn update_history_id(
    pool: &SqlitePool,
    account_id: &str,
    history_id: &str,
    updated_at: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE accounts SET history_id = ?, updated_at = ? WHERE id = ?",
        history_id,
        updated_at,
        account_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_profile(
    pool: &SqlitePool,
    account_id: &str,
    display_name: Option<&str>,
    profile_photo_url: Option<&str>,
    updated_at: i64,
) -> Result<()> {
    sqlx::query!(
        r#"
        UPDATE accounts
        SET display_name = ?, profile_photo_url = ?, updated_at = ?
        WHERE id = ?
        "#,
        display_name,
        profile_photo_url,
        updated_at,
        account_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_account(pool: &SqlitePool, account_id: &str) -> Result<()> {
    sqlx::query!("DELETE FROM accounts WHERE id = ?", account_id)
        .execute(pool)
        .await?;
    Ok(())
}
