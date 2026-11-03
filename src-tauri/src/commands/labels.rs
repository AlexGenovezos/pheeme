//! Label commands: thin adapters over [`crate::mail::MailService`].

use super::CommandError;
use crate::mail::{CountDto, LabelCountDto, LabelDto};
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

/// Unread and total conversations per label of one account, counted from the local cache.
#[tauri::command]
pub async fn label_counts(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<LabelCountDto>, CommandError> {
    Ok(state.mail.label_counts(&account_id).await?)
}
