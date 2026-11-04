//! Thread commands: thin adapters over [`crate::mail::MailService`].

use super::CommandError;
use crate::mail::{ThreadCursorDto, ThreadDetailDto, ThreadPageDto};
use crate::AppState;
use tauri::State;

// Keep the IPC arguments flat, matching the other thread commands.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn list_threads(
    state: State<'_, AppState>,
    account_ids: Vec<String>,
    label_id: String,
    also_label_id: Option<String>,
    before: Option<ThreadCursorDto>,
    limit: Option<i64>,
    unread_only: Option<bool>,
    keep_read: Option<Vec<(String, String)>>,
) -> Result<ThreadPageDto, CommandError> {
    Ok(state
        .mail
        .list_threads(
            &account_ids,
            &label_id,
            also_label_id.as_deref(),
            before,
            limit,
            unread_only
                .unwrap_or(false)
                .then_some(keep_read.as_deref().unwrap_or_default()),
        )
        .await?)
}

#[tauri::command]
pub async fn get_thread(
    state: State<'_, AppState>,
    account_id: String,
    thread_id: String,
) -> Result<ThreadDetailDto, CommandError> {
    Ok(state.mail.get_thread(&account_id, &thread_id).await?)
}

#[tauri::command]
pub async fn modify_threads(
    state: State<'_, AppState>,
    account_id: String,
    thread_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), CommandError> {
    Ok(state
        .mail
        .modify_threads(&account_id, &thread_ids, &add, &remove)
        .await?)
}

#[tauri::command]
pub async fn trash_threads(
    state: State<'_, AppState>,
    account_id: String,
    thread_ids: Vec<String>,
) -> Result<(), CommandError> {
    Ok(state.mail.trash_threads(&account_id, &thread_ids).await?)
}
