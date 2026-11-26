//! Gmail filter commands (Settings › Filters, Filter messages like these): thin adapters over
//! [`crate::filters::FilterService`]. Gmail calls run as user actions, ahead of sync.

use super::CommandError;
use crate::filters::{self, FilterEntryDto, FilterSpec};
use crate::gmail::user_action;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_filters(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<FilterEntryDto>, CommandError> {
    Ok(user_action(state.filters.entries(&account_id)).await?)
}

/// Make a filter; with `apply_to_existing`, its label changes (and Delete it) also go to the
/// conversations already there, once Gmail has the filter.
#[tauri::command]
pub async fn create_filter(
    state: State<'_, AppState>,
    account_id: String,
    spec: FilterSpec,
    apply_to_existing: bool,
) -> Result<FilterEntryDto, CommandError> {
    Ok(user_action(async {
        let created = state.filters.create_spec(&account_id, &spec).await?;
        if apply_to_existing {
            filters::apply_to_existing(&state.mail, &account_id, &spec).await?;
        }
        Ok::<_, crate::mail::MailError>(created)
    })
    .await?)
}

/// Change a filter (Gmail has no update: the new one is made, then the old one deleted).
#[tauri::command]
pub async fn replace_filter(
    state: State<'_, AppState>,
    account_id: String,
    filter_id: String,
    spec: FilterSpec,
    apply_to_existing: bool,
) -> Result<FilterEntryDto, CommandError> {
    Ok(user_action(async {
        let replaced = state
            .filters
            .replace(&account_id, &filter_id, &spec)
            .await?;
        if apply_to_existing {
            filters::apply_to_existing(&state.mail, &account_id, &spec).await?;
        }
        Ok::<_, crate::mail::MailError>(replaced)
    })
    .await?)
}

#[tauri::command]
pub async fn delete_filter(
    state: State<'_, AppState>,
    account_id: String,
    filter_id: String,
) -> Result<(), CommandError> {
    Ok(user_action(state.filters.delete(&account_id, &filter_id)).await?)
}

/// How many cached conversations the form's search matches (`None`: only Gmail can tell).
/// Local, no Gmail call.
#[tauri::command]
pub async fn filter_matches(
    state: State<'_, AppState>,
    account_id: String,
    spec: FilterSpec,
) -> Result<Option<usize>, CommandError> {
    Ok(filters::count_matches(&state.mail, &account_id, &spec).await?)
}

/// The verified addresses a filter can forward to.
#[tauri::command]
pub async fn forwarding_addresses(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<String>, CommandError> {
    Ok(user_action(state.filters.forwarding_addresses(&account_id)).await?)
}
