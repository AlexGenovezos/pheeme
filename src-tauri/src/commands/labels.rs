//! Label commands: thin adapters over [`crate::mail::MailService`].

use super::CommandError;
use crate::mail::{CountDto, LabelDto};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_labels(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<LabelDto>, CommandError> {
    Ok(state.mail.list_labels(&account_id).await?)
}

/// Unread conversations in Inbox and each category tab, across accounts.
#[tauri::command]
pub async fn mailbox_counts(
    state: State<'_, AppState>,
    account_ids: Vec<String>,
) -> Result<Vec<CountDto>, CommandError> {
    Ok(state.mail.mailbox_counts(&account_ids).await?)
}
