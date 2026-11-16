//! Guests' availability for the event editor's planner: one `freeBusy.query` for the account
//! itself (its primary calendar) and every guest over a time range, answered per person as busy
//! intervals or "unknown" with Google's reason. Asked live and never cached: free/busy changes
//! on other people's calendars, which sync never sees.

use super::service::{CalendarEventDto, CalendarService};
use crate::db;
use crate::gmail::calendar::FreeBusyCalendar;
use crate::gmail::GmailError;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Weekday};
use chrono_tz::Tz;
use serde::Serialize;
use std::collections::HashMap;

/// `freeBusy` answers at most 50 calendars per query; one of them is the account's own.
pub const MAX_GUESTS: usize = 49;
/// The longest range one check covers (Google refuses much longer ones).
pub const MAX_RANGE_MS: i64 = 62 * 24 * 3_600_000;
/// The id `freeBusy` reads the account's own calendar by.
const OWN_CALENDAR: &str = "primary";

#[derive(Debug, thiserror::Error)]
pub enum AvailabilityError {
    #[error("Allow Pheeme to see guests' availability on Google Calendar.")]
    MissingScope,
    #[error("Turn on the Google Calendar API in your Google Cloud project, then try again.")]
    ApiDisabled,
    #[error("{0}")]
    Invalid(String),
    #[error("You're offline; availability can't be checked.")]
    Offline,
    #[error("Google Calendar couldn't check availability: {}", .0.google_message())]
    Google(GmailError),
    #[error("Pheeme couldn't check availability: {0}")]
    Db(#[from] anyhow::Error),
}

impl AvailabilityError {
    pub fn code(&self) -> &str {
        match self {
            Self::MissingScope => "missing_scope",
            Self::ApiDisabled => "api_disabled",
            Self::Invalid(_) => "invalid_input",
            Self::Offline => "network",
            Self::Google(e) => e.code(),
            Self::Db(_) => "internal",
        }
    }
}

impl From<GmailError> for AvailabilityError {
    fn from(e: GmailError) -> Self {
        if e.is_api_disabled() {
            Self::ApiDisabled
        } else if e.is_missing_scope() {
            Self::MissingScope
        } else if matches!(e, GmailError::Offline(_) | GmailError::Network(_)) {
            Self::Offline
        } else {
            Self::Google(e)
        }
    }
}

/// One busy stretch, UTC ms, end exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusyDto {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// What Google could tell about one person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Availability {
    /// Busy time in the range (empty: free throughout).
    Known { busy: Vec<BusyDto> },
    /// Google couldn't say: `notFound` (not shared, or another domain), or another reason.
    Unknown { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonAvailability {
    pub email: String,
    #[serde(flatten)]
    pub availability: Availability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityDto {
    /// The account itself (its primary calendar).
    pub you: PersonAvailability,
    /// One per requested guest, in the order asked, duplicates dropped.
    pub guests: Vec<PersonAvailability>,
}

fn availability(answer: Option<&FreeBusyCalendar>) -> Availability {
    match answer {
        Some(a) if a.errors.is_empty() => {
            let mut busy: Vec<BusyDto> = a
                .busy
                .iter()
                .filter(|(s, e)| e > s)
                .map(|&(start_ms, end_ms)| BusyDto { start_ms, end_ms })
                .collect();
            busy.sort_by_key(|b| (b.start_ms, b.end_ms));
            Availability::Known { busy }
        }
        Some(a) => Availability::Unknown {
            reason: a.errors[0].clone(),
        },
        None => Availability::Unknown {
            reason: "unknown".into(),
        },
    }
}

/// The guests to ask about: trimmed, without duplicates (in any case), in order.
fn guest_list(emails: &[String]) -> Result<Vec<String>, AvailabilityError> {
    let mut out: Vec<String> = Vec::new();
    for email in emails.iter().map(|e| e.trim()) {
        if !email.contains('@') || email.chars().any(char::is_whitespace) {
            return Err(AvailabilityError::Invalid(format!(
                "“{email}” isn't an email address."
            )));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(email)) {
            out.push(email.to_owned());
        }
    }
    if out.len() > MAX_GUESTS {
        return Err(AvailabilityError::Invalid(format!(
            "Availability can be checked for up to {MAX_GUESTS} guests at a time."
        )));
    }
    Ok(out)
}

impl CalendarService {
    /// Busy time in `[from_ms, to_ms)` for the account and each guest, from Google (not the
    /// cache). Needs the free/busy consent (`missing_scope` until it's allowed).
    pub async fn availability(
        &self,
        account_id: &str,
        emails: &[String],
        from_ms: i64,
        to_ms: i64,
    ) -> Result<AvailabilityDto, AvailabilityError> {
        if to_ms <= from_ms || to_ms - from_ms > MAX_RANGE_MS {
            return Err(AvailabilityError::Invalid(
                "Availability can be checked for up to 62 days at a time.".into(),
            ));
        }
        let guests = guest_list(emails)?;
        let account = db::accounts::get_account(&self.db, account_id)
            .await?
            .ok_or_else(|| {
                AvailabilityError::Invalid("That account isn't connected any more.".into())
            })?;
        let mut ids = vec![OWN_CALENDAR.to_owned()];
        ids.extend(guests.iter().cloned());
        let answers = (self.api_for)(account_id)
            .free_busy(&ids, from_ms, to_ms)
            .await?;
        // Google answers keyed by the id asked for; match without regard to case to be safe.
        let lower: HashMap<String, &FreeBusyCalendar> = answers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .collect();
        let find = |id: &str| lower.get(&id.to_ascii_lowercase()).copied();
        Ok(AvailabilityDto {
            you: PersonAvailability {
                email: account.email,
                availability: availability(find(OWN_CALENDAR)),
            },
            guests: guests
                .into_iter()
                .map(|email| PersonAvailability {
                    availability: availability(find(&email)),
                    email,
                })
                .collect(),
        })
    }
}

/// The moment a wall-clock time names in `tz` (the earlier one when clocks go back).
pub(crate) fn local_ms(tz: Tz, naive: NaiveDateTime) -> Option<i64> {
    tz.from_local_datetime(&naive)
        .earliest()
        .or_else(|| {
            tz.from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
        })
        .map(|d| d.timestamp_millis())
}

pub(crate) fn day_of(tz: Tz, ms: i64) -> NaiveDate {
    tz.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_default()
}

/// Merged busy intervals of `events`: timed, not cancelled or declined, not marked free.
pub(crate) fn busy(events: &[&CalendarEventDto]) -> Vec<(i64, i64)> {
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

/// Free slots of at least `minutes` in `[from, to)`, inside `[start, end)` of each day (in
/// `tz`), skipping weekends unless `weekends`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn free_slots(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::service::tests::{harness, ms};
    use serde_json::json;

    const DAY: i64 = 24 * 3_600_000;

    #[tokio::test]
    async fn answers_you_and_each_guest_with_busy_time_or_unknown() {
        let h = harness(&["a"]).await;
        let from = ms("2026-11-16T05:00:00Z");
        let to = from + DAY;
        let fake = h.fake("a");
        fake.set_busy(
            "primary",
            vec![
                (ms("2026-11-16T15:00:00Z"), ms("2026-11-16T16:00:00Z")),
                (ms("2026-11-16T13:00:00Z"), ms("2026-11-16T14:00:00Z")),
            ],
        );
        fake.set_busy(
            "sam@example.com",
            vec![(ms("2026-11-16T17:00:00Z"), ms("2026-11-16T18:00:00Z"))],
        );
        fake.set_busy("free@example.com", vec![]);

        let got = h
            .service
            .availability(
                "a",
                &[
                    "sam@example.com".into(),
                    " SAM@example.com".into(),
                    "free@example.com".into(),
                    "x@other.org".into(),
                ],
                from,
                to,
            )
            .await
            .unwrap();

        assert_eq!(got.you.email, "a@example.com");
        assert_eq!(
            got.you.availability,
            Availability::Known {
                busy: vec![
                    BusyDto {
                        start_ms: ms("2026-11-16T13:00:00Z"),
                        end_ms: ms("2026-11-16T14:00:00Z")
                    },
                    BusyDto {
                        start_ms: ms("2026-11-16T15:00:00Z"),
                        end_ms: ms("2026-11-16T16:00:00Z")
                    },
                ]
            }
        );
        let emails: Vec<&str> = got.guests.iter().map(|g| g.email.as_str()).collect();
        assert_eq!(
            emails,
            ["sam@example.com", "free@example.com", "x@other.org"]
        );
        assert_eq!(
            got.guests[1].availability,
            Availability::Known { busy: vec![] }
        );
        assert_eq!(
            got.guests[2].availability,
            Availability::Unknown {
                reason: "notFound".into()
            }
        );
        // One query: the account's own calendar first, then each guest once.
        assert_eq!(
            fake.free_busy_queries(),
            vec![(
                vec![
                    "primary".to_string(),
                    "sam@example.com".into(),
                    "free@example.com".into(),
                    "x@other.org".into()
                ],
                from,
                to
            )]
        );
        assert_eq!(
            serde_json::to_value(&got.guests[0]).unwrap(),
            json!({"email": "sam@example.com", "status": "known", "busy": [
                {"startMs": ms("2026-11-16T17:00:00Z"), "endMs": ms("2026-11-16T18:00:00Z")}
            ]})
        );
        assert_eq!(
            serde_json::to_value(&got.guests[2]).unwrap(),
            json!({"email": "x@other.org", "status": "unknown", "reason": "notFound"})
        );
    }

    #[test]
    fn missing_answers_and_unexpected_reasons_are_unknown() {
        assert_eq!(
            availability(None),
            Availability::Unknown {
                reason: "unknown".into()
            }
        );
        let odd = FreeBusyCalendar {
            busy: vec![(1, 2)],
            errors: vec!["somethingNew".into()],
        };
        assert_eq!(
            availability(Some(&odd)),
            Availability::Unknown {
                reason: "somethingNew".into()
            }
        );
    }

    #[tokio::test]
    async fn refusals_map_to_codes_the_planner_acts_on() {
        let h = harness(&["a"]).await;
        let from = ms("2026-11-16T05:00:00Z");
        h.fake("a").fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        });
        let e = h
            .service
            .availability("a", &[], from, from + DAY)
            .await
            .unwrap_err();
        assert_eq!(e.code(), "missing_scope");
        h.fake("a")
            .fail_with(|| GmailError::Offline("no network".into()));
        let e = h
            .service
            .availability("a", &[], from, from + DAY)
            .await
            .unwrap_err();
        assert_eq!(e.code(), "network");
    }

    #[tokio::test]
    async fn rejects_bad_ranges_addresses_and_unknown_accounts_before_asking_google() {
        let h = harness(&["a"]).await;
        let from = ms("2026-11-16T05:00:00Z");
        let svc = &h.service;
        let code = |r: Result<AvailabilityDto, AvailabilityError>| r.unwrap_err().code().to_owned();
        assert_eq!(
            code(svc.availability("a", &[], from, from).await),
            "invalid_input"
        );
        assert_eq!(
            code(svc.availability("a", &[], from, from + 63 * DAY).await),
            "invalid_input"
        );
        assert_eq!(
            code(
                svc.availability("a", &["nope".into()], from, from + DAY)
                    .await
            ),
            "invalid_input"
        );
        let many: Vec<String> = (0..50).map(|i| format!("g{i}@example.com")).collect();
        assert_eq!(
            code(svc.availability("a", &many, from, from + DAY).await),
            "invalid_input"
        );
        assert_eq!(
            code(svc.availability("gone", &[], from, from + DAY).await),
            "invalid_input"
        );
        assert!(h.fake("a").free_busy_queries().is_empty());
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
}
