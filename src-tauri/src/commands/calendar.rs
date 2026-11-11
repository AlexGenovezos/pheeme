//! Calendar commands: thin adapters over [`crate::calendar::service::CalendarService`].

use super::CommandError;
use crate::calendar::edit::EventEdit;
use crate::calendar::invite::InviteDto;
use crate::calendar::service::{
    CalendarAccessDto, CalendarAccountDto, CalendarEventDto, EventDetailDto,
};
use crate::calendar::writes::{EditScope, EventRef};
use crate::gmail::calendar::SendUpdates;
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

/// Events of shown calendars in `[from_ms, to_ms)` matching every word of `query` (local).
#[tauri::command]
pub async fn search_calendar_events(
    state: State<'_, AppState>,
    query: String,
    from_ms: i64,
    to_ms: i64,
    time_zone: String,
) -> Result<Vec<CalendarEventDto>, CommandError> {
    Ok(state
        .calendar
        .search_events(&query, from_ms, to_ms, &time_zone, SEARCH_LIMIT)
        .await?)
}

/// The most events a calendar search answers with.
const SEARCH_LIMIT: usize = 500;

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

/// Calendar mode is (or stopped being) in front: calendars and tasks are checked more often.
#[tauri::command]
pub fn set_calendar_foreground(state: State<'_, AppState>, on: bool) {
    state.calendar.set_foreground(on);
    state.tasks.set_foreground(on);
}

/// The full detail of one event or occurrence (local).
#[tauri::command]
pub async fn calendar_event_detail(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
) -> Result<EventDetailDto, CommandError> {
    Ok(state
        .calendar
        .event_detail(&account_id, &calendar_id, &event_id)
        .await?)
}

/// Create an event.
#[tauri::command]
pub async fn create_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    edit: EventEdit,
    send_updates: SendUpdates,
) -> Result<EventRef, CommandError> {
    Ok(user_action(
        state
            .calendar
            .create_event(&account_id, &calendar_id, edit, send_updates),
    )
    .await?)
}

/// Change an event, or the occurrences of a series `scope` names.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
    scope: EditScope,
    edit: EventEdit,
    send_updates: SendUpdates,
) -> Result<EventRef, CommandError> {
    Ok(user_action(state.calendar.update_event(
        &account_id,
        &calendar_id,
        &event_id,
        scope,
        edit,
        send_updates,
    ))
    .await?)
}

/// Delete an event, or the occurrences of a series `scope` names.
#[tauri::command]
pub async fn delete_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
    scope: EditScope,
    send_updates: SendUpdates,
) -> Result<(), CommandError> {
    Ok(user_action(state.calendar.delete_event(
        &account_id,
        &calendar_id,
        &event_id,
        scope,
        send_updates,
    ))
    .await?)
}

/// Move an event (or whole series) to another calendar of the same account.
#[tauri::command]
pub async fn move_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
    destination_calendar_id: String,
    send_updates: SendUpdates,
) -> Result<EventRef, CommandError> {
    Ok(user_action(state.calendar.move_event(
        &account_id,
        &calendar_id,
        &event_id,
        &destination_calendar_id,
        send_updates,
    ))
    .await?)
}

/// Copy an event to a calendar of any account (Duplicate copies to the same calendar).
#[tauri::command]
pub async fn copy_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
    to_account_id: String,
    to_calendar_id: String,
) -> Result<EventRef, CommandError> {
    Ok(user_action(state.calendar.copy_event(
        &account_id,
        &calendar_id,
        &event_id,
        &to_account_id,
        &to_calendar_id,
    ))
    .await?)
}

/// Answer an invitation: `accepted`, `tentative` or `declined`.
#[tauri::command]
pub async fn respond_to_calendar_event(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    event_id: String,
    scope: EditScope,
    response: String,
    comment: Option<String>,
) -> Result<EventRef, CommandError> {
    Ok(user_action(state.calendar.respond(
        &account_id,
        &calendar_id,
        &event_id,
        scope,
        &response,
        comment,
    ))
    .await?)
}

/// Answer the invitation with this iCalendar UID (Mail's invite card), importing it if needed.
#[tauri::command]
pub async fn respond_to_calendar_invite(
    state: State<'_, AppState>,
    account_id: String,
    ical_uid: String,
    response: String,
    comment: Option<String>,
    import: Option<serde_json::Value>,
) -> Result<EventRef, CommandError> {
    Ok(user_action(state.calendar.respond_to_invite(
        &account_id,
        &ical_uid,
        &response,
        comment,
        import,
    ))
    .await?)
}

/// The calendar invitation in a message (Mail's invite card), with the event as it is now on
/// the account's calendar when the cache has it. `None` when the message carries none.
#[tauri::command]
pub async fn message_invite(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
) -> Result<Option<InviteDto>, CommandError> {
    let Some(text) = user_action(state.mail.invite_text(&account_id, &message_id)).await? else {
        return Ok(None);
    };
    Ok(state.calendar.invite(&account_id, &text).await?)
}
