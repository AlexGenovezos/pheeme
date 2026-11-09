//! Calendar commands: thin adapters over [`crate::calendar::service::CalendarService`].

use super::CommandError;
use crate::calendar::service::{CalendarAccessDto, CalendarAccountDto, CalendarEventDto};
use crate::gmail::user_action;
use crate::AppState;
use tauri::State;

/// Every account with its calendar access, settings and calendars (local).
#[tauri::command]
pub async fn calendar_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<CalendarAccountDto>, CommandError> {
    Ok(state.calendar.accounts().await?)
}

/// Events of shown calendars overlapping `[from_ms, to_ms)`, series expanded (local).
#[tauri::command]
pub async fn calendar_events(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
    time_zone: String,
) -> Result<Vec<CalendarEventDto>, CommandError> {
    Ok(state.calendar.events(from_ms, to_ms, &time_zone).await?)
}

/// Show or hide a calendar's events (local).
#[tauri::command]
pub async fn set_calendar_hidden(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    hidden: bool,
) -> Result<(), CommandError> {
    Ok(state
        .calendar
        .set_calendar_hidden(&account_id, &calendar_id, hidden)
        .await?)
}

/// Sync the account's calendars now (after allowing access, or "Check again").
#[tauri::command]
pub async fn calendar_sync_now(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<CalendarAccessDto, CommandError> {
    Ok(user_action(state.calendar.sync_now(&account_id)).await?)
}

/// Calendar mode is (or stopped being) in front.
#[tauri::command]
pub fn set_calendar_foreground(state: State<'_, AppState>, on: bool) {
    state.calendar.set_foreground(on);
}
