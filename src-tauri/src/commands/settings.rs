//! Desktop preferences, the Gmail quota, and queued notification navigation.
use super::CommandError;
use crate::desktop::{self, DesktopSettings, ThreadTarget};
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

#[tauri::command]
pub fn take_notification_target(app: AppHandle) -> Option<ThreadTarget> {
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
