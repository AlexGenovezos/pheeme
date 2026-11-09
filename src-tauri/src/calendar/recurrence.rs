//! Repeating events, expanded locally. The cache holds a series once (its `recurrence` lines:
//! RRULE, EXDATE, RDATE) plus its changed and cancelled occurrences; the views ask for the
//! occurrences in a range, which are generated here so every view is instant and offline.

use crate::db::calendar::DbEvent;
use chrono::{DateTime, Days, NaiveDate, TimeZone, Utc};
use rrule::RRuleSet;
use std::collections::HashSet;

/// Most occurrences one call returns, so a malformed or huge range can't flood the UI.
pub const MAX_OCCURRENCES: usize = 1000;
/// Most occurrences generated while looking for the range: a daily series begun 25 years
/// ago is ~9,000 steps.
const MAX_STEPS: usize = 50_000;
/// Most steps spent finding where a bounded series ends; past it, treat it as open-ended.
const MAX_BOUND_STEPS: usize = 10_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Ranges are clamped to 1900–2200, which every zone conversion handles.
const MIN_MS: i64 = -2_208_988_800_000;
const MAX_MS: i64 = 7_258_118_400_000;

/// One generated occurrence of a series. Timed occurrences carry ms; all-day ones carry
/// dates only (end exclusive).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The series' event id (`None` only for the fallback when the rule can't be read).
    pub master_id: Option<String>,
    /// Google's instance id (`{master}_{YYYYMMDD}T{HHMMSS}Z`, or `{master}_{YYYYMMDD}`), so
    /// writes can address this occurrence.
    pub event_id: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub original_start_ms: Option<i64>,
}

fn zone(name: Option<&str>) -> chrono_tz::Tz {
    name.and_then(|n| n.parse().ok()).unwrap_or(chrono_tz::UTC)
}

fn date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// The series as iCalendar text the `rrule` crate reads: a DTSTART in the event's zone
/// (a date for all-day series) followed by Google's recurrence lines.
fn rule_text(
    recurrence: &[String],
    start_ms: i64,
    all_day_start: Option<NaiveDate>,
    tz: chrono_tz::Tz,
) -> String {
    let dtstart = match all_day_start {
        Some(d) => format!("DTSTART;VALUE=DATE:{}", d.format("%Y%m%d")),
        None => {
            let local = tz
                .timestamp_millis_opt(start_ms)
                .single()
                .unwrap_or_else(|| tz.from_utc_datetime(&DateTime::<Utc>::default().naive_utc()));
            if tz == chrono_tz::UTC {
                format!("DTSTART:{}", local.format("%Y%m%dT%H%M%SZ"))
            } else {
                format!(
                    "DTSTART;TZID={}:{}",
                    tz.name(),
                    local.format("%Y%m%dT%H%M%S")
                )
            }
        }
    };
    std::iter::once(dtstart)
        .chain(recurrence.iter().map(|l| l.trim().to_owned()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_set(event: &DbEvent, recurrence: &[String]) -> Option<RRuleSet> {
    let start_ms = event.start_ms?;
    let all_day = event.start_date.as_deref().and_then(date);
    let tz = zone(event.time_zone.as_deref());
    rule_text(recurrence, start_ms, all_day, tz).parse().ok()
}

fn recurrence_lines(event: &DbEvent) -> Vec<String> {
    event
        .recurrence
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or_default()
}

/// The occurrences of `master` overlapping `[from_ms, to_ms)`, minus those replaced by one
/// of `overrides` (changed or cancelled occurrences, matched by their original start). The
/// replacements themselves are the caller's to add. All-day occurrences overlap by their
/// dates as seen in `display_tz`.
pub fn expand(
    master: &DbEvent,
    overrides: &[&DbEvent],
    from_ms: i64,
    to_ms: i64,
    display_tz: chrono_tz::Tz,
) -> Vec<Occurrence> {
    let Some(start_ms) = master.start_ms else {
        return Vec::new();
    };
    let (from_ms, to_ms) = (from_ms.clamp(MIN_MS, MAX_MS), to_ms.clamp(MIN_MS, MAX_MS));
    let duration_ms = master
        .end_ms
        .unwrap_or(start_ms)
        .saturating_sub(start_ms)
        .max(0);
    let all_day = master.start_date.as_deref().and_then(date);
    let day_span = match (all_day, master.end_date.as_deref().and_then(date)) {
        (Some(s), Some(e)) => (e - s).num_days().max(1) as u64,
        _ => 1,
    };
    let replaced_ms: HashSet<i64> = overrides
        .iter()
        .filter_map(|o| o.original_start_ms)
        .collect();
    let replaced_dates: HashSet<&str> = overrides
        .iter()
        .filter_map(|o| o.original_start_date.as_deref())
        .collect();
    let to_local_date = |ms: i64| {
        display_tz
            .timestamp_millis_opt(ms)
            .single()
            .map(|d| d.date_naive())
    };
    let (Some(from_date), Some(last_date)) = (to_local_date(from_ms), to_local_date(to_ms - 1))
    else {
        return Vec::new();
    };

    let occurrence = |start: i64| -> Option<Occurrence> {
        if all_day.is_some() {
            let d = Utc.timestamp_millis_opt(start).single()?.date_naive();
            let end = d.checked_add_days(Days::new(day_span))?;
            if d > last_date
                || end <= from_date
                || replaced_dates.contains(d.format("%Y-%m-%d").to_string().as_str())
            {
                return None;
            }
            Some(Occurrence {
                master_id: Some(master.id.clone()),
                event_id: format!("{}_{}", master.id, d.format("%Y%m%d")),
                start_ms: None,
                end_ms: None,
                start_date: Some(d.format("%Y-%m-%d").to_string()),
                end_date: Some(end.format("%Y-%m-%d").to_string()),
                original_start_ms: None,
            })
        } else {
            let end = start + duration_ms;
            let overlaps =
                start < to_ms && (end > from_ms || (duration_ms == 0 && start >= from_ms));
            if !overlaps || replaced_ms.contains(&start) {
                return None;
            }
            let utc = Utc.timestamp_millis_opt(start).single()?;
            Some(Occurrence {
                master_id: Some(master.id.clone()),
                event_id: format!("{}_{}", master.id, utc.format("%Y%m%dT%H%M%SZ")),
                start_ms: Some(start),
                end_ms: Some(end),
                start_date: None,
                end_date: None,
                original_start_ms: Some(start),
            })
        }
    };

    let Some(set) = parse_set(master, &recurrence_lines(master)) else {
        // A rule we can't read: show the series' first occurrence rather than nothing.
        return occurrence(start_ms)
            .map(|mut o| {
                o.event_id = master.id.clone();
                vec![o]
            })
            .unwrap_or_default();
    };
    // All-day occurrences are UTC midnights; pad so dates a zone away still count.
    let stop_ms = to_ms + if all_day.is_some() { DAY_MS } else { 0 };
    let mut out = Vec::new();
    for start in set.into_iter().take(MAX_STEPS) {
        let start = start.timestamp_millis();
        if start >= stop_ms || out.len() >= MAX_OCCURRENCES {
            break;
        }
        if let Some(o) = occurrence(start) {
            out.push(o);
        }
    }
    out
}

/// When a bounded series (every RRULE has COUNT or UNTIL) ends: the last occurrence's end.
/// `None` for a series that never ends, or one too long to walk.
pub fn recur_until_ms(recurrence: &[String], start_ms: i64, end_ms: i64, tz: &str) -> Option<i64> {
    let rules: Vec<&String> = recurrence
        .iter()
        .filter(|l| l.trim_start().to_ascii_uppercase().starts_with("RRULE"))
        .collect();
    let bounded = |l: &&String| {
        let upper = l.to_ascii_uppercase();
        upper.contains("COUNT=") || upper.contains("UNTIL=")
    };
    if !rules.iter().all(bounded) {
        return None;
    }
    let tz = zone(Some(tz));
    let set: RRuleSet = rule_text(recurrence, start_ms, None, tz).parse().ok()?;
    let mut last = None;
    for (i, start) in set.into_iter().enumerate() {
        if i >= MAX_BOUND_STEPS {
            return None;
        }
        last = Some(start.timestamp_millis());
    }
    Some(last.unwrap_or(start_ms) + (end_ms - start_ms).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::calendar::DbEvent;
    use chrono::{TimeZone, Utc};

    const NY: &str = "America/New_York";

    fn ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    fn series(start: &str, end: &str, recurrence: &[&str]) -> DbEvent {
        DbEvent {
            account_id: "a".into(),
            calendar_id: "c".into(),
            id: "abc".into(),
            ical_uid: None,
            recurring_event_id: None,
            original_start_ms: None,
            original_start_date: None,
            status: "confirmed".into(),
            start_ms: Some(ms(start)),
            end_ms: Some(ms(end)),
            start_date: None,
            end_date: None,
            time_zone: Some(NY.into()),
            recurrence: Some(serde_json::to_string(recurrence).unwrap()),
            recur_until_ms: None,
            summary: None,
            location: None,
            description: None,
            organizer_email: None,
            self_response: None,
            attendees: "[]".into(),
            conference: None,
            color_id: None,
            transparency: None,
            visibility: None,
            reminders: None,
            html_link: None,
            etag: String::new(),
            updated_ms: 0,
            raw: "{}".into(),
        }
    }

    fn override_of(master: &DbEvent, original: &str, status: &str) -> DbEvent {
        let mut o = master.clone();
        o.id = format!("abc_{original}");
        o.recurrence = None;
        o.recurring_event_id = Some(master.id.clone());
        o.original_start_ms = Some(ms(original));
        o.status = status.into();
        o
    }

    fn starts(occ: &[Occurrence]) -> Vec<String> {
        occ.iter()
            .map(|o| {
                Utc.timestamp_millis_opt(o.start_ms.unwrap())
                    .unwrap()
                    .format("%Y-%m-%dT%H:%MZ")
                    .to_string()
            })
            .collect()
    }

    fn weekly_monday_standup() -> DbEvent {
        series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        )
    }

    #[test]
    fn weekly_series_in_its_zone_across_dst() {
        let got = expand(
            &weekly_monday_standup(),
            &[],
            ms("2026-10-26T00:00:00Z"),
            ms("2026-11-17T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(
            starts(&got),
            vec![
                "2026-10-26T13:00Z",
                "2026-11-02T14:00Z",
                "2026-11-09T14:00Z",
                "2026-11-16T14:00Z"
            ]
        );
        assert_eq!(got[1].end_ms, Some(ms("2026-11-02T14:15:00Z")));
        assert_eq!(got[1].master_id.as_deref(), Some("abc"));
        assert_eq!(got[1].original_start_ms, got[1].start_ms);
    }

    #[test]
    fn exdate_is_skipped() {
        let master = series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO",
                "EXDATE;TZID=America/New_York:20261109T090000",
            ],
        );
        let got = expand(
            &master,
            &[],
            ms("2026-11-01T00:00:00Z"),
            ms("2026-11-17T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(starts(&got), vec!["2026-11-02T14:00Z", "2026-11-16T14:00Z"]);
    }

    #[test]
    fn moved_occurrence_appears_once_at_new_time() {
        let master = weekly_monday_standup();
        let moved = override_of(&master, "2026-11-09T09:00:00-05:00", "confirmed");
        let got = expand(
            &master,
            &[&moved],
            ms("2026-11-01T00:00:00Z"),
            ms("2026-11-17T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(starts(&got), vec!["2026-11-02T14:00Z", "2026-11-16T14:00Z"]);
    }

    #[test]
    fn cancelled_occurrence_is_skipped() {
        let master = weekly_monday_standup();
        let cancelled = override_of(&master, "2026-11-02T09:00:00-05:00", "cancelled");
        let got = expand(
            &master,
            &[&cancelled],
            ms("2026-11-01T00:00:00Z"),
            ms("2026-11-10T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(starts(&got), vec!["2026-11-09T14:00Z"]);
    }

    #[test]
    fn all_day_series_keeps_dates() {
        let mut master = series(
            "2026-11-10T00:00:00Z",
            "2026-11-11T00:00:00Z",
            &["RRULE:FREQ=DAILY;COUNT=3"],
        );
        master.start_date = Some("2026-11-10".into());
        master.end_date = Some("2026-11-11".into());
        master.time_zone = None;
        // Los Angeles, Nov 9 16:00 – Nov 13 16:00 local.
        let got = expand(
            &master,
            &[],
            ms("2026-11-10T00:00:00Z"),
            ms("2026-11-14T00:00:00Z"),
            chrono_tz::America::Los_Angeles,
        );
        let dates: Vec<(&str, &str)> = got
            .iter()
            .map(|o| {
                (
                    o.start_date.as_deref().unwrap(),
                    o.end_date.as_deref().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            dates,
            vec![
                ("2026-11-10", "2026-11-11"),
                ("2026-11-11", "2026-11-12"),
                ("2026-11-12", "2026-11-13")
            ]
        );
        assert!(got.iter().all(|o| o.start_ms.is_none()));
        assert_eq!(got[0].event_id, "abc_20261110");
    }

    #[test]
    fn all_day_override_is_matched_by_date() {
        let mut master = series(
            "2026-11-10T00:00:00Z",
            "2026-11-11T00:00:00Z",
            &["RRULE:FREQ=DAILY;COUNT=3"],
        );
        master.start_date = Some("2026-11-10".into());
        master.end_date = Some("2026-11-11".into());
        let mut gone = master.clone();
        gone.id = "abc_20261111".into();
        gone.recurrence = None;
        gone.recurring_event_id = Some("abc".into());
        gone.original_start_date = Some("2026-11-11".into());
        gone.status = "cancelled".into();
        let got = expand(
            &master,
            &[&gone],
            ms("2026-11-01T00:00:00Z"),
            ms("2026-11-30T00:00:00Z"),
            chrono_tz::UTC,
        );
        let dates: Vec<&str> = got
            .iter()
            .map(|o| o.start_date.as_deref().unwrap())
            .collect();
        assert_eq!(dates, vec!["2026-11-10", "2026-11-12"]);
    }

    #[test]
    fn count_and_until_bound_series() {
        let start = ms("2026-10-26T09:00:00-04:00");
        let end = ms("2026-10-26T09:15:00-04:00");
        let count = recur_until_ms(&["RRULE:FREQ=WEEKLY;COUNT=3".into()], start, end, NY);
        assert_eq!(count, Some(ms("2026-11-09T14:15:00Z")));
        let until = recur_until_ms(
            &["RRULE:FREQ=WEEKLY;UNTIL=20261103T045959Z".into()],
            start,
            end,
            NY,
        );
        assert_eq!(until, Some(ms("2026-11-02T14:15:00Z")));
        assert_eq!(
            recur_until_ms(&["RRULE:FREQ=WEEKLY".into()], start, end, NY),
            None
        );
    }

    #[test]
    fn instance_ids_match_google_format() {
        let got = expand(
            &weekly_monday_standup(),
            &[],
            ms("2026-11-09T00:00:00Z"),
            ms("2026-11-10T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(got[0].event_id, "abc_20261109T140000Z");
    }

    #[test]
    fn unparseable_rule_yields_only_first_occurrence() {
        let master = series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &["RRULE:FREQ=SOMETIMES"],
        );
        let got = expand(
            &master,
            &[],
            ms("2026-10-01T00:00:00Z"),
            ms("2026-12-01T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(starts(&got), vec!["2026-10-26T13:00Z"]);
        assert_eq!(got[0].event_id, "abc");
    }

    #[test]
    fn long_running_daily_series_is_capped() {
        let master = series(
            "2000-01-01T09:00:00-05:00",
            "2000-01-01T09:15:00-05:00",
            &["RRULE:FREQ=DAILY"],
        );
        let got = expand(
            &master,
            &[],
            ms("2026-11-09T00:00:00Z"),
            ms("2026-11-16T00:00:00Z"),
            chrono_tz::UTC,
        );
        assert_eq!(got.len(), 7);
        let got = expand(&master, &[], 0, i64::MAX / 2, chrono_tz::UTC);
        assert_eq!(got.len(), MAX_OCCURRENCES);
    }
}
