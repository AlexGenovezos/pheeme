//! Thin IPC adapters for the Drive service.
use super::CommandError;
use crate::gmail::drive::{DriveFile, DrivePage};
use crate::gmail::user_action;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn drive_files(
    state: State<'_, AppState>,
    account_id: String,
    query: String,
    page_token: Option<String>,
) -> Result<DrivePage, CommandError> {
    Ok(user_action(
        state
            .drive
            .files(&account_id, &query, page_token.as_deref()),
    )
    .await?)
}

#[tauri::command]
pub async fn save_attachment_to_drive(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<DriveFile, CommandError> {
    Ok(user_action(
        state
            .drive
            .save_attachment(&account_id, &message_id, &attachment_id),
    )
    .await?)
}
