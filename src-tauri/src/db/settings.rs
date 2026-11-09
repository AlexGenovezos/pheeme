//! App-wide preferences stored in `app_settings`.
use crate::desktop::NotifySchedule;
use anyhow::Result;
use sqlx::SqlitePool;

const GMAIL_QUOTA: &str = "gmail_quota_per_minute";
const TRAY_ICON: &str = "tray_icon";
const NOTIFY_SCHEDULE: &str = "notify_schedule";
const TELEMETRY: &str = "telemetry";
const TELEMETRY_INSTALL_ID: &str = "telemetry_install_id";
const TELEMETRY_LAST_PING: &str = "telemetry_last_ping_ms";
const ASSISTANT_ENABLED: &str = "assistant_enabled";

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

/// When alerts may appear. Missing or unreadable JSON reads as the default (any time).
pub async fn notify_schedule(pool: &SqlitePool) -> Result<NotifySchedule> {
    Ok(get(pool, NOTIFY_SCHEDULE)
        .await?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

pub async fn set_notify_schedule(pool: &SqlitePool, schedule: &NotifySchedule) -> Result<()> {
    set(pool, NOTIFY_SCHEDULE, &serde_json::to_string(schedule)?).await
}

/// Whether AI assistants may connect (the MCP server runs). Off unless the user turned it on.
pub async fn assistant_enabled(pool: &SqlitePool) -> Result<bool> {
    Ok(get(pool, ASSISTANT_ENABLED).await?.as_deref() == Some("1"))
}

pub async fn set_assistant_enabled(pool: &SqlitePool, enabled: bool) -> Result<()> {
    set(pool, ASSISTANT_ENABLED, if enabled { "1" } else { "0" }).await
}

fn assistant_allow_key(group: &str) -> String {
    format!("assistant_allow.{group}")
}

/// Whether assistants may use a group of write tools (`local_api::Permission`). Off unless the
/// user turned it on.
pub async fn assistant_allows(pool: &SqlitePool, group: &str) -> Result<bool> {
    Ok(get(pool, &assistant_allow_key(group)).await?.as_deref() == Some("1"))
}

pub async fn set_assistant_allows(pool: &SqlitePool, group: &str, allowed: bool) -> Result<()> {
    set(
        pool,
        &assistant_allow_key(group),
        if allowed { "1" } else { "0" },
    )
    .await
}

fn inbox_tabs_key(account_id: &str) -> String {
    format!("inbox_tabs.{account_id}")
}

/// The inbox tabs this account hides (their mail shows under Primary), in no particular
/// order. Anything that isn't one of [`crate::mail::OTHER_CATEGORIES`] is dropped.
pub async fn inbox_tabs(pool: &SqlitePool, account_id: &str) -> Result<Vec<String>> {
    let stored: Vec<String> = get(pool, &inbox_tabs_key(account_id))
        .await?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    Ok(stored
        .into_iter()
        .filter(|l| crate::mail::OTHER_CATEGORIES.contains(&l.as_str()))
        .collect())
}

pub async fn set_inbox_tabs(pool: &SqlitePool, account_id: &str, hidden: &[String]) -> Result<()> {
    set(
        pool,
        &inbox_tabs_key(account_id),
        &serde_json::to_string(hidden)?,
    )
    .await
}

pub async fn delete_inbox_tabs(pool: &SqlitePool, account_id: &str) -> Result<()> {
    delete(pool, &inbox_tabs_key(account_id)).await
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
    async fn notify_schedule_persists_and_bad_json_reads_as_default() {
        use crate::desktop::ScheduleMode;
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert_eq!(
            notify_schedule(&db.pool).await.unwrap(),
            NotifySchedule::default()
        );
        let off = NotifySchedule {
            mode: ScheduleMode::Off,
            ..Default::default()
        };
        set_notify_schedule(&db.pool, &off).await.unwrap();
        assert_eq!(notify_schedule(&db.pool).await.unwrap(), off);
        set(&db.pool, NOTIFY_SCHEDULE, "{").await.unwrap();
        assert_eq!(
            notify_schedule(&db.pool).await.unwrap(),
            NotifySchedule::default()
        );
    }

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

    #[tokio::test]
    async fn assistant_defaults_off_and_persists() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert!(!assistant_enabled(&db.pool).await.unwrap());
        set_assistant_enabled(&db.pool, true).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert!(assistant_enabled(&reopened).await.unwrap());
        set_assistant_enabled(&reopened, false).await.unwrap();
        assert!(!assistant_enabled(&reopened).await.unwrap());

        assert!(!assistant_allows(&reopened, "organize").await.unwrap());
        set_assistant_allows(&reopened, "organize", true)
            .await
            .unwrap();
        assert!(assistant_allows(&reopened, "organize").await.unwrap());
        assert!(!assistant_allows(&reopened, "filters").await.unwrap());
        set_assistant_allows(&reopened, "organize", false)
            .await
            .unwrap();
        assert!(!assistant_allows(&reopened, "organize").await.unwrap());
    }

    #[tokio::test]
    async fn inbox_tabs_round_trip_and_drop_unknown() {
        let db = crate::db::test_support::TestDb::with_account("a").await;
        assert!(inbox_tabs(&db.pool, "a").await.unwrap().is_empty());
        let hidden = ["CATEGORY_SOCIAL", "CATEGORY_PERSONAL", "X"].map(String::from);
        set_inbox_tabs(&db.pool, "a", &hidden).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert_eq!(
            inbox_tabs(&reopened, "a").await.unwrap(),
            ["CATEGORY_SOCIAL"]
        );
        assert!(inbox_tabs(&reopened, "b").await.unwrap().is_empty());

        delete_inbox_tabs(&reopened, "a").await.unwrap();
        assert!(inbox_tabs(&reopened, "a").await.unwrap().is_empty());
    }
}
