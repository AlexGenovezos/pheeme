//! A user's event edit as Google Calendar JSON: validation, the insert/patch body, and
//! recurring-instance ids. Pure: no I/O, and the machine's local zone never enters the maths.

use super::error::CalendarError;
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Map, Value};

const MAX_REMINDERS: usize = 5;
const MAX_REMINDER_MINUTES: i64 = 40320;

/// One end of an event: a moment (`ms`, with an optional zone) or an all-day `date`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeInput {
    pub ms: Option<i64>,
    pub date: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendeeInput {
    pub email: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub method: String,
    pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemindersInput {
    pub use_default: bool,
    #[serde(default)]
    pub overrides: Vec<ReminderInput>,
}

/// Changes to an event. `None` leaves a field as it is; `Some("")` clears a text field.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventEdit {
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub color_id: Option<String>,
    pub start: Option<TimeInput>,
    pub end: Option<TimeInput>,
    /// `Some(vec![])` stops the event repeating.
    pub recurrence: Option<Vec<String>>,
    pub attendees: Option<Vec<AttendeeInput>>,
    pub guests_can_modify: Option<bool>,
    pub guests_can_invite_others: Option<bool>,
    pub guests_can_see_other_guests: Option<bool>,
    /// `true` adds a Google Meet link, `false` removes it.
    pub conference: Option<bool>,
    pub reminders: Option<RemindersInput>,
    pub transparency: Option<String>,
    pub visibility: Option<String>,
}

fn invalid(message: impl Into<String>) -> CalendarError {
    CalendarError::Invalid(message.into())
}

/// A parsed end of an event.
enum Parsed {
    Timed(i64),
    AllDay(NaiveDate),
}

fn parse_time(t: &TimeInput, which: &str) -> Result<Parsed, CalendarError> {
    if let Some(zone) = &t.time_zone {
        if zone.parse::<Tz>().is_err() {
            return Err(invalid(format!("\"{zone}\" isn't a time zone.")));
        }
    }
    match (t.ms, &t.date) {
        (Some(ms), None) => Ok(Parsed::Timed(ms)),
        (None, Some(d)) => NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map(Parsed::AllDay)
            .map_err(|_| invalid(format!("The {which} date \"{d}\" isn't a valid date."))),
        _ => Err(invalid(format!(
            "The {which} needs either a time or a date."
        ))),
    }
}

/// Checks an edit against Calendar's rules. `creating` makes start and end mandatory.
pub fn validate(edit: &EventEdit, creating: bool) -> Result<(), CalendarError> {
    match (&edit.start, &edit.end) {
        (Some(start), Some(end)) => {
            let start = parse_time(start, "start")?;
            let end = parse_time(end, "end")?;
            match (start, end) {
                (Parsed::Timed(s), Parsed::Timed(e)) if e <= s => {
                    return Err(invalid("The event must end after it starts."));
                }
                (Parsed::AllDay(s), Parsed::AllDay(e)) if e <= s => {
                    return Err(invalid("The event must end after it starts."));
                }
                (Parsed::Timed(_), Parsed::AllDay(_)) | (Parsed::AllDay(_), Parsed::Timed(_)) => {
                    return Err(invalid(
                        "The start and end must both be all-day or both have times.",
                    ));
                }
                _ => {}
            }
        }
        (None, None) if !creating => {}
        _ => return Err(invalid("An event needs both a start and an end.")),
    }

    if let Some(lines) = &edit.recurrence {
        for line in lines {
            let upper = line.to_ascii_uppercase();
            if !["RRULE:", "EXDATE", "RDATE", "EXRULE"]
                .iter()
                .any(|p| upper.starts_with(p))
            {
                return Err(invalid(format!("\"{line}\" isn't a repeat rule.")));
            }
        }
    }
    if let Some(attendees) = &edit.attendees {
        for a in attendees {
            if !a.email.contains('@') {
                return Err(invalid(format!("\"{}\" isn't an email address.", a.email)));
            }
        }
    }
    if let Some(r) = &edit.reminders {
        if r.overrides.len() > MAX_REMINDERS {
            return Err(invalid(format!(
                "An event can have at most {MAX_REMINDERS} reminders."
            )));
        }
        for o in &r.overrides {
            if !matches!(o.method.as_str(), "popup" | "email") {
                return Err(invalid(format!("\"{}\" isn't a reminder type.", o.method)));
            }
            if !(0..=MAX_REMINDER_MINUTES).contains(&o.minutes) {
                return Err(invalid(
                    "A reminder must be between 0 minutes and 4 weeks before the event.",
                ));
            }
        }
    }
    if let Some(c) = &edit.color_id {
        if !c.is_empty() && !(1..=11).any(|n| n.to_string() == *c) {
            return Err(invalid(format!("\"{c}\" isn't an event colour.")));
        }
    }
    if let Some(t) = &edit.transparency {
        if !matches!(t.as_str(), "opaque" | "transparent") {
            return Err(invalid(format!("\"{t}\" isn't a valid availability.")));
        }
    }
    if let Some(v) = &edit.visibility {
        if !matches!(
            v.as_str(),
            "default" | "public" | "private" | "confidential"
        ) {
            return Err(invalid(format!("\"{v}\" isn't a valid visibility.")));
        }
    }
    Ok(())
}

fn text(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_owned())
    }
}

fn time_json(t: &TimeInput, default_zone: &str) -> Value {
    if let Some(date) = &t.date {
        return json!({ "date": date, "dateTime": null, "timeZone": null });
    }
    let zone_name = t.time_zone.as_deref().unwrap_or(default_zone);
    let tz: Tz = zone_name
        .parse()
        .or_else(|_| default_zone.parse())
        .unwrap_or(chrono_tz::UTC);
    let at: DateTime<Tz> = tz
        .timestamp_millis_opt(t.ms.unwrap_or(0))
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).unwrap().with_timezone(&tz));
    json!({
        "dateTime": at.to_rfc3339_opts(SecondsFormat::Secs, false),
        "timeZone": tz.name(),
        "date": null,
    })
}

fn has_conference(existing: Option<&Value>) -> bool {
    existing
        .and_then(|e| e.get("conferenceData"))
        .is_some_and(|c| !c.is_null())
}

/// Whether writing `edit` sends `conferenceData`, which needs `conferenceDataVersion=1`.
pub fn touches_conference(edit: &EventEdit, existing: Option<&Value>) -> bool {
    match edit.conference {
        Some(true) => !has_conference(existing),
        Some(false) => true,
        None => false,
    }
}

fn merge_attendees(inputs: &[AttendeeInput], existing: Option<&Value>) -> Value {
    let current = existing
        .and_then(|e| e.get("attendees"))
        .and_then(Value::as_array);
    let merged = inputs
        .iter()
        .map(|input| {
            let kept = current.and_then(|list| {
                list.iter().find(|a| {
                    a.get("email")
                        .and_then(Value::as_str)
                        .is_some_and(|e| e.eq_ignore_ascii_case(&input.email))
                })
            });
            match kept {
                Some(Value::Object(obj)) => {
                    let mut obj = obj.clone();
                    obj.insert("optional".into(), Value::Bool(input.optional));
                    Value::Object(obj)
                }
                _ => json!({ "email": input.email, "optional": input.optional }),
            }
        })
        .collect();
    Value::Array(merged)
}

/// The JSON for an insert or a patch: only the fields `edit` sets.
pub fn body(edit: &EventEdit, existing: Option<&Value>, default_zone: &str) -> Value {
    let mut m = Map::new();
    for (key, value) in [
        ("summary", &edit.summary),
        ("description", &edit.description),
        ("location", &edit.location),
        ("colorId", &edit.color_id),
    ] {
        if let Some(v) = value {
            m.insert(key.into(), text(v));
        }
    }
    if let Some(start) = &edit.start {
        m.insert("start".into(), time_json(start, default_zone));
    }
    if let Some(end) = &edit.end {
        m.insert("end".into(), time_json(end, default_zone));
    }
    if let Some(lines) = &edit.recurrence {
        m.insert(
            "recurrence".into(),
            if lines.is_empty() {
                Value::Null
            } else {
                json!(lines)
            },
        );
    }
    if let Some(attendees) = &edit.attendees {
        m.insert("attendees".into(), merge_attendees(attendees, existing));
    }
    for (key, value) in [
        ("guestsCanModify", edit.guests_can_modify),
        ("guestsCanInviteOthers", edit.guests_can_invite_others),
        ("guestsCanSeeOtherGuests", edit.guests_can_see_other_guests),
    ] {
        if let Some(v) = value {
            m.insert(key.into(), Value::Bool(v));
        }
    }
    if touches_conference(edit, existing) {
        let value = if edit.conference == Some(true) {
            json!({ "createRequest": {
                "requestId": uuid::Uuid::new_v4().to_string(),
                "conferenceSolutionKey": { "type": "hangoutsMeet" },
            }})
        } else {
            Value::Null
        };
        m.insert("conferenceData".into(), value);
    }
    if let Some(r) = &edit.reminders {
        let overrides: Vec<Value> = r
            .overrides
            .iter()
            .map(|o| json!({ "method": o.method, "minutes": o.minutes }))
            .collect();
        m.insert(
            "reminders".into(),
            json!({ "useDefault": r.use_default, "overrides": overrides }),
        );
    }
    if let Some(t) = &edit.transparency {
        m.insert("transparency".into(), json!(t));
    }
    if let Some(v) = &edit.visibility {
        m.insert("visibility".into(), json!(v));
    }
    Value::Object(m)
}

/// The original start of a recurring-event instance, as encoded in its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginalStart {
    Ms(i64),
    Date(NaiveDate),
}

/// Splits an instance id (`<master>_<YYYYMMDDTHHMMSSZ | YYYYMMDD>`) at its last `_`.
pub fn parse_instance_id(id: &str) -> Option<(String, OriginalStart)> {
    let (master, suffix) = id.rsplit_once('_')?;
    if master.is_empty() {
        return None;
    }
    let at = if suffix.len() == 8 {
        OriginalStart::Date(NaiveDate::parse_from_str(suffix, "%Y%m%d").ok()?)
    } else {
        let naive = NaiveDateTime::parse_from_str(suffix, "%Y%m%dT%H%M%SZ").ok()?;
        OriginalStart::Ms(naive.and_utc().timestamp_millis())
    };
    Some((master.to_owned(), at))
}

/// The inverse of [`parse_instance_id`].
pub fn instance_id(master: &str, at: &OriginalStart) -> String {
    match at {
        OriginalStart::Date(d) => format!("{master}_{}", d.format("%Y%m%d")),
        OriginalStart::Ms(ms) => {
            let utc = Utc.timestamp_millis_opt(*ms).single().unwrap_or_default();
            format!("{master}_{}", utc.format("%Y%m%dT%H%M%SZ"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOV_12_19_UTC: i64 = 1_794_510_000_000;

    fn timed(ms: i64, zone: Option<&str>) -> TimeInput {
        TimeInput {
            ms: Some(ms),
            date: None,
            time_zone: zone.map(str::to_owned),
        }
    }

    fn all_day(d: &str) -> TimeInput {
        TimeInput {
            ms: None,
            date: Some(d.to_owned()),
            time_zone: None,
        }
    }

    fn valid_timed() -> EventEdit {
        EventEdit {
            start: Some(timed(NOV_12_19_UTC, None)),
            end: Some(timed(NOV_12_19_UTC + 3_600_000, None)),
            ..Default::default()
        }
    }

    #[test]
    fn timed_body_uses_event_zone_offset() {
        assert_eq!(
            Utc.timestamp_millis_opt(NOV_12_19_UTC)
                .unwrap()
                .to_rfc3339(),
            "2026-11-12T19:00:00+00:00"
        );
        let edit = EventEdit {
            start: Some(timed(NOV_12_19_UTC, Some("America/New_York"))),
            end: Some(timed(NOV_12_19_UTC + 3_600_000, None)),
            ..Default::default()
        };
        let b = body(&edit, None, "Europe/London");
        assert_eq!(b["start"]["dateTime"], "2026-11-12T14:00:00-05:00");
        assert_eq!(b["start"]["timeZone"], "America/New_York");
        assert!(b["start"]["date"].is_null());
        assert_eq!(b["end"]["dateTime"], "2026-11-12T20:00:00+00:00");
        assert_eq!(b["end"]["timeZone"], "Europe/London");
    }

    #[test]
    fn all_day_body_nulls_date_time() {
        let edit = EventEdit {
            start: Some(all_day("2026-11-12")),
            end: Some(all_day("2026-11-13")),
            ..Default::default()
        };
        let b = body(&edit, None, "UTC");
        assert_eq!(
            b["start"],
            json!({"date": "2026-11-12", "dateTime": null, "timeZone": null})
        );
        assert_eq!(b["end"]["date"], "2026-11-13");
    }

    #[test]
    fn cleared_location_is_null() {
        let edit = EventEdit {
            location: Some(String::new()),
            summary: Some("Lunch".into()),
            ..Default::default()
        };
        let b = body(&edit, None, "UTC");
        assert!(b.get("location").is_some_and(Value::is_null));
        assert_eq!(b["summary"], "Lunch");
        assert!(b.get("description").is_none());
    }

    #[test]
    fn attendee_merge_keeps_existing_status() {
        let existing = json!({"attendees": [
            {"email": "Ann@Example.com", "responseStatus": "accepted", "comment": "yes", "optional": false},
            {"email": "gone@example.com", "responseStatus": "declined"},
        ]});
        let edit = EventEdit {
            attendees: Some(vec![
                AttendeeInput {
                    email: "ann@example.com".into(),
                    optional: true,
                },
                AttendeeInput {
                    email: "new@example.com".into(),
                    optional: false,
                },
            ]),
            ..Default::default()
        };
        let b = body(&edit, Some(&existing), "UTC");
        let list = b["attendees"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["email"], "Ann@Example.com");
        assert_eq!(list[0]["responseStatus"], "accepted");
        assert_eq!(list[0]["comment"], "yes");
        assert_eq!(list[0]["optional"], true);
        assert_eq!(
            list[1],
            json!({"email": "new@example.com", "optional": false})
        );
    }

    #[test]
    fn meet_on_adds_create_request_once() {
        let edit = EventEdit {
            conference: Some(true),
            ..Default::default()
        };
        let b = body(&edit, None, "UTC");
        let req = &b["conferenceData"]["createRequest"];
        assert!(!req["requestId"].as_str().unwrap().is_empty());
        assert_eq!(req["conferenceSolutionKey"]["type"], "hangoutsMeet");
        assert!(touches_conference(&edit, None));

        let existing = json!({"conferenceData": {"conferenceId": "abc"}});
        assert!(body(&edit, Some(&existing), "UTC")
            .get("conferenceData")
            .is_none());
        assert!(!touches_conference(&edit, Some(&existing)));
    }

    #[test]
    fn meet_off_nulls_conference() {
        let edit = EventEdit {
            conference: Some(false),
            ..Default::default()
        };
        let existing = json!({"conferenceData": {"conferenceId": "abc"}});
        let b = body(&edit, Some(&existing), "UTC");
        assert!(b.get("conferenceData").is_some_and(Value::is_null));
        assert!(touches_conference(&edit, Some(&existing)));
        assert!(!touches_conference(&EventEdit::default(), Some(&existing)));
    }

    #[test]
    fn reminders_body() {
        let edit = EventEdit {
            reminders: Some(RemindersInput {
                use_default: false,
                overrides: vec![ReminderInput {
                    method: "popup".into(),
                    minutes: 10,
                }],
            }),
            ..Default::default()
        };
        assert_eq!(
            body(&edit, None, "UTC")["reminders"],
            json!({"useDefault": false, "overrides": [{"method": "popup", "minutes": 10}]})
        );
    }

    #[test]
    fn validate_accepts_good_edits() {
        assert!(validate(&valid_timed(), true).is_ok());
        assert!(validate(&EventEdit::default(), false).is_ok());
        assert!(validate(
            &EventEdit {
                color_id: Some(String::new()),
                recurrence: Some(vec![]),
                ..Default::default()
            },
            false
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects() {
        let overrides = |n: usize| RemindersInput {
            use_default: false,
            overrides: (0..n)
                .map(|_| ReminderInput {
                    method: "popup".into(),
                    minutes: 5,
                })
                .collect(),
        };
        let with = |f: &dyn Fn(&mut EventEdit)| {
            let mut e = valid_timed();
            f(&mut e);
            e
        };
        let cases: Vec<(&str, EventEdit, bool)> = vec![
            ("create without times", EventEdit::default(), true),
            (
                "start only",
                EventEdit {
                    start: Some(timed(1, None)),
                    ..Default::default()
                },
                false,
            ),
            (
                "mixed all-day and timed",
                with(&|e| e.end = Some(all_day("2026-11-13"))),
                true,
            ),
            ("end equals start", with(&|e| e.end = e.start.clone()), true),
            (
                "all-day end equals start",
                EventEdit {
                    start: Some(all_day("2026-11-12")),
                    end: Some(all_day("2026-11-12")),
                    ..Default::default()
                },
                true,
            ),
            (
                "bad zone",
                with(&|e| e.start = Some(timed(NOV_12_19_UTC, Some("Mars/Base")))),
                true,
            ),
            (
                "bad date",
                EventEdit {
                    start: Some(all_day("2026-13-40")),
                    end: Some(all_day("2026-13-41")),
                    ..Default::default()
                },
                true,
            ),
            (
                "both ms and date",
                with(&|e| {
                    e.start = Some(TimeInput {
                        ms: Some(1),
                        date: Some("2026-11-12".into()),
                        time_zone: None,
                    })
                }),
                true,
            ),
            (
                "bad recurrence",
                with(&|e| e.recurrence = Some(vec!["FREQ=DAILY".into()])),
                true,
            ),
            (
                "email without @",
                with(&|e| {
                    e.attendees = Some(vec![AttendeeInput {
                        email: "nobody".into(),
                        optional: false,
                    }])
                }),
                true,
            ),
            (
                "six reminders",
                with(&|e| e.reminders = Some(overrides(6))),
                true,
            ),
            (
                "minutes 40321",
                with(&|e| {
                    e.reminders = Some(RemindersInput {
                        use_default: false,
                        overrides: vec![ReminderInput {
                            method: "email".into(),
                            minutes: 40321,
                        }],
                    })
                }),
                true,
            ),
            (
                "negative minutes",
                with(&|e| {
                    e.reminders = Some(RemindersInput {
                        use_default: false,
                        overrides: vec![ReminderInput {
                            method: "email".into(),
                            minutes: -1,
                        }],
                    })
                }),
                true,
            ),
            (
                "reminder method",
                with(&|e| {
                    e.reminders = Some(RemindersInput {
                        use_default: false,
                        overrides: vec![ReminderInput {
                            method: "sms".into(),
                            minutes: 1,
                        }],
                    })
                }),
                true,
            ),
            (
                "colorId 12",
                with(&|e| e.color_id = Some("12".into())),
                true,
            ),
            (
                "transparency",
                with(&|e| e.transparency = Some("busy".into())),
                true,
            ),
            (
                "visibility",
                with(&|e| e.visibility = Some("secret".into())),
                true,
            ),
        ];
        for (name, edit, creating) in cases {
            let err = validate(&edit, creating).expect_err(name);
            assert_eq!(err.code(), "invalid_input", "{name}");
        }
        assert!(validate(&with(&|e| e.reminders = Some(overrides(5))), true).is_ok());
    }

    #[test]
    fn instance_id_round_trips() {
        for id in [
            "abc123_20261112T190000Z",
            "abc123_20261112",
            "has_under_scores_20261112T190000Z",
        ] {
            let (master, at) = parse_instance_id(id).unwrap();
            assert_eq!(instance_id(&master, &at), id);
        }
        let (master, at) = parse_instance_id("has_under_scores_20261112T190000Z").unwrap();
        assert_eq!(master, "has_under_scores");
        assert_eq!(at, OriginalStart::Ms(NOV_12_19_UTC));
        let (_, at) = parse_instance_id("abc_20261112").unwrap();
        assert_eq!(
            at,
            OriginalStart::Date(NaiveDate::from_ymd_opt(2026, 11, 12).unwrap())
        );
        assert!(parse_instance_id("plainid").is_none());
        assert!(parse_instance_id("abc_notadate").is_none());
    }
}
