//! App-wide preferences stored in `app_settings`.
use anyhow::Result;
use sqlx::SqlitePool;

const GMAIL_QUOTA: &str = "gmail_quota_per_minute";

/// The Gmail per-user limit the user entered (units per minute), if they changed it.
pub async fn gmail_quota(pool: &SqlitePool) -> Result<Option<u32>> {
    let value = sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = ?", GMAIL_QUOTA)
        .fetch_optional(pool)
        .await?;
    Ok(value.and_then(|v| v.parse().ok()))
}

pub async fn set_gmail_quota(pool: &SqlitePool, per_minute: u32) -> Result<()> {
    let value = per_minute.to_string();
    sqlx::query!(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        GMAIL_QUOTA,
        value
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gmail_quota_persists() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert_eq!(gmail_quota(&db.pool).await.unwrap(), None);
        set_gmail_quota(&db.pool, 15_000).await.unwrap();
        set_gmail_quota(&db.pool, 12_000).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert_eq!(gmail_quota(&reopened).await.unwrap(), Some(12_000));
    }
}
