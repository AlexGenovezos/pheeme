//! Search commands: thin adapters over [`crate::mail::MailService`].

use super::CommandError;
use crate::mail::{GmailSearchPageDto, SearchPageDto, ThreadCursorDto};
use crate::AppState;
use std::collections::HashMap;
use tauri::State;

/// Cached mail matching `query` (Gmail syntax), instantly.
#[tauri::command]
pub async fn search_messages(
    state: State<'_, AppState>,
    account_ids: Vec<String>,
    query: String,
    before: Option<ThreadCursorDto>,
    limit: Option<i64>,
) -> Result<SearchPageDto, CommandError> {
    Ok(state
        .mail
        .search_messages(&account_ids, &query, before, limit)
        .await?)
}

/// Gmail's search, for mail that isn't cached yet.
#[tauri::command]
pub async fn search_gmail(
    state: State<'_, AppState>,
    account_ids: Vec<String>,
    query: String,
    page_tokens: Option<HashMap<String, String>>,
) -> Result<GmailSearchPageDto, CommandError> {
    Ok(state
        .mail
        .search_gmail(&account_ids, &query, page_tokens)
        .await?)
}

#[tauri::command]
pub async fn recent_searches(state: State<'_, AppState>) -> Result<Vec<String>, CommandError> {
    Ok(state.mail.recent_searches().await?)
}

#[tauri::command]
pub async fn add_recent_search(
    state: State<'_, AppState>,
    query: String,
) -> Result<(), CommandError> {
    Ok(state.mail.add_recent_search(&query).await?)
}

/// Forget one recent search, or all of them when `query` is omitted.
#[tauri::command]
pub async fn remove_recent_search(
    state: State<'_, AppState>,
    query: Option<String>,
) -> Result<(), CommandError> {
    Ok(state.mail.remove_recent_search(query.as_deref()).await?)
}
