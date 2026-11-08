//! Recipient suggestion commands: thin adapters over [`crate::contacts::ContactService`].

use super::CommandError;
use crate::contacts::{GoogleContactsDto, SuggestionDto, DEFAULT_LIMIT};
use crate::gmail::user_action;
use crate::AppState;
use tauri::State;

/// Addresses matching what's typed in To, Cc or Bcc, best first (local, no Gmail call).
#[tauri::command]
pub async fn suggest_contacts(
    state: State<'_, AppState>,
    account_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SuggestionDto>, CommandError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(50);
    Ok(state.contacts.suggest(&account_id, &query, limit).await?)
}

/// Where the account's Google Contacts stand (local).
#[tauri::command]
pub async fn google_contacts_status(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<GoogleContactsDto, CommandError> {
    Ok(state.contacts.google_status(&account_id).await?)
}

/// Download the account's Google Contacts now (Settings › Contacts, "Check again").
#[tauri::command]
pub async fn refresh_google_contacts(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<GoogleContactsDto, CommandError> {
    Ok(user_action(state.contacts.refresh_google(&account_id)).await?)
}
