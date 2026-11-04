//! Desktop preferences and queued notification navigation.
use super::CommandError;
use crate::desktop::{self, DesktopSettings, ThreadTarget};
use tauri::AppHandle;

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

#[tauri::command]
pub fn take_notification_target(app: AppHandle) -> Option<ThreadTarget> {
    desktop::take_target(&app)
}
