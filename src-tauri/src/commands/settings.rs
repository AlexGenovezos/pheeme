//! Desktop preferences, the Gmail quota, and queued notification navigation.
use super::CommandError;
use crate::desktop::{self, DesktopSettings, NotifySchedule, NotifyTarget};
use crate::AppState;
use tauri::{AppHandle, State};

fn error(error: anyhow::Error) -> CommandError {
    CommandError {
        code: "desktop_settings".into(),
        message: error.to_string(),
    }
}

#[tauri::command]
pub async fn desktop_settings(app: AppHandle) -> Result<DesktopSettings, CommandError> {
    desktop::settings(&app).await.map_err(error)
}

#[tauri::command]
pub async fn set_account_notifications(
    app: AppHandle,
    account_id: String,
    enabled: bool,
) -> Result<DesktopSettings, CommandError> {
    desktop::set_notifications(&app, &account_id, enabled)
        .await
        .map_err(error)
}

/// Answer the "turn on notifications?" prompt for accounts that haven't been asked.
#[tauri::command]
pub async fn answer_notification_prompt(
    app: AppHandle,
    enable: bool,
) -> Result<DesktopSettings, CommandError> {
    desktop::answer_prompt(&app, enable).await.map_err(error)
}

#[tauri::command]
pub async fn set_tray_icon(app: AppHandle, shown: bool) -> Result<DesktopSettings, CommandError> {
    desktop::set_tray_icon(&app, shown).await.map_err(error)
}

/// Choose when alerts may appear (any time, work hours or off) for every account.
#[tauri::command]
pub async fn set_notification_schedule(
    app: AppHandle,
    schedule: NotifySchedule,
) -> Result<DesktopSettings, CommandError> {
    desktop::set_schedule(&app, schedule).await.map_err(error)
}

/// Turn event reminder notifications on or off (Settings › Notifications).
#[tauri::command]
pub async fn set_calendar_reminders(
    app: AppHandle,
    enabled: bool,
) -> Result<DesktopSettings, CommandError> {
    desktop::set_calendar_reminders(&app, enabled)
        .await
        .map_err(error)
}

#[tauri::command]
pub fn take_notification_target(app: AppHandle) -> Option<NotifyTarget> {
    desktop::take_target(&app)
}

/// The Gmail per-user limit (quota units per minute) sync paces itself by.
#[tauri::command]
pub fn gmail_quota(state: State<'_, AppState>) -> u32 {
    state.gmail_quota.get()
}

/// Change the Gmail limit; every account's client follows at once. Out-of-range values are
/// clamped, and the stored value is returned.
#[tauri::command]
pub async fn set_gmail_quota(
    state: State<'_, AppState>,
    per_minute: u32,
) -> Result<u32, CommandError> {
    let stored = crate::gmail::QuotaSetting::new(per_minute).get();
    crate::db::settings::set_gmail_quota(&state.db, stored)
        .await
        .map_err(|e| CommandError {
            code: "settings".into(),
            message: e.to_string(),
        })?;
    Ok(state.gmail_quota.set(stored))
}

/// What `account_id`'s Gmail client spent in each of the last 60 minutes, by source, and how
/// often Gmail refused it, against the user's limit (Settings › Accounts).
#[tauri::command]
pub fn gmail_quota_usage(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<crate::gmail::UsageReport, CommandError> {
    Ok(state
        .gmail_usage
        .report(&account_id, state.gmail_quota.get()))
}

/// Whether the daily anonymous usage ping is on (Settings › Diagnostics, the welcome screen).
#[tauri::command]
pub async fn telemetry_enabled(state: State<'_, AppState>) -> Result<bool, CommandError> {
    crate::db::settings::telemetry(&state.db)
        .await
        .map_err(settings_error)
}

/// Turn the ping on or off; off also forgets the install ID. Returns the stored choice.
#[tauri::command]
pub async fn set_telemetry(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, CommandError> {
    crate::db::settings::set_telemetry(&state.db, enabled)
        .await
        .map_err(settings_error)?;
    tracing::info!(
        enabled,
        "anonymous usage ping turned {}",
        if enabled { "on" } else { "off" }
    );
    Ok(enabled)
}

fn settings_error(e: anyhow::Error) -> CommandError {
    CommandError {
        code: "settings".into(),
        message: e.to_string(),
    }
}
