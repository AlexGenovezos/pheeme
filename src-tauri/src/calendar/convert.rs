//! Calendar API resources → cache rows.

use super::recurrence::recur_until_ms;
use crate::db::calendar::{DbCalendar, DbEvent};
use crate::gmail::calendar::{ApiCalendar, ApiEvent, ApiEventTime};
use chrono::{NaiveDate, NaiveTime};
use serde_json::Value;

/// What one item of an events page means for the cache.
#[derive(Debug, Clone, PartialEq)]
pub enum EventChange {
    Upsert(Box<DbEvent>),
    Delete(String),
}

pub fn calendar(account_id: &str, c: &ApiCalendar) -> DbCalendar {
    DbCalendar {
        account_id: account_id.into(),
        id: c.id.clone(),
        summary: c
            .summary_override
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| c.summary.clone()),
        description: c.description.clone(),
        time_zone: c.time_zone.clone(),
        background_color: c.background_color.clone(),
        foreground_color: c.foreground_color.clone(),
        access_role: c.access_role.clone(),
        primary: c.primary,
        hidden: false,
        default_reminders: serde_json::to_string(
            &c.default_reminders
                .iter()
                .map(|r| serde_json::json!({"method": r.method, "minutes": r.minutes}))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into()),
        sync_token: None,
    }
}

fn rfc3339_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn date_ms(d: &str) -> Option<i64> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .ok()
        .map(|d| d.and_time(NaiveTime::MIN).and_utc().timestamp_millis())
}

/// (ms, all-day date) of an event time; all-day times also get their UTC midnight in ms.
fn time(t: Option<&ApiEventTime>) -> (Option<i64>, Option<String>) {
    let Some(t) = t else {
        return (None, None);
    };
    match (&t.date_time, &t.date) {
        (Some(dt), _) => (rfc3339_ms(dt), None),
        (None, Some(d)) => (date_ms(d), Some(d.clone())),
        (None, None) => (None, None),
    }
}

fn json_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).filter(|v| !v.is_null()).map(Value::to_string)
}

/// The cache change for one event of `calendar_id`. `calendar_zone` is the calendar's time
/// zone, used when the event names none.
pub fn event(
    account_id: &str,
    calendar_id: &str,
    calendar_zone: Option<&str>,
    e: &ApiEvent,
) -> EventChange {
    let cancelled = e.status.as_deref() == Some("cancelled");
    if cancelled && e.recurring_event_id.is_none() {
        return EventChange::Delete(e.id.clone());
    }
    let (start_ms, start_date) = time(e.start.as_ref());
    let (end_ms, end_date) = time(e.end.as_ref());
    let (original_start_ms, original_start_date) = time(e.original_start_time.as_ref());
    let time_zone = e
        .start
        .as_ref()
        .and_then(|t| t.time_zone.clone())
        .or_else(|| {
            e.original_start_time
                .as_ref()
                .and_then(|t| t.time_zone.clone())
        })
        .or_else(|| calendar_zone.map(str::to_owned));
    let recur_until = match (start_ms, &start_date, e.recurrence.is_empty()) {
        (Some(start), None, false) => recur_until_ms(
            &e.recurrence,
            start,
            end_ms.unwrap_or(start),
            time_zone.as_deref().unwrap_or("UTC"),
            false,
        ),
        (Some(start), Some(_), false) => {
            recur_until_ms(&e.recurrence, start, end_ms.unwrap_or(start), "UTC", true)
        }
        _ => None,
    };
    let self_response = e
        .attendees
        .iter()
        .find(|a| a.is_self)
        .and_then(|a| a.response_status.clone())
        .or_else(|| {
            let organizer_is_me = e.organizer.as_ref().is_some_and(|o| o.is_self);
            (organizer_is_me && e.attendees.is_empty()).then(|| "accepted".to_owned())
        });
    EventChange::Upsert(Box::new(DbEvent {
        account_id: account_id.into(),
        calendar_id: calendar_id.into(),
        id: e.id.clone(),
        ical_uid: e.ical_uid.clone(),
        recurring_event_id: e.recurring_event_id.clone(),
        original_start_ms,
        original_start_date,
        status: e.status.clone().unwrap_or_else(|| "confirmed".into()),
        start_ms,
        end_ms,
        start_date,
        end_date,
        time_zone,
        recurrence: (!e.recurrence.is_empty())
            .then(|| serde_json::to_string(&e.recurrence).unwrap_or_default()),
        recur_until_ms: recur_until,
        summary: e.summary.clone(),
        location: e.location.clone(),
        description: e.description.clone(),
        organizer_email: e.organizer.as_ref().and_then(|o| o.email.clone()),
        self_response,
        attendees: json_field(&e.raw, "attendees").unwrap_or_else(|| "[]".into()),
        conference: json_field(&e.raw, "conferenceData"),
        color_id: e.color_id.clone(),
        transparency: e.transparency.clone(),
        visibility: e.visibility.clone(),
        reminders: json_field(&e.raw, "reminders"),
        html_link: e.html_link.clone(),
        etag: e.etag.clone(),
        updated_ms: e.updated.as_deref().and_then(rfc3339_ms).unwrap_or(0),
        raw: e.raw.to_string(),
    }))
}
