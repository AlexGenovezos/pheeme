use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteExecutor, SqlitePool};

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
    /// The account's colour, 1..=[`ACCOUNT_COLORS`]: the `--color-account-N` theme token.
    pub color: i64,
}

/// How many account colours there are (`--color-account-1` to `-12` in the themes).
pub const ACCOUNT_COLORS: i64 = 12;

/// The colour a new account gets: the first nobody uses, else the next in turn after `used.len()`.
pub fn free_color(used: &[i64]) -> i64 {
    (1..=ACCOUNT_COLORS)
        .find(|c| !used.contains(c))
        .unwrap_or((used.len() as i64 % ACCOUNT_COLORS) + 1)
}

/// The colours the connected accounts use, for [`free_color`].
pub async fn used_colors(pool: &SqlitePool) -> Result<Vec<i64>> {
    Ok(sqlx::query_scalar!("SELECT color FROM accounts")
        .fetch_all(pool)
        .await?)
}

pub async fn insert_account(pool: &SqlitePool, account: &DbAccount) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO accounts (
            id, email, display_name, profile_photo_url, client_id,
            history_id, created_at, updated_at, color, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
            (SELECT COALESCE(MAX(position) + 1, 0) FROM accounts))
        "#,
        account.id,
        account.email,
        account.display_name,
        account.profile_photo_url,
        account.client_id,
        account.history_id,
        account.created_at,
        account.updated_at,
        account.color,
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
               history_id, created_at, updated_at, color
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
               history_id, created_at, updated_at, color
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
               history_id, created_at, updated_at, color
        FROM accounts ORDER BY position, created_at
        "#
    )
    .fetch_all(pool)
    .await?;
    Ok(accounts)
}

pub async fn update_history_id<'e>(
    ex: impl sqlx::SqliteExecutor<'e>,
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
    .execute(ex)
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

pub async fn delete_account<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<()> {
    sqlx::query!("DELETE FROM accounts WHERE id = ?", account_id)
        .execute(ex)
        .await?;
    Ok(())
}

/// Re-signing in an existing account can switch it to a different OAuth client.
pub async fn update_client_id(
    pool: &SqlitePool,
    account_id: &str,
    client_id: &str,
    updated_at: i64,
) -> Result<()> {
    sqlx::query!(
        "UPDATE accounts SET client_id = ?, updated_at = ? WHERE id = ?",
        client_id,
        updated_at,
        account_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Sets an account's colour (checked by the caller to be 1..=[`ACCOUNT_COLORS`]). False when no
/// such account.
pub async fn set_color(pool: &SqlitePool, account_id: &str, color: i64) -> Result<bool> {
    let done = sqlx::query!(
        "UPDATE accounts SET color = ? WHERE id = ?",
        color,
        account_id
    )
    .execute(pool)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Puts the accounts in `ids`' order. Accounts it leaves out (one connected meanwhile) keep
/// their relative order after the listed ones.
pub async fn reorder(pool: &SqlitePool, ids: &[String]) -> Result<()> {
    let mut tx = super::begin_write(pool).await?;
    let current = sqlx::query_scalar!("SELECT id FROM accounts ORDER BY position, created_at")
        .fetch_all(&mut *tx)
        .await?;
    let listed = ids.iter().filter(|id| current.contains(id));
    let rest = current.iter().filter(|id| !ids.contains(id));
    for (position, id) in listed.chain(rest).enumerate() {
        let position = position as i64;
        sqlx::query!(
            "UPDATE accounts SET position = ? WHERE id = ?",
            position,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn account(id: &str, created_at: i64) -> DbAccount {
        DbAccount {
            id: id.into(),
            email: format!("{id}@example.com"),
            display_name: None,
            profile_photo_url: None,
            client_id: "c".into(),
            history_id: None,
            created_at,
            updated_at: created_at,
            color: 1,
        }
    }

    async fn ids(pool: &SqlitePool) -> Vec<String> {
        list_accounts(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect()
    }

    #[test]
    fn a_new_account_takes_the_first_free_colour_then_cycles() {
        assert_eq!(free_color(&[]), 1);
        assert_eq!(free_color(&[1, 2, 4]), 3);
        let all: Vec<i64> = (1..=12).collect();
        assert_eq!(free_color(&all), 1);
        let more: Vec<i64> = (1..=12).chain([1]).collect();
        assert_eq!(free_color(&more), 2);
    }

    #[tokio::test]
    async fn accounts_list_in_the_order_they_were_put_in() {
        let db = TestDb::new().await;
        let pool = &db.pool;
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            insert_account(pool, &account(id, i as i64)).await.unwrap();
        }
        assert_eq!(ids(pool).await, ["a", "b", "c"]);

        reorder(pool, &["c".into(), "a".into(), "b".into()])
            .await
            .unwrap();
        assert_eq!(ids(pool).await, ["c", "a", "b"]);

        // A new account goes last; one the reorder didn't name keeps its place after the rest.
        insert_account(pool, &account("d", 0)).await.unwrap();
        assert_eq!(ids(pool).await, ["c", "a", "b", "d"]);
        reorder(pool, &["b".into(), "gone".into(), "c".into()])
            .await
            .unwrap();
        assert_eq!(ids(pool).await, ["b", "c", "a", "d"]);
    }

    #[tokio::test]
    async fn an_account_keeps_the_colour_it_was_given() {
        let db = TestDb::new().await;
        let pool = &db.pool;
        insert_account(pool, &account("a", 0)).await.unwrap();
        assert!(set_color(pool, "a", 9).await.unwrap());
        assert!(!set_color(pool, "gone", 9).await.unwrap());
        assert_eq!(get_account(pool, "a").await.unwrap().unwrap().color, 9);
        assert_eq!(used_colors(pool).await.unwrap(), [9]);
    }
}
