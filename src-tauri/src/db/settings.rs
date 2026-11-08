//! App-wide preferences stored in `app_settings`.
use anyhow::Result;
use sqlx::SqlitePool;

const GMAIL_QUOTA: &str = "gmail_quota_per_minute";
const TRAY_ICON: &str = "tray_icon";
const TELEMETRY: &str = "telemetry";
const TELEMETRY_INSTALL_ID: &str = "telemetry_install_id";
const TELEMETRY_LAST_PING: &str = "telemetry_last_ping_ms";

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

/// Whether the daily anonymous usage ping is sent. On unless the user turned it off.
pub async fn telemetry(pool: &SqlitePool) -> Result<bool> {
    Ok(get(pool, TELEMETRY).await?.as_deref() != Some("0"))
}

/// Turning the ping off forgets the install ID and when it last pinged, so turning it back
/// on later starts a new, unrelated ID.
pub async fn set_telemetry(pool: &SqlitePool, enabled: bool) -> Result<()> {
    set(pool, TELEMETRY, if enabled { "1" } else { "0" }).await?;
    if !enabled {
        delete(pool, TELEMETRY_INSTALL_ID).await?;
        delete(pool, TELEMETRY_LAST_PING).await?;
    }
    Ok(())
}

/// The random install ID the ping carries, created on first use.
pub async fn telemetry_install_id(pool: &SqlitePool) -> Result<String> {
    if let Some(id) = get(pool, TELEMETRY_INSTALL_ID).await? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set(pool, TELEMETRY_INSTALL_ID, &id).await?;
    Ok(id)
}

/// When the last ping was accepted (ms since the epoch).
pub async fn telemetry_last_ping(pool: &SqlitePool) -> Result<Option<i64>> {
    Ok(get(pool, TELEMETRY_LAST_PING)
        .await?
        .and_then(|v| v.parse().ok()))
}

pub async fn set_telemetry_last_ping(pool: &SqlitePool, at_ms: i64) -> Result<()> {
    set(pool, TELEMETRY_LAST_PING, &at_ms.to_string()).await
}

async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = ?", key)
            .fetch_optional(pool)
            .await?,
    )
}

async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query!(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn delete(pool: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query!("DELETE FROM app_settings WHERE key = ?", key)
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

    #[tokio::test]
    async fn telemetry_defaults_on_and_turning_it_off_forgets_the_id() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert!(telemetry(&db.pool).await.unwrap());
        let id = telemetry_install_id(&db.pool).await.unwrap();
        assert_eq!(telemetry_install_id(&db.pool).await.unwrap(), id);
        set_telemetry_last_ping(&db.pool, 1234).await.unwrap();
        assert_eq!(telemetry_last_ping(&db.pool).await.unwrap(), Some(1234));

        set_telemetry(&db.pool, false).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert!(!telemetry(&reopened).await.unwrap());
        assert_eq!(telemetry_last_ping(&reopened).await.unwrap(), None);

        set_telemetry(&reopened, true).await.unwrap();
        assert!(telemetry(&reopened).await.unwrap());
        assert_ne!(telemetry_install_id(&reopened).await.unwrap(), id);
    }
}
