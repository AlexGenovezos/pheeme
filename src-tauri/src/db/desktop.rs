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
    /// The user has answered for this account (prompt or Settings); unanswered accounts get the prompt.
    pub asked: bool,
}

pub async fn accounts(pool: &SqlitePool) -> Result<Vec<AccountDesktop>> {
    Ok(sqlx::query_as!(
        AccountDesktop,
        r#"SELECT a.id as account_id, a.email, COALESCE(n.enabled, 0) as "enabled!: bool",
        n.account_id IS NOT NULL as "asked!: bool"
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

/// Record the notification prompt's answer for every account that hasn't had one yet.
pub async fn answer_unasked(pool: &SqlitePool, enabled: bool) -> Result<()> {
    sqlx::query!(
        "INSERT INTO notification_settings(account_id, enabled)
         SELECT id, ? FROM accounts WHERE id NOT IN (SELECT account_id FROM notification_settings)",
        enabled
    )
    .execute(pool)
    .await?;
    Ok(())
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

    #[tokio::test]
    async fn prompt_answer_only_covers_accounts_not_yet_asked() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        let mut other = crate::db::accounts::get_account(&db.pool, "a")
            .await
            .unwrap()
            .unwrap();
        other.id = "b".into();
        other.email = "b@example.com".into();
        crate::db::accounts::insert_account(&db.pool, &other)
            .await
            .unwrap();
        assert!(accounts(&db.pool).await.unwrap().iter().all(|a| !a.asked));
        set_enabled(&db.pool, "a", false).await.unwrap();
        answer_unasked(&db.pool, true).await.unwrap();
        let by_id = |id: &str, all: &[AccountDesktop]| {
            let a = all.iter().find(|a| a.account_id == id).unwrap();
            (a.asked, a.enabled)
        };
        let all = accounts(&db.pool).await.unwrap();
        assert_eq!(by_id("a", &all), (true, false));
        assert_eq!(by_id("b", &all), (true, true));
    }
}
