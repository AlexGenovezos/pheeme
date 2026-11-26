//! Gmail filter commands (Settings › Filters, Filter messages like these): thin adapters over
//! [`crate::filters::FilterService`]. Gmail calls run as user actions, ahead of sync.

use super::CommandError;
use crate::filters::{self, FilterEntryDto, FilterSpec, SavedFilterDto};
use crate::gmail::user_action;
use crate::mail::MailError;
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
/// conversations already there, once Gmail has the filter. A failure there doesn't undo the
/// filter: it comes back as `apply_error`.
#[tauri::command]
pub async fn create_filter(
    state: State<'_, AppState>,
    account_id: String,
    spec: FilterSpec,
    apply_to_existing: bool,
) -> Result<SavedFilterDto, CommandError> {
    let filter = user_action(state.filters.create_spec(&account_id, &spec)).await?;
    Ok(applied(&state, &account_id, &spec, apply_to_existing, filter).await)
}

/// Change a filter (Gmail has no update: the new one is made, then the old one deleted).
#[tauri::command]
pub async fn replace_filter(
    state: State<'_, AppState>,
    account_id: String,
    filter_id: String,
    spec: FilterSpec,
    apply_to_existing: bool,
) -> Result<SavedFilterDto, CommandError> {
    let filter = user_action(state.filters.replace(&account_id, &filter_id, &spec)).await?;
    Ok(applied(&state, &account_id, &spec, apply_to_existing, filter).await)
}

/// The saved filter, after applying it to existing mail when asked.
async fn applied(
    state: &AppState,
    account_id: &str,
    spec: &FilterSpec,
    apply: bool,
    filter: FilterEntryDto,
) -> SavedFilterDto {
    let mut apply_error = None;
    if apply {
        let result: Result<(), MailError> =
            user_action(filters::apply_to_existing(&state.mail, account_id, spec)).await;
        if let Err(e) = result {
            tracing::warn!(account = account_id, filter = filter.id, error = %e, "couldn't apply a saved filter to existing mail");
            apply_error = Some(e.to_string());
        }
    }
    SavedFilterDto {
        filter,
        apply_error,
    }
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
