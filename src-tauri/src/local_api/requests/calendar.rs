//! The calendar tools: reads need only the main switch, changes the Calendar switch. Their
//! arguments, log summaries and descriptions for clients.

use super::{account_prop, object, on, write_account_prop, ToolDef};
use serde::Deserialize;
use serde_json::{json, Value};

/// Events listed per call by default, and at most.
pub const DEFAULT_EVENTS: i64 = 50;
pub const MAX_EVENTS: i64 = 250;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListEvents {
    /// A date or date-time; the start of today when omitted.
    pub from: Option<String>,
    /// A date (that whole day counts) or date-time; a week after `from` when omitted.
    pub to: Option<String>,
    /// Words that must all appear in the title, place, description or guests.
    pub query: Option<String>,
    pub account: Option<String>,
    pub calendar_id: Option<String>,
    pub time_zone: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetEvent {
    pub event_id: String,
    /// The account's primary calendar when omitted.
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindFreeTime {
    pub from: Option<String>,
    pub to: Option<String>,
    pub duration_minutes: Option<i64>,
    /// `HH:MM`, default 09:00.
    pub day_start: Option<String>,
    /// `HH:MM`, default 17:00.
    pub day_end: Option<String>,
    #[serde(default)]
    pub weekends: bool,
    pub account: Option<String>,
    pub time_zone: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateEvent {
    pub account: Option<String>,
    pub calendar_id: Option<String>,
    pub title: String,
    pub start: String,
    pub end: Option<String>,
    pub time_zone: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub guests: Vec<String>,
    #[serde(default)]
    pub optional_guests: Vec<String>,
    #[serde(default)]
    pub add_meet: bool,
    #[serde(default)]
    pub repeat: Vec<String>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    /// this (default), following or all, for a repeating event.
    pub scope: Option<String>,
    pub title: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub time_zone: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub add_guests: Vec<String>,
    #[serde(default)]
    pub remove_guests: Vec<String>,
    /// true adds a Google Meet link, false removes it.
    pub meet: Option<bool>,
    /// Repeat rules; `[]` stops it repeating.
    pub repeat: Option<Vec<String>>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    pub scope: Option<String>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RespondToEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    /// accepted, tentative or declined (yes, maybe, no also read).
    pub response: String,
    pub comment: Option<String>,
    /// this (default) or all, for a repeating event.
    pub scope: Option<String>,
}

impl ListEvents {
    pub(super) fn summary(&self) -> String {
        format!(
            "events {} to {}{}{}",
            self.from.as_deref().unwrap_or("today"),
            self.to.as_deref().unwrap_or("a week on"),
            self.query
                .as_deref()
                .map(|q| format!(" matching \"{q}\""))
                .unwrap_or_default(),
            on(&self.account)
        )
    }
}

impl GetEvent {
    pub(super) fn summary(&self) -> String {
        format!("event {}{}", self.event_id, on(&self.account))
    }
}

impl FindFreeTime {
    pub(super) fn summary(&self) -> String {
        format!(
            "free {} min, {} to {}{}",
            self.duration_minutes.unwrap_or(30),
            self.from.as_deref().unwrap_or("now"),
            self.to.as_deref().unwrap_or("a week on"),
            on(&self.account)
        )
    }
}

impl CreateEvent {
    pub(super) fn summary(&self) -> String {
        format!(
            "event \"{}\" at {}{}{}",
            self.title,
            self.start,
            guests(
                self.guests.len() + self.optional_guests.len(),
                self.notify_guests
            ),
            on(&self.account)
        )
    }
}

impl UpdateEvent {
    pub(super) fn summary(&self) -> String {
        format!(
            "event {}{}{}",
            self.event_id,
            guests(self.add_guests.len(), self.notify_guests),
            on(&self.account)
        )
    }
}

impl DeleteEvent {
    pub(super) fn summary(&self) -> String {
        format!(
            "event {}{}{}",
            self.event_id,
            if self.notify_guests {
                ", guests told"
            } else {
                ""
            },
            on(&self.account)
        )
    }
}

impl RespondToEvent {
    pub(super) fn summary(&self) -> String {
        format!(
            "{} to event {}{}",
            self.response,
            self.event_id,
            on(&self.account)
        )
    }
}

/// ", 2 guests (emailed)" for the log; nothing without guests.
fn guests(n: usize, notified: bool) -> String {
    match n {
        0 => String::new(),
        n => format!(
            ", {n} guest{}{}",
            if n == 1 { "" } else { "s" },
            if notified { " (emailed)" } else { "" }
        ),
    }
}

fn time_zone_prop() -> Value {
    json!({
        "type": "string",
        "description": "An IANA time zone (Europe/Paris) for reading and writing times. Default: the \
            user's Google Calendar time zone."
    })
}

fn event_ref_props() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({
        "event_id": { "type": "string", "description": "event_id from list_events." },
        "calendar_id": { "type": "string", "description": "calendar_id from list_events (default the primary calendar)." },
        "account": write_account_prop()
    }) else {
        unreachable!()
    };
    map
}

const TIME_HELP: &str = "A date-time (2026-11-20T15:00, read in time_zone, or with an offset) or, \
    for an all-day event, a date (2026-11-20).";

const SCOPE_HELP: &str = "For a repeating event: this (the default: just this occurrence), \
    following (this and later ones) or all.";

const NOTIFY_HELP: &str = "Email the guests about it (default false: the event changes on \
    their calendars without an email). Ask the user before setting it.";

/// The calendar tools: reads need only the main switch, changes the Calendar switch.
pub(super) fn tools() -> Vec<ToolDef> {
    let guests = json!({ "type": "array", "items": { "type": "string" }, "description": "Email addresses." });
    vec![
        ToolDef {
            name: "list_calendars",
            title: "List calendars",
            description: "Each account's Google calendars (id, name, primary, whether the user can \
                change them), its Calendar time zone, and whether Pheeme may read its calendar \
                (access: on; otherwise the note says what the user must do).",
            input_schema: json!({
                "type": "object",
                "properties": { "account": account_prop() },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({}),
        },
        ToolDef {
            name: "list_events",
            title: "List events",
            description: "Events between from and to (default the next 7 days from the start of \
                today), repeating events expanded, from Pheeme's local copy of the calendars the \
                user shows. With query, only events whose title, place, description or guests \
                contain every word. Times are in the user's Calendar time zone unless time_zone \
                says otherwise.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "A date or date-time." },
                    "to": { "type": "string", "description": "A date (that whole day counts) or date-time." },
                    "query": { "type": "string" },
                    "account": account_prop(),
                    "calendar_id": { "type": "string", "description": "Only this calendar." },
                    "time_zone": time_zone_prop(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_EVENTS, "description": format!("Events (default {DEFAULT_EVENTS}).") }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "from": "2026-11-16", "to": "2026-11-20", "query": "standup" }),
        },
        ToolDef {
            name: "get_event",
            title: "Read an event",
            description: "One event in full: description, organizer, guests and their answers, \
                video call, repeat rule, and what the user may do with it (edit, answer, delete).",
            input_schema: object(event_ref_props(), json!({ "time_zone": time_zone_prop() }), &["event_id"]),
            read_only: true,
            destructive: false,
            example: json!({ "event_id": "e1", "calendar_id": "me@example.com" }),
        },
        ToolDef {
            name: "find_free_time",
            title: "Find free time",
            description: "Free slots of at least duration_minutes (default 30) between from and to \
                (default now to 7 days on), inside working hours (day_start to day_end, default \
                09:00 to 17:00, weekdays unless weekends is true). Busy means a timed event the user \
                hasn't declined and that isn't marked free, on any shown calendar of the accounts \
                (all, or account); all-day events don't count.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "A date or date-time." },
                    "to": { "type": "string", "description": "A date (that whole day counts) or date-time." },
                    "duration_minutes": { "type": "integer", "minimum": 5, "maximum": 1440 },
                    "day_start": { "type": "string", "description": "HH:MM." },
                    "day_end": { "type": "string", "description": "HH:MM." },
                    "weekends": { "type": "boolean" },
                    "account": account_prop(),
                    "time_zone": time_zone_prop(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Slots (default 20)." }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "from": "2026-11-16", "to": "2026-11-18", "duration_minutes": 60 }),
        },
        ToolDef {
            name: "create_event",
            title: "Create an event",
            description: "Create an event on a calendar (default the account's primary). end \
                defaults to an hour after start (the next day for an all-day event). Guests are \
                invited, but only emailed with notify_guests.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": write_account_prop(),
                    "calendar_id": { "type": "string" },
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": TIME_HELP },
                    "end": { "type": "string", "description": TIME_HELP },
                    "time_zone": time_zone_prop(),
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "guests": guests,
                    "optional_guests": guests,
                    "add_meet": { "type": "boolean", "description": "Add a Google Meet link." },
                    "repeat": { "type": "array", "items": { "type": "string" }, "description": "RFC 5545 lines, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO." },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                },
                "required": ["title", "start"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "title": "Lunch", "start": "2026-11-20T12:30", "guests": ["sam@example.com"] }),
        },
        ToolDef {
            name: "update_event",
            title: "Change an event",
            description: "Change an event the user may edit: give only what changes. A new start \
                alone keeps the length. add_guests and remove_guests change the guest list (those \
                already there keep their answers). Empty description or location clears it.",
            input_schema: object(
                event_ref_props(),
                json!({
                    "scope": { "type": "string", "enum": ["this", "following", "all"], "description": SCOPE_HELP },
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": TIME_HELP },
                    "end": { "type": "string", "description": TIME_HELP },
                    "time_zone": time_zone_prop(),
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "add_guests": guests,
                    "remove_guests": guests,
                    "meet": { "type": "boolean", "description": "true adds a Google Meet link, false removes it." },
                    "repeat": { "type": "array", "items": { "type": "string" }, "description": "New repeat rules; [] stops it repeating." },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                }),
                &["event_id"],
            ),
            read_only: false,
            destructive: false,
            example: json!({ "event_id": "e1", "start": "2026-11-20T14:00", "add_guests": ["sam@example.com"] }),
        },
        ToolDef {
            name: "delete_event",
            title: "Delete an event",
            description: "Delete an event (for one the user was only invited to, it leaves their \
                calendar; answer it with respond_to_event instead to tell the organizer).",
            input_schema: object(
                event_ref_props(),
                json!({
                    "scope": { "type": "string", "enum": ["this", "following", "all"], "description": SCOPE_HELP },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                }),
                &["event_id"],
            ),
            read_only: false,
            destructive: true,
            example: json!({ "event_id": "e1", "scope": "this" }),
        },
        ToolDef {
            name: "respond_to_event",
            title: "Answer an invitation",
            description: "Answer an event the user is invited to: accepted, tentative or declined, \
                with an optional note. Google always tells the organizer.",
            input_schema: object(
                event_ref_props(),
                json!({
                    "response": { "type": "string", "enum": ["accepted", "tentative", "declined"] },
                    "comment": { "type": "string" },
                    "scope": { "type": "string", "enum": ["this", "all"], "description": "For a repeating event: this (default) or all." }
                }),
                &["event_id", "response"],
            ),
            read_only: false,
            destructive: false,
            example: json!({ "event_id": "e1", "response": "accepted" }),
        },
    ]
}
