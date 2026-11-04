//! Persistent per-account notification choices and tray snapshots.
use anyhow::Result;
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AccountDesktop {
    pub account_id: String,
    pub email: String,
    pub enabled: bool,
}

pub async fn accounts(pool: &SqlitePool) -> Result<Vec<AccountDesktop>> {
    Ok(sqlx::query_as!(
        AccountDesktop,
        r#"SELECT a.id as account_id, a.email, COALESCE(n.enabled, 0) as "enabled!: bool"
        FROM accounts a LEFT JOIN notification_settings n ON n.account_id = a.id
        ORDER BY a.email"#
    )
    .fetch_all(pool)
    .await?)
}

pub async fn set_enabled(pool: &SqlitePool, account_id: &str, enabled: bool) -> Result<()> {
    sqlx::query!("INSERT INTO notification_settings(account_id, enabled) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET enabled = excluded.enabled",
        account_id, enabled).execute(pool).await?;
    Ok(())
}

pub async fn unread_threads(pool: &SqlitePool, account_id: &str) -> Result<Vec<String>> {
    // Snapshot the cached conversations before queuing changes; do not sweep newly added threads.
    Ok(sqlx::query_scalar!(
        r#"SELECT id FROM threads WHERE account_id = ? AND unread_count > 0"#,
        account_id
    )
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn notification_choice_persists_and_account_removal_cleans_up() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert!(!accounts(&db.pool).await.unwrap()[0].enabled);
        set_enabled(&db.pool, "a", true).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert!(accounts(&reopened).await.unwrap()[0].enabled);
        set_enabled(&reopened, "a", false).await.unwrap();
        assert!(!accounts(&reopened).await.unwrap()[0].enabled);
        sqlx::query("DELETE FROM accounts WHERE id = 'a'")
            .execute(&reopened)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_settings")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(set_enabled(&reopened, "missing", true).await.is_err());
    }
}
