//! App-wide preferences stored in `app_settings`.
use anyhow::Result;
use sqlx::SqlitePool;

const GMAIL_QUOTA: &str = "gmail_quota_per_minute";
const TRAY_ICON: &str = "tray_icon";

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

/// Whether the menu bar / notification area icon is shown. On unless the user turned it off.
pub async fn tray_icon(pool: &SqlitePool) -> Result<bool> {
    let value = sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = ?", TRAY_ICON)
        .fetch_optional(pool)
        .await?;
    Ok(value.as_deref() != Some("0"))
}

pub async fn set_tray_icon(pool: &SqlitePool, shown: bool) -> Result<()> {
    let value = if shown { "1" } else { "0" };
    sqlx::query!(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        TRAY_ICON,
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

    #[tokio::test]
    async fn tray_icon_defaults_on_and_persists() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert!(tray_icon(&db.pool).await.unwrap());
        set_tray_icon(&db.pool, false).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert!(!tray_icon(&reopened).await.unwrap());
        set_tray_icon(&reopened, true).await.unwrap();
        assert!(tray_icon(&reopened).await.unwrap());
    }
}
