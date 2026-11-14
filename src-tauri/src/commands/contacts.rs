//! Recipient suggestion commands: thin adapters over [`crate::contacts::ContactService`].

use super::CommandError;
use crate::contacts::{GoogleContactsDto, SuggestionDto, DEFAULT_LIMIT};
use crate::gmail::user_action;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn person_profile(
    state: State<'_, AppState>,
    account_id: String,
    address: String,
    display_tz: String,
) -> Result<crate::contacts::PersonProfile, CommandError> {
    Ok(state
        .contacts
        .person(&state.calendar, &account_id, &address, &display_tz)
        .await?)
}

#[tauri::command]
pub async fn save_person_contact(
    state: State<'_, AppState>,
    account_id: String,
    address: String,
    name: Option<String>,
) -> Result<(), CommandError> {
    user_action(state.contacts.save_person(&account_id, &address, name.as_deref())).await.map_err(|e| {
        if matches!(&e, crate::mail::MailError::Sync(crate::sync::engine::SyncError::Gmail(g)) if g.is_api_disabled()) {
            CommandError { code: "api_disabled".into(), message: "Turn on the People API in your Google Cloud project, then try again.".into() }
        } else { e.into() }
    })
}

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
