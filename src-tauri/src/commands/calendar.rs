//! Calendar commands: thin adapters over [`crate::calendar::service::CalendarService`].

use super::timing::{CalendarWriteShown, Call};
use super::CommandError;
use crate::calendar::availability::AvailabilityDto;
use crate::calendar::edit::EventEdit;
use crate::calendar::file::{AddedEvents, CalendarFileDto};
use crate::calendar::invite::InviteDto;
use crate::calendar::service::{
    CalendarAccessDto, CalendarAccountDto, CalendarEventDto, EventDetailDto,
};
use crate::calendar::templates::{self, EventTemplate, TemplateFields};
use crate::calendar::writes::{EditScope, EventRef};
use crate::gmail::calendar::SendUpdates;
use crate::gmail::user_action;
use crate::sync::engine::now_ms;
use crate::AppState;
use tauri::State;

const AREA: &str = "calendar";

/// Every account with its calendar access, settings and calendars (local).
#[tauri::command]
pub async fn calendar_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<CalendarAccountDto>, CommandError> {
    Call::read(AREA, "calendar_accounts")
        .run(async { Ok(state.calendar.accounts().await?) })
        .await
}

/// Events of shown calendars overlapping `[from_ms, to_ms)`, series expanded (local).
#[tauri::command]
pub async fn calendar_events(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
    time_zone: String,
) -> Result<Vec<CalendarEventDto>, CommandError> {
    Call::read(AREA, "calendar_events")
        .with("days", (to_ms - from_ms) / 86_400_000)
        .run(async { Ok(state.calendar.events(from_ms, to_ms, &time_zone).await?) })
        .await
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
    Call::read(AREA, "search_calendar_events")
        .run(async {
            Ok(state
                .calendar
                .search_events(&query, from_ms, to_ms, &time_zone, SEARCH_LIMIT)
                .await?)
        })
        .await
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
    Call::write(AREA, "set_calendar_hidden")
        .account(&account_id)
        .with("hidden", hidden)
        .run(async {
            Ok(state
                .calendar
                .set_calendar_hidden(&account_id, &calendar_id, hidden)
                .await?)
        })
        .await
}

/// Recolour a calendar in the account's Google calendar list (`#rrggbb`). Rejects with
/// `missing_scope` until the calendar-list consent is allowed.
#[tauri::command]
pub async fn set_calendar_color(
    state: State<'_, AppState>,
    account_id: String,
    calendar_id: String,
    background: String,
    foreground: String,
) -> Result<(), CommandError> {
    Call::write(AREA, "set_calendar_color")
        .account(&account_id)
        .run(async {
            Ok(user_action(state.calendar.set_calendar_color(
                &account_id,
                &calendar_id,
                &background,
                &foreground,
            ))
            .await?)
        })
        .await
}

/// Sync the account's calendars now (after allowing access, or "Check again").
#[tauri::command]
pub async fn calendar_sync_now(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<CalendarAccessDto, CommandError> {
    Call::read(AREA, "calendar_sync_now")
        .account(&account_id)
        .run(async { Ok(user_action(state.calendar.sync_now(&account_id)).await?) })
        .await
}

/// When the account and each guest are busy in `[from_ms, to_ms)`, asked of Google now (the
/// event editor's planner). Rejects with `missing_scope` until free/busy access is allowed.
#[tauri::command]
pub async fn calendar_availability(
    state: State<'_, AppState>,
    account_id: String,
    emails: Vec<String>,
    from_ms: i64,
    to_ms: i64,
) -> Result<AvailabilityDto, CommandError> {
    Call::read(AREA, "calendar_availability")
        .account(&account_id)
        .with("people", emails.len() + 1)
        .run(async {
            Ok(user_action(
                state
                    .calendar
                    .availability(&account_id, &emails, from_ms, to_ms),
            )
            .await?)
        })
        .await
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
    Call::read(AREA, "calendar_event_detail")
        .account(&account_id)
        .run(async {
            Ok(state
                .calendar
                .event_detail(&account_id, &calendar_id, &event_id)
                .await?)
        })
        .await
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
    Call::write(AREA, "create_calendar_event")
        .account(&account_id)
        .with("repeats", edit.recurrence.is_some())
        .with("send_updates", send_updates)
        .run(async {
            Ok(user_action(state.calendar.create_event(
                &account_id,
                &calendar_id,
                edit,
                send_updates,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "update_calendar_event")
        .account(&account_id)
        .with("scope", scope)
        .with("send_updates", send_updates)
        .run(async {
            Ok(user_action(state.calendar.update_event(
                &account_id,
                &calendar_id,
                &event_id,
                scope,
                edit,
                send_updates,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "delete_calendar_event")
        .account(&account_id)
        .with("scope", scope)
        .with("send_updates", send_updates)
        .run(async {
            Ok(user_action(state.calendar.delete_event(
                &account_id,
                &calendar_id,
                &event_id,
                scope,
                send_updates,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "move_calendar_event")
        .account(&account_id)
        .with("send_updates", send_updates)
        .run(async {
            Ok(user_action(state.calendar.move_event(
                &account_id,
                &calendar_id,
                &event_id,
                &destination_calendar_id,
                send_updates,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "copy_calendar_event")
        .account(&account_id)
        .with("other_account", account_id != to_account_id)
        .run(async {
            Ok(user_action(state.calendar.copy_event(
                &account_id,
                &calendar_id,
                &event_id,
                &to_account_id,
                &to_calendar_id,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "respond_to_calendar_event")
        .account(&account_id)
        .with("scope", scope)
        .with("response", response.as_str())
        .with("note", comment.is_some())
        .run(async {
            Ok(user_action(state.calendar.respond(
                &account_id,
                &calendar_id,
                &event_id,
                scope,
                &response,
                comment,
            ))
            .await?)
        })
        .await
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
    Call::write(AREA, "respond_to_calendar_invite")
        .account(&account_id)
        .with("response", response.as_str())
        .with("note", comment.is_some())
        .with("import", import.is_some())
        .run(async {
            Ok(user_action(state.calendar.respond_to_invite(
                &account_id,
                &ical_uid,
                &response,
                comment,
                import,
            ))
            .await?)
        })
        .await
}

/// The calendar invitation in a message (Mail's invite card), with the event as it is now on
/// the account's calendar when the cache has it. `None` when the message carries none.
#[tauri::command]
pub async fn message_invite(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
) -> Result<Option<InviteDto>, CommandError> {
    Call::read(AREA, "message_invite")
        .account(&account_id)
        .run(async {
            let invite = state.mail.invite_text(&account_id, &message_id);
            let Some(text) = user_action(invite).await? else {
                return Ok(None);
            };
            Ok(state.calendar.invite(&account_id, &text).await?)
        })
        .await
}

/// Every event in a message's calendar file (Mail's Add to calendar dialog): the `.ics`
/// attachment `attachment_id`, else its invitation. `None` when it holds no event.
#[tauri::command]
pub async fn calendar_file(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: Option<String>,
) -> Result<Option<CalendarFileDto>, CommandError> {
    Call::read(AREA, "calendar_file")
        .account(&account_id)
        .run(async {
            let text =
                state
                    .mail
                    .calendar_file_text(&account_id, &message_id, attachment_id.as_deref());
            let Some(text) = user_action(text).await? else {
                return Ok(None);
            };
            Ok(state.calendar.calendar_file(&account_id, &text).await?)
        })
        .await
}

/// Adds the events with these UIDs from a message's calendar file to a calendar, as plain
/// copies that email nobody (an invitation to the account is answered instead, through
/// `respond_to_calendar_invite`).
#[tauri::command]
pub async fn add_calendar_file_events(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: Option<String>,
    target_account_id: String,
    calendar_id: String,
    uids: Vec<String>,
) -> Result<AddedEvents, CommandError> {
    Call::write(AREA, "add_calendar_file_events")
        .account(&target_account_id)
        .with("events", uids.len())
        .run(async {
            let text =
                state
                    .mail
                    .calendar_file_text(&account_id, &message_id, attachment_id.as_deref());
            let Some(text) = user_action(text).await? else {
                return Err(CommandError {
                    code: "not_found".into(),
                    message: "This email has no calendar file.".into(),
                });
            };
            Ok(user_action(state.calendar.add_calendar_file(
                &account_id,
                &target_account_id,
                &calendar_id,
                &text,
                &uids,
            ))
            .await?)
        })
        .await
}

/// How long a calendar change took to show, timed in the window (`src/calendar/writeTiming.ts`).
#[tauri::command]
pub fn log_calendar_write(report: CalendarWriteShown) {
    report.log();
}

/// Joins a video call: opens its link (an event's or an invitation's) in the default browser.
/// Any web link, as a conference may come from a provider Pheeme doesn't list.
#[tauri::command]
pub fn open_meeting_link(url: String) -> Result<(), CommandError> {
    let Some(url) = crate::calendar::meeting::joinable(&url) else {
        return Err(CommandError {
            code: "invalid_input".into(),
            message: "That isn't a web link to a call.".into(),
        });
    };
    open::that_detached(url.as_str()).map_err(|error| CommandError {
        code: "open_failed".into(),
        message: format!("Couldn't open your browser ({error}). Copy the link instead."),
    })
}

// ── Event templates (local, never Google) ───────────────────────────────────

/// Every saved event template, by name.
#[tauri::command]
pub async fn event_templates(
    state: State<'_, AppState>,
) -> Result<Vec<EventTemplate>, CommandError> {
    Ok(templates::list(&state.db).await?)
}

/// Save an event's details as template `name`. A name in use rejects with `exists`, unless
/// `replace` (the user agreed to save over it).
#[tauri::command]
pub async fn save_event_template(
    state: State<'_, AppState>,
    name: String,
    fields: TemplateFields,
    replace: bool,
) -> Result<EventTemplate, CommandError> {
    Ok(templates::save(&state.db, &name, fields, replace, now_ms()).await?)
}

#[tauri::command]
pub async fn rename_event_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<EventTemplate, CommandError> {
    Ok(templates::rename(&state.db, &id, &name, now_ms()).await?)
}

#[tauri::command]
pub async fn delete_event_template(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), CommandError> {
    Ok(templates::delete(&state.db, &id).await?)
}
