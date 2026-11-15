//! The calendar tools: reads answered from the calendar cache (`CalendarService`), changes
//! through the same writes the Calendar UI makes (straight to the Calendar API, cached once
//! Google confirms). Times go out as ISO 8601 in the user's Calendar time zone and come in as
//! dates, date-times with an offset, or local date-times read in that zone.

use super::read::resolve_accounts;
use super::requests::{
    AccountArg, CreateEvent, DeleteEvent, FindFreeTime, GetEvent, ListEvents, RespondToEvent,
    UpdateEvent, DEFAULT_EVENTS, MAX_EVENTS,
};
use super::write::resolve_account;
use super::{ApiError, LocalApi, Request};
use crate::accounts::AccountInfo;
use crate::calendar::edit::{AttendeeInput, EventEdit, TimeInput};
use crate::calendar::error::CalendarError;
use crate::calendar::service::{CalendarAccountDto, CalendarEventDto, EventTimeDto};
use crate::calendar::writes::{EditScope, EventRef};
use crate::compose::build::html_to_text;
use crate::gmail::calendar::SendUpdates;
use crate::sync::engine::now_ms;
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat};
use chrono::{TimeZone, Weekday};
use chrono_tz::Tz;
use serde_json::{json, Value};

/// The longest range one call reads.
const MAX_RANGE_DAYS: i64 = 366;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Characters of an event description get_event returns.
const DESCRIPTION_CHARS: usize = 8000;

pub(super) async fn run(api: &LocalApi, request: Request) -> Result<Value, ApiError> {
    match request {
        Request::ListCalendars(a) => list_calendars(api, a).await,
        Request::ListEvents(l) => list_events(api, l).await,
        Request::GetEvent(g) => get_event(api, g).await,
        Request::FindFreeTime(f) => find_free_time(api, f).await,
        Request::CreateEvent(c) => create_event(api, c).await,
        Request::UpdateEvent(u) => update_event(api, u).await,
        Request::DeleteEvent(d) => delete_event(api, d).await,
        Request::RespondToEvent(r) => respond_to_event(api, r).await,
        _ => Err(ApiError::Invalid("That isn't a calendar tool.".into())),
    }
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::Invalid(message.into())
}

/// Every account's calendar side, and the time zone a call reads and writes times in.
struct Calendars {
    accounts: Vec<CalendarAccountDto>,
    tz: Tz,
}

impl Calendars {
    /// `requested`, else the first account's Calendar time zone, else UTC.
    async fn load(api: &LocalApi, requested: Option<&str>) -> Result<Self, ApiError> {
        let accounts = api.calendar.accounts().await?;
        let tz = match requested.map(str::trim).filter(|z| !z.is_empty()) {
            Some(zone) => zone.parse::<Tz>().map_err(|_| {
                invalid(format!("\"{zone}\" isn't a time zone (try Europe/Paris)."))
            })?,
            None => accounts
                .iter()
                .filter(|a| a.access.status == "on")
                .chain(accounts.iter())
                .find_map(|a| a.time_zone.as_deref().and_then(|z| z.parse().ok()))
                .unwrap_or(chrono_tz::UTC),
        };
        Ok(Self { accounts, tz })
    }

    fn account(&self, id: &str) -> Option<&CalendarAccountDto> {
        self.accounts.iter().find(|a| a.account_id == id)
    }

    fn email(&self, id: &str) -> String {
        self.account(id)
            .map(|a| a.email.clone())
            .unwrap_or_default()
    }

    fn calendar_name(&self, account_id: &str, calendar_id: &str) -> Option<String> {
        self.account(account_id)?
            .calendars
            .iter()
            .find(|c| c.id == calendar_id)
            .map(|c| c.summary.clone())
    }

    /// The account's own zone for writing, unless the call named one.
    fn zone_for(&self, account_id: &str, requested: Option<&str>) -> Tz {
        if requested.is_some_and(|z| !z.trim().is_empty()) {
            return self.tz;
        }
        self.account(account_id)
            .and_then(|a| a.time_zone.as_deref())
            .and_then(|z| z.parse().ok())
            .unwrap_or(self.tz)
    }

    /// `calendar_id`, or the account's primary calendar.
    fn calendar_id(
        &self,
        account: &AccountInfo,
        calendar_id: Option<&str>,
    ) -> Result<String, ApiError> {
        if let Some(id) = calendar_id.map(str::trim).filter(|c| !c.is_empty()) {
            return Ok(id.to_owned());
        }
        self.account(&account.id)
            .and_then(|a| a.calendars.iter().find(|c| c.primary))
            .map(|c| c.id.clone())
            .ok_or_else(|| {
                invalid(format!(
                    "{} has no calendars Pheeme knows of; give calendar_id.",
                    account.email
                ))
            })
    }

    /// Refused unless Pheeme may use the account's calendar.
    fn require_access(&self, account: &AccountInfo) -> Result<(), ApiError> {
        match self.account(&account.id) {
            Some(a) if a.access.status == "on" => Ok(()),
            Some(a) => Err(invalid(format!("{} {}", account.email, access_note(a)))),
            None => Err(invalid(format!("{} isn't connected.", account.email))),
        }
    }

    /// Notes for the accounts in `ids` whose calendar Pheeme can't read.
    fn access_notes(&self, ids: &[String]) -> Vec<Value> {
        self.accounts
            .iter()
            .filter(|a| ids.contains(&a.account_id) && a.access.status != "on")
            .map(|a| json!({ "account": a.email, "access": a.access.status, "note": access_note(a) }))
            .collect()
    }
}

fn access_note(a: &CalendarAccountDto) -> String {
    match a.access.status.as_str() {
        "on" => "Pheeme reads this calendar.".into(),
        "api_disabled" => format!(
            "can't be read: the Google Calendar API is off in the user's Google Cloud project. They can turn it on at {}.",
            a.access.enable_url.as_deref().unwrap_or("console.cloud.google.com")
        ),
        "error" => format!(
            "can't be read right now: {}",
            a.access.message.as_deref().unwrap_or("the last sync failed.")
        ),
        _ => "hasn't allowed calendar access yet. The user can allow it by opening Calendar in Pheeme.".into(),
    }
}

/// A time as a call gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum When {
    Moment(i64),
    Day(NaiveDate),
}

fn parse_when(raw: &str, tz: Tz) -> Result<When, ApiError> {
    let s = raw.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(When::Day(d));
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(When::Moment(dt.timestamp_millis()));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, format) {
            return local_ms(tz, naive)
                .map(When::Moment)
                .ok_or_else(|| invalid(format!("{s} doesn't exist in {}.", tz.name())));
        }
    }
    Err(invalid(format!(
        "\"{s}\" isn't a date (2026-11-20) or date-time (2026-11-20T15:00)."
    )))
}

/// The moment a wall-clock time names in `tz` (the earlier one when clocks go back).
fn local_ms(tz: Tz, naive: NaiveDateTime) -> Option<i64> {
    tz.from_local_datetime(&naive)
        .earliest()
        .or_else(|| {
            tz.from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
        })
        .map(|d| d.timestamp_millis())
}

fn day_start(tz: Tz, day: NaiveDate) -> i64 {
    local_ms(tz, day.and_time(NaiveTime::MIN)).unwrap_or(0)
}

fn day_of(tz: Tz, ms: i64) -> NaiveDate {
    tz.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_default()
}

fn show_ms(tz: Tz, ms: i64) -> String {
    tz.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Secs, false))
        .unwrap_or_default()
}

fn show_time(tz: Tz, t: &EventTimeDto) -> Option<String> {
    match (&t.date, t.ms) {
        (Some(date), _) => Some(date.clone()),
        (None, Some(ms)) => Some(show_ms(tz, ms)),
        _ => None,
    }
}

/// `[from, to)` in ms: `from` defaults to `default_from`, `to` to a week after it; a date
/// as `to` counts that whole day.
fn range(
    from: Option<&str>,
    to: Option<&str>,
    tz: Tz,
    default_from: i64,
) -> Result<(i64, i64), ApiError> {
    let from_ms = match from.map(|f| parse_when(f, tz)).transpose()? {
        Some(When::Moment(ms)) => ms,
        Some(When::Day(d)) => day_start(tz, d),
        None => default_from,
    };
    let to_ms = match to.map(|t| parse_when(t, tz)).transpose()? {
        Some(When::Moment(ms)) => ms,
        Some(When::Day(d)) => day_start(tz, d + Duration::days(1)),
        None => from_ms + 7 * DAY_MS,
    };
    if to_ms <= from_ms {
        return Err(invalid("to must be after from."));
    }
    if to_ms - from_ms > MAX_RANGE_DAYS * DAY_MS {
        return Err(invalid(format!("At most {MAX_RANGE_DAYS} days at a time.")));
    }
    Ok((from_ms, to_ms))
}

fn event_row(e: &CalendarEventDto, cals: &Calendars) -> Value {
    let mut row = json!({
        "account": cals.email(&e.account_id),
        "calendar_id": e.calendar_id,
        "event_id": e.id,
        "title": e.summary.clone().unwrap_or_else(|| "(No title)".into()),
        "start": show_time(cals.tz, &e.start),
        "end": show_time(cals.tz, &e.end),
    });
    let map = row.as_object_mut().expect("an object");
    if let Some(name) = cals.calendar_name(&e.account_id, &e.calendar_id) {
        map.insert("calendar".into(), name.into());
    }
    if e.all_day {
        map.insert("all_day".into(), true.into());
    }
    if let Some(l) = e.location.as_deref().filter(|l| !l.is_empty()) {
        map.insert("location".into(), l.into());
    }
    if let Some(m) = &e.meeting {
        map.insert("video_call".into(), m.url.clone().into());
    }
    if let Some(r) = &e.self_response {
        map.insert("my_response".into(), r.clone().into());
    }
    if e.recurring {
        map.insert("repeating".into(), true.into());
    }
    if e.transparency.as_deref() == Some("transparent") {
        map.insert("shows_as_free".into(), true.into());
    }
    if e.status != "confirmed" {
        map.insert("status".into(), e.status.clone().into());
    }
    map.insert("can_edit".into(), e.can_edit.into());
    row
}

async fn account_ids(api: &LocalApi, account: Option<&str>) -> Result<Vec<String>, ApiError> {
    Ok(resolve_accounts(api, account)
        .await?
        .into_iter()
        .map(|a| a.id)
        .collect())
}

async fn list_calendars(api: &LocalApi, args: AccountArg) -> Result<Value, ApiError> {
    let ids = account_ids(api, args.account.as_deref()).await?;
    let cals = Calendars::load(api, None).await?;
    let accounts: Vec<Value> = cals
        .accounts
        .iter()
        .filter(|a| ids.contains(&a.account_id))
        .map(|a| {
            let calendars: Vec<Value> = a
                .calendars
                .iter()
                .map(|c| {
                    json!({
                        "calendar_id": c.id,
                        "name": c.summary,
                        "primary": c.primary,
                        "can_change": matches!(c.access_role.as_str(), "owner" | "writer"),
                        "shown": !c.hidden,
                    })
                })
                .collect();
            let mut row = json!({
                "account": a.email,
                "access": a.access.status,
                "time_zone": a.time_zone,
                "calendars": calendars,
            });
            if a.access.status != "on" {
                row["note"] = access_note(a).into();
            }
            row
        })
        .collect();
    Ok(json!({ "accounts": accounts }))
}

async fn list_events(api: &LocalApi, args: ListEvents) -> Result<Value, ApiError> {
    let ids = account_ids(api, args.account.as_deref()).await?;
    let cals = Calendars::load(api, args.time_zone.as_deref()).await?;
    let today = day_start(cals.tz, day_of(cals.tz, now_ms()));
    let (from, to) = range(args.from.as_deref(), args.to.as_deref(), cals.tz, today)?;
    let limit = args.limit.unwrap_or(DEFAULT_EVENTS).clamp(1, MAX_EVENTS) as usize;
    let query = args
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    let events = match query {
        Some(q) => {
            api.calendar
                .search_events(q, from, to, cals.tz.name(), usize::MAX)
                .await?
        }
        None => api.calendar.events(from, to, cals.tz.name()).await?,
    };
    let calendar = args
        .calendar_id
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let matching: Vec<&CalendarEventDto> = events
        .iter()
        .filter(|e| ids.contains(&e.account_id))
        .filter(|e| calendar.is_none_or(|c| e.calendar_id == c))
        .collect();
    let rows: Vec<Value> = matching
        .iter()
        .take(limit)
        .map(|e| event_row(e, &cals))
        .collect();
    let mut out = json!({
        "time_zone": cals.tz.name(),
        "from": show_ms(cals.tz, from),
        "to": show_ms(cals.tz, to),
        "events": rows,
    });
    if matching.len() > limit {
        out["more"] = json!(format!(
            "{} more events; narrow the range or raise limit.",
            matching.len() - limit
        ));
    }
    let notes = cals.access_notes(&ids);
    if !notes.is_empty() {
        out["calendar_access"] = notes.into();
    }
    Ok(out)
}

fn description_text(raw: &str) -> String {
    let text = if raw.contains('<') {
        html_to_text(raw)
    } else {
        raw.to_owned()
    };
    match text.char_indices().nth(DESCRIPTION_CHARS) {
        Some((end, _)) => format!("{}…(cut)", &text[..end]),
        None => text,
    }
}

/// The one account a call is about, the calendars (times in `time_zone`), and its calendar:
/// `calendar_id` or the primary. Refused unless Pheeme may use the account's calendar.
async fn one_calendar(
    api: &LocalApi,
    account: Option<&str>,
    calendar_id: Option<&str>,
    time_zone: Option<&str>,
) -> Result<(AccountInfo, Calendars, String), ApiError> {
    let account = resolve_account(api, account).await?;
    let cals = Calendars::load(api, time_zone).await?;
    cals.require_access(&account)?;
    let calendar_id = cals.calendar_id(&account, calendar_id)?;
    Ok((account, cals, calendar_id))
}

async fn get_event(api: &LocalApi, args: GetEvent) -> Result<Value, ApiError> {
    let (account, cals, calendar_id) = one_calendar(
        api,
        args.account.as_deref(),
        args.calendar_id.as_deref(),
        args.time_zone.as_deref(),
    )
    .await?;
    let d = api
        .calendar
        .event_detail(&account.id, &calendar_id, args.event_id.trim())
        .await?;
    let mut row = event_row(&d.event, &cals);
    let map = row.as_object_mut().expect("an object");
    if let Some(text) = d.description.as_deref().filter(|t| !t.trim().is_empty()) {
        map.insert("description".into(), description_text(text).into());
    }
    if let Some(o) = &d.organizer {
        map.insert(
            "organizer".into(),
            json!({ "email": o.email, "name": o.name, "is_me": o.is_self }),
        );
    }
    let guests: Vec<Value> = d
        .attendees
        .iter()
        .filter(|a| !a.resource)
        .map(|a| {
            let mut g = json!({ "email": a.email, "response": a.response });
            for (key, value) in [
                ("optional", a.optional),
                ("organizer", a.organizer),
                ("is_me", a.is_self),
            ] {
                if value {
                    g[key] = true.into();
                }
            }
            if let Some(n) = &a.name {
                g["name"] = n.clone().into();
            }
            if let Some(c) = &a.comment {
                g["note"] = c.clone().into();
            }
            g
        })
        .collect();
    if !guests.is_empty() {
        map.insert("guests".into(), guests.into());
    }
    if !d.recurrence.is_empty() {
        map.insert("repeat".into(), d.recurrence.clone().into());
    }
    if let Some(original) = d
        .original_start
        .as_ref()
        .and_then(|t| show_time(cals.tz, t))
    {
        map.insert("originally".into(), original.into());
    }
    if let Some(link) = &d.html_link {
        map.insert("google_calendar_link".into(), link.clone().into());
    }
    map.insert("can_answer".into(), d.can_rsvp.into());
    map.insert("can_delete".into(), d.can_delete.into());
    Ok(row)
}

/// Merged busy intervals of `events`: timed, not cancelled or declined, not marked free.
fn busy(events: &[&CalendarEventDto]) -> Vec<(i64, i64)> {
    let mut spans: Vec<(i64, i64)> = events
        .iter()
        .filter(|e| !e.all_day && e.status != "cancelled")
        .filter(|e| e.self_response.as_deref() != Some("declined"))
        .filter(|e| e.transparency.as_deref() != Some("transparent"))
        .filter_map(|e| Some((e.start.ms?, e.end.ms?)))
        .filter(|(s, e)| e > s)
        .collect();
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::with_capacity(spans.len());
    for (s, e) in spans {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    merged
}

fn hour_minute(raw: Option<&str>, default: NaiveTime, which: &str) -> Result<NaiveTime, ApiError> {
    match raw.map(str::trim).filter(|r| !r.is_empty()) {
        None => Ok(default),
        Some(r) => NaiveTime::parse_from_str(r, "%H:%M")
            .map_err(|_| invalid(format!("{which} \"{r}\" isn't a time like 09:00."))),
    }
}

/// Free slots of at least `minutes` in `[from, to)`, inside `[start, end)` of each day (in
/// `tz`), skipping weekends unless `weekends`.
#[allow(clippy::too_many_arguments)]
fn free_slots(
    busy: &[(i64, i64)],
    from: i64,
    to: i64,
    tz: Tz,
    start: NaiveTime,
    end: NaiveTime,
    weekends: bool,
    minutes: i64,
) -> Vec<(i64, i64)> {
    let need = minutes * 60 * 1000;
    let mut slots = Vec::new();
    let mut day = day_of(tz, from);
    let last = day_of(tz, to);
    while day <= last {
        let weekend = matches!(day.weekday(), Weekday::Sat | Weekday::Sun);
        if weekends || !weekend {
            let open = local_ms(tz, day.and_time(start)).unwrap_or(0).max(from);
            let close = local_ms(tz, day.and_time(end)).unwrap_or(0).min(to);
            let mut cursor = open;
            for &(s, e) in busy.iter().filter(|(s, e)| *e > open && *s < close) {
                if s - cursor >= need {
                    slots.push((cursor, s));
                }
                cursor = cursor.max(e);
            }
            if close - cursor >= need {
                slots.push((cursor, close));
            }
        }
        day += Duration::days(1);
    }
    slots
}

async fn find_free_time(api: &LocalApi, args: FindFreeTime) -> Result<Value, ApiError> {
    let ids = account_ids(api, args.account.as_deref()).await?;
    let cals = Calendars::load(api, args.time_zone.as_deref()).await?;
    let now = now_ms();
    let (from, to) = range(args.from.as_deref(), args.to.as_deref(), cals.tz, now)?;
    let from = from.max(now);
    if to <= from {
        return Err(invalid("That time has passed."));
    }
    let minutes = args.duration_minutes.unwrap_or(30).clamp(5, 1440);
    let start = hour_minute(
        args.day_start.as_deref(),
        NaiveTime::from_hms_opt(9, 0, 0).unwrap_or_default(),
        "day_start",
    )?;
    let end = hour_minute(
        args.day_end.as_deref(),
        NaiveTime::from_hms_opt(17, 0, 0).unwrap_or_default(),
        "day_end",
    )?;
    if end <= start {
        return Err(invalid("day_end must be after day_start."));
    }
    let events = api.calendar.events(from, to, cals.tz.name()).await?;
    let mine: Vec<&CalendarEventDto> = events
        .iter()
        .filter(|e| ids.contains(&e.account_id))
        .collect();
    let busy = busy(&mine);
    let slots = free_slots(&busy, from, to, cals.tz, start, end, args.weekends, minutes);
    let limit = args.limit.unwrap_or(20).clamp(1, 100) as usize;
    let rows: Vec<Value> = slots
        .iter()
        .take(limit)
        .map(|(s, e)| {
            json!({
                "start": show_ms(cals.tz, *s),
                "end": show_ms(cals.tz, *e),
                "minutes": (e - s) / 60_000,
            })
        })
        .collect();
    let mut out = json!({
        "time_zone": cals.tz.name(),
        "duration_minutes": minutes,
        "slots": rows,
        "busy_periods": busy.len(),
    });
    if slots.len() > limit {
        out["more"] = json!(format!("{} more slots.", slots.len() - limit));
    }
    let notes = cals.access_notes(&ids);
    if !notes.is_empty() {
        out["calendar_access"] = notes.into();
    }
    Ok(out)
}

fn time_input(when: When, tz: Tz) -> TimeInput {
    match when {
        When::Moment(ms) => TimeInput {
            ms: Some(ms),
            date: None,
            time_zone: Some(tz.name().to_owned()),
        },
        When::Day(d) => TimeInput {
            ms: None,
            date: Some(d.format("%Y-%m-%d").to_string()),
            time_zone: None,
        },
    }
}

/// `end`, or the default after `start`: an hour later, or the next day.
fn end_after(start: When, end: Option<When>) -> When {
    end.unwrap_or(match start {
        When::Moment(ms) => When::Moment(ms + 60 * 60 * 1000),
        When::Day(d) => When::Day(d + Duration::days(1)),
    })
}

fn scope(raw: Option<&str>) -> Result<EditScope, ApiError> {
    match raw.map(|s| s.trim().to_lowercase()).as_deref() {
        None | Some("") | Some("this") => Ok(EditScope::This),
        Some("following") => Ok(EditScope::Following),
        Some("all") => Ok(EditScope::All),
        Some(other) => Err(invalid(format!(
            "scope \"{other}\" isn't this, following or all."
        ))),
    }
}

fn send(notify: bool) -> SendUpdates {
    if notify {
        SendUpdates::All
    } else {
        SendUpdates::None
    }
}

fn guest_list(emails: &[String], optional: bool) -> Vec<AttendeeInput> {
    emails
        .iter()
        .map(|e| e.trim())
        .filter(|e| !e.is_empty())
        .map(|e| AttendeeInput {
            email: e.to_owned(),
            optional,
        })
        .collect()
}

/// The event as it is after a change, for the answer: its ids alone if the cache can't say yet.
async fn written(api: &LocalApi, cals: &Calendars, done: &EventRef) -> Value {
    detail_row(api, cals, done)
        .await
        .unwrap_or_else(|| json!({ "calendar_id": done.calendar_id, "event_id": done.id }))
}

async fn detail_row(api: &LocalApi, cals: &Calendars, done: &EventRef) -> Option<Value> {
    let (account_id, calendar_id, event_id) = (&done.account_id, &done.calendar_id, &done.id);
    let d = api
        .calendar
        .event_detail(account_id, calendar_id, event_id)
        .await
        .ok()?;
    let mut row = event_row(&d.event, cals);
    let guests: Vec<Value> = d
        .attendees
        .iter()
        .filter(|a| !a.resource && !a.is_self)
        .filter_map(|a| a.email.clone().map(Value::from))
        .collect();
    if !guests.is_empty() {
        row["guests"] = guests.into();
    }
    if let Some(link) = &d.html_link {
        row["google_calendar_link"] = link.clone().into();
    }
    Some(row)
}

async fn create_event(api: &LocalApi, args: CreateEvent) -> Result<Value, ApiError> {
    let (account, cals, calendar_id) = one_calendar(
        api,
        args.account.as_deref(),
        args.calendar_id.as_deref(),
        args.time_zone.as_deref(),
    )
    .await?;
    if args.title.trim().is_empty() {
        return Err(invalid("Give the event a title."));
    }
    let tz = cals.zone_for(&account.id, args.time_zone.as_deref());
    let start = parse_when(&args.start, tz)?;
    let end = end_after(
        start,
        args.end.as_deref().map(|e| parse_when(e, tz)).transpose()?,
    );
    let mut attendees = guest_list(&args.guests, false);
    attendees.extend(guest_list(&args.optional_guests, true));
    let text = |v: Option<String>| v.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    let edit = EventEdit {
        summary: Some(args.title.trim().to_owned()),
        description: text(args.description),
        location: text(args.location),
        start: Some(time_input(start, tz)),
        end: Some(time_input(end, tz)),
        attendees: (!attendees.is_empty()).then_some(attendees),
        conference: args.add_meet.then_some(true),
        recurrence: (!args.repeat.is_empty()).then_some(args.repeat),
        ..Default::default()
    };
    let made = api
        .calendar
        .create_event(&account.id, &calendar_id, edit, send(args.notify_guests))
        .await?;
    Ok(json!({
        "account": account.email,
        "created": written(api, &cals, &made).await,
        "guests_emailed": args.notify_guests,
    }))
}

/// The new start and end when a call moves an event: a start alone keeps its length.
fn moved(
    start: Option<When>,
    end: Option<When>,
    old_start: &EventTimeDto,
    old_end: &EventTimeDto,
) -> Result<Option<(When, When)>, ApiError> {
    let old = |t: &EventTimeDto| -> Option<When> {
        match (&t.date, t.ms) {
            (Some(d), _) => NaiveDate::parse_from_str(d, "%Y-%m-%d").ok().map(When::Day),
            (None, Some(ms)) => Some(When::Moment(ms)),
            _ => None,
        }
    };
    let unknown = || invalid("Pheeme doesn't know this event's times; give both start and end.");
    Ok(match (start, end) {
        (None, None) => None,
        (Some(s), Some(e)) => Some((s, e)),
        (None, Some(e)) => Some((old(old_start).ok_or_else(unknown)?, e)),
        (Some(s), None) => {
            let end = match (s, old(old_start), old(old_end)) {
                (When::Moment(ms), Some(When::Moment(a)), Some(When::Moment(b))) => {
                    When::Moment(ms + (b - a))
                }
                (When::Day(d), Some(When::Day(a)), Some(When::Day(b))) => When::Day(d + (b - a)),
                // A timed event made all-day, or the other way: the default length.
                _ => end_after(s, None),
            };
            Some((s, end))
        }
    })
}

async fn update_event(api: &LocalApi, args: UpdateEvent) -> Result<Value, ApiError> {
    let (account, cals, calendar_id) = one_calendar(
        api,
        args.account.as_deref(),
        args.calendar_id.as_deref(),
        args.time_zone.as_deref(),
    )
    .await?;
    let event_id = args.event_id.trim();
    let scope = scope(args.scope.as_deref())?;
    let detail = api
        .calendar
        .event_detail(&account.id, &calendar_id, event_id)
        .await?;
    let tz = cals.zone_for(&account.id, args.time_zone.as_deref());
    let start = args
        .start
        .as_deref()
        .map(|s| parse_when(s, tz))
        .transpose()?;
    let end = args.end.as_deref().map(|e| parse_when(e, tz)).transpose()?;
    let times = moved(start, end, &detail.event.start, &detail.event.end)?;

    let mut changed = Vec::new();
    let mut edit = EventEdit::default();
    if let Some(title) = args.title {
        edit.summary = Some(title.trim().to_owned());
        changed.push("title");
    }
    if let Some(description) = args.description {
        edit.description = Some(description);
        changed.push("description");
    }
    if let Some(location) = args.location {
        edit.location = Some(location.trim().to_owned());
        changed.push("location");
    }
    if let Some((s, e)) = times {
        edit.start = Some(time_input(s, tz));
        edit.end = Some(time_input(e, tz));
        changed.push("time");
    }
    if !args.add_guests.is_empty() || !args.remove_guests.is_empty() {
        let removed = |email: &str| {
            args.remove_guests
                .iter()
                .any(|r| r.trim().eq_ignore_ascii_case(email))
        };
        let mut list: Vec<AttendeeInput> = detail
            .attendees
            .iter()
            .filter_map(|a| {
                let email = a.email.clone()?;
                (!removed(&email)).then_some(AttendeeInput {
                    email,
                    optional: a.optional,
                })
            })
            .collect();
        for add in guest_list(&args.add_guests, false) {
            if !list
                .iter()
                .any(|a| a.email.eq_ignore_ascii_case(&add.email))
            {
                list.push(add);
            }
        }
        edit.attendees = Some(list);
        changed.push("guests");
    }
    if let Some(meet) = args.meet {
        edit.conference = Some(meet);
        changed.push("video call");
    }
    if let Some(repeat) = args.repeat {
        edit.recurrence = Some(repeat);
        changed.push("repeat");
    }
    if changed.is_empty() {
        return Err(invalid("Nothing to change: give at least one field."));
    }
    let done = api
        .calendar
        .update_event(
            &account.id,
            &calendar_id,
            event_id,
            scope,
            edit,
            send(args.notify_guests),
        )
        .await?;
    Ok(json!({
        "account": account.email,
        "changed": changed,
        "event": written(api, &cals, &done).await,
        "guests_emailed": args.notify_guests,
    }))
}

async fn delete_event(api: &LocalApi, args: DeleteEvent) -> Result<Value, ApiError> {
    let (account, cals, calendar_id) = one_calendar(
        api,
        args.account.as_deref(),
        args.calendar_id.as_deref(),
        None,
    )
    .await?;
    let event_id = args.event_id.trim();
    let scope = scope(args.scope.as_deref())?;
    let detail = api
        .calendar
        .event_detail(&account.id, &calendar_id, event_id)
        .await?;
    if !detail.can_delete {
        return Err(ApiError::Calendar(CalendarError::ReadOnly(
            "The user can't delete this event.".into(),
        )));
    }
    api.calendar
        .delete_event(
            &account.id,
            &calendar_id,
            event_id,
            scope,
            send(args.notify_guests),
        )
        .await?;
    Ok(json!({
        "account": account.email,
        "deleted": event_row(&detail.event, &cals),
        "scope": format!("{scope:?}").to_lowercase(),
        "guests_emailed": args.notify_guests,
    }))
}

async fn respond_to_event(api: &LocalApi, args: RespondToEvent) -> Result<Value, ApiError> {
    let (account, cals, calendar_id) = one_calendar(
        api,
        args.account.as_deref(),
        args.calendar_id.as_deref(),
        None,
    )
    .await?;
    let response = match args.response.trim().to_lowercase().as_str() {
        "accepted" | "accept" | "yes" => "accepted",
        "tentative" | "maybe" => "tentative",
        "declined" | "decline" | "no" => "declined",
        other => {
            return Err(invalid(format!(
                "response \"{other}\" isn't accepted, tentative or declined."
            )))
        }
    };
    let scope = scope(args.scope.as_deref())?;
    let comment = args
        .comment
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty());
    let done = api
        .calendar
        .respond(
            &account.id,
            &calendar_id,
            args.event_id.trim(),
            scope,
            response,
            comment,
        )
        .await?;
    Ok(json!({
        "account": account.email,
        "response": response,
        "event": written(api, &cals, &done).await,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    #[test]
    fn times_read_as_dates_offsets_or_local_wall_clock() {
        let tz: Tz = "America/New_York".parse().unwrap();
        assert_eq!(
            parse_when("2026-11-20", tz).unwrap(),
            When::Day(NaiveDate::from_ymd_opt(2026, 11, 20).unwrap())
        );
        assert_eq!(
            parse_when("2026-11-20T15:00", tz).unwrap(),
            When::Moment(ms("2026-11-20T20:00:00Z"))
        );
        assert_eq!(
            parse_when("2026-11-20T15:00:00+01:00", tz).unwrap(),
            When::Moment(ms("2026-11-20T14:00:00Z"))
        );
        assert!(parse_when("next friday", tz).is_err());
    }

    #[test]
    fn a_date_as_to_counts_the_whole_day() {
        let tz: Tz = "America/New_York".parse().unwrap();
        let (from, to) = range(Some("2026-11-20"), Some("2026-11-20"), tz, 0).unwrap();
        assert_eq!(from, ms("2026-11-20T05:00:00Z"));
        assert_eq!(to, ms("2026-11-21T05:00:00Z"));
        assert!(range(Some("2026-11-21"), Some("2026-11-20"), tz, 0).is_err());
        assert!(range(Some("2026-01-01"), Some("2027-06-01"), tz, 0).is_err());
    }

    #[test]
    fn free_slots_skip_busy_time_weekends_and_after_hours() {
        let tz = chrono_tz::UTC;
        let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        let five = NaiveTime::from_hms_opt(17, 0, 0).unwrap();
        // Friday 20 Nov 2026 to Monday 23 Nov.
        let busy = vec![
            (ms("2026-11-20T10:00:00Z"), ms("2026-11-20T11:00:00Z")),
            (ms("2026-11-20T11:00:00Z"), ms("2026-11-20T16:40:00Z")),
        ];
        let slots = free_slots(
            &busy,
            ms("2026-11-20T00:00:00Z"),
            ms("2026-11-23T12:00:00Z"),
            tz,
            nine,
            five,
            false,
            30,
        );
        assert_eq!(
            slots,
            vec![
                (ms("2026-11-20T09:00:00Z"), ms("2026-11-20T10:00:00Z")),
                (ms("2026-11-23T09:00:00Z"), ms("2026-11-23T12:00:00Z")),
            ]
        );
    }

    #[test]
    fn a_new_start_alone_keeps_the_length() {
        let old_start = EventTimeDto {
            ms: Some(ms("2026-11-20T15:00:00Z")),
            date: None,
            time_zone: None,
        };
        let old_end = EventTimeDto {
            ms: Some(ms("2026-11-20T15:45:00Z")),
            date: None,
            time_zone: None,
        };
        let s = When::Moment(ms("2026-11-21T09:00:00Z"));
        assert_eq!(
            moved(Some(s), None, &old_start, &old_end).unwrap(),
            Some((s, When::Moment(ms("2026-11-21T09:45:00Z"))))
        );
        let day = |d: &str| EventTimeDto {
            ms: None,
            date: Some(d.into()),
            time_zone: None,
        };
        let new = When::Day(NaiveDate::from_ymd_opt(2026, 12, 1).unwrap());
        assert_eq!(
            moved(Some(new), None, &day("2026-11-20"), &day("2026-11-23")).unwrap(),
            Some((
                new,
                When::Day(NaiveDate::from_ymd_opt(2026, 12, 4).unwrap())
            ))
        );
    }
}
