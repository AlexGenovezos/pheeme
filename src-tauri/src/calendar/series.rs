//! Repeating-rule arithmetic: splitting a series in two for "this and following", and moving
//! every occurrence to another day for an "all events" date change.

use super::edit::OriginalStart;
use super::error::CalendarError;
use super::recurrence::{self, rule_count_before};
use crate::db::calendar::DbEvent;
use chrono::{NaiveDate, NaiveDateTime, TimeDelta, TimeZone, Utc};

const UNREADABLE: &str = "Pheeme couldn't read this event's repeat rule.";
const NOT_AN_OCCURRENCE: &str = "That occurrence isn't part of this series any more.";
const CHANGE_DAY_IN_EDITOR: &str = "Change the day for this series from Repeat in the editor.";
const WEEKDAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

fn invalid(message: &str) -> CalendarError {
    CalendarError::Invalid(message.to_owned())
}

/// A series' recurrence lines cut at one occurrence: `old` ends just before it, `new` starts
/// at it. Together they produce the original occurrences, each once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub old: Vec<String>,
    pub new: Vec<String>,
}

/// Cuts `master`'s recurrence at its occurrence `at`. `None` when nothing occurs before `at`
/// (it's the first occurrence), so the change applies to the whole series. Refuses an `at`
/// that isn't one of the series' occurrences.
pub fn split(master: &DbEvent, at: &OriginalStart) -> Result<Option<Split>, CalendarError> {
    let all_day = master.is_all_day();
    if all_day != matches!(at, OriginalStart::Date(_)) {
        return Err(invalid(NOT_AN_OCCURRENCE));
    }
    let lines = recurrence::recurrence_lines(master);
    let pos = recurrence::position(master, &lines, at).ok_or_else(|| invalid(UNREADABLE))?;
    if !pos.is_occurrence {
        return Err(invalid(NOT_AN_OCCURRENCE));
    }
    if pos.before == 0 {
        return Ok(None);
    }
    let at_ms = recurrence::at_ms(at);
    let tz = recurrence::zone(master.time_zone.as_deref());
    let (mut old, mut new) = (Vec::new(), Vec::new());
    for line in &lines {
        let line = line.trim();
        let (head, values) = line.split_once(':').ok_or_else(|| invalid(UNREADABLE))?;
        let (o, n) = match name_of(head).as_str() {
            "RRULE" => split_rule(master, line, values, at)?,
            "EXDATE" | "RDATE" => split_dates(head, values, at_ms, all_day, tz)?,
            _ => return Err(invalid(UNREADABLE)),
        };
        old.extend(o);
        new.extend(n);
    }
    Ok(Some(Split { old, new }))
}

/// The recurrence that ends `master` just before `at`, for "delete this and following";
/// `None` when `at` is the first occurrence (delete the whole series).
pub fn truncate(
    master: &DbEvent,
    at: &OriginalStart,
) -> Result<Option<Vec<String>>, CalendarError> {
    Ok(split(master, at)?.map(|s| s.old))
}

fn name_of(head: &str) -> String {
    head.split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase()
}

fn param<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    head.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim().eq_ignore_ascii_case(key).then_some(v.trim())
    })
}

fn is_part(part: &str, key: &str) -> bool {
    part.split_once('=')
        .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(key))
}

fn part_value<'a>(parts: &[&'a str], key: &str) -> Option<&'a str> {
    parts
        .iter()
        .find(|p| is_part(p, key))
        .and_then(|p| p.split_once('='))
        .map(|(_, v)| v.trim())
}

/// One RRULE's halves. A rule that ended before `at` stays whole in the old series; one
/// that hadn't begun goes only to the new.
fn split_rule(
    master: &DbEvent,
    line: &str,
    rule: &str,
    at: &OriginalStart,
) -> Result<(Option<String>, Option<String>), CalendarError> {
    let mut single = master.clone();
    single.recurrence = Some(serde_json::to_string(&[line]).map_err(|_| invalid(UNREADABLE))?);
    let pos =
        recurrence::position(&single, &[line.to_owned()], at).ok_or_else(|| invalid(UNREADABLE))?;
    if !pos.continues {
        return Ok((Some(line.to_owned()), None));
    }
    let parts: Vec<&str> = rule.split(';').collect();
    let until = match at {
        OriginalStart::Date(d) => d
            .pred_opt()
            .ok_or_else(|| invalid(UNREADABLE))?
            .format("%Y%m%d")
            .to_string(),
        OriginalStart::Ms(ms) => Utc
            .timestamp_millis_opt(ms - 1000)
            .single()
            .ok_or_else(|| invalid(UNREADABLE))?
            .format("%Y%m%dT%H%M%SZ")
            .to_string(),
    };
    let old = (pos.before > 0).then(|| {
        let until = format!("UNTIL={until}");
        let mut out: Vec<&str> = Vec::with_capacity(parts.len() + 1);
        let mut placed = false;
        for p in &parts {
            if is_part(p, "COUNT") || is_part(p, "UNTIL") {
                if !placed {
                    out.push(&until);
                    placed = true;
                }
            } else {
                out.push(p);
            }
        }
        if !placed {
            out.push(&until);
        }
        format!("RRULE:{}", out.join(";"))
    });
    let new = match part_value(&parts, "COUNT") {
        None => Some(line.to_owned()),
        Some(count) => {
            let count: usize = count.parse().map_err(|_| invalid(UNREADABLE))?;
            let left = count.saturating_sub(rule_count_before(&single, at));
            (left > 0).then(|| {
                let replaced: Vec<String> = parts
                    .iter()
                    .map(|p| {
                        if is_part(p, "COUNT") {
                            format!("COUNT={left}")
                        } else {
                            (*p).to_owned()
                        }
                    })
                    .collect();
                format!("RRULE:{}", replaced.join(";"))
            })
        }
    };
    Ok((old, new))
}

/// One EXDATE/RDATE line's values, before `at` to the old series and the rest to the new.
fn split_dates(
    head: &str,
    values: &str,
    at_ms: i64,
    all_day: bool,
    series_tz: chrono_tz::Tz,
) -> Result<(Option<String>, Option<String>), CalendarError> {
    let kind = param(head, "VALUE").map(str::to_ascii_uppercase);
    if kind
        .as_deref()
        .is_some_and(|k| k != "DATE" && k != "DATE-TIME")
    {
        return Err(invalid(UNREADABLE));
    }
    let zone = match param(head, "TZID") {
        Some(name) => Some(
            name.trim_matches('"')
                .parse::<chrono_tz::Tz>()
                .map_err(|_| invalid(UNREADABLE))?,
        ),
        None => None,
    };
    // Floating values belong to the series: its zone, or UTC for all-day series (pinned to
    // UTC midnight when expanded).
    let zone = zone.unwrap_or(if all_day { chrono_tz::UTC } else { series_tz });
    let (mut old, mut new) = (Vec::new(), Vec::new());
    for v in values.split(',').map(str::trim).filter(|v| !v.is_empty()) {
        let ms = value_ms(v, zone).ok_or_else(|| invalid(UNREADABLE))?;
        if ms < at_ms {
            old.push(v);
        } else {
            new.push(v);
        }
    }
    let line = |vals: Vec<&str>| (!vals.is_empty()).then(|| format!("{head}:{}", vals.join(",")));
    Ok((line(old), line(new)))
}

/// An EXDATE/RDATE value as ms: `YYYYMMDD` (midnight in `zone`), `YYYYMMDDTHHMMSSZ` (UTC) or
/// `YYYYMMDDTHHMMSS` (local to `zone`).
fn value_ms(v: &str, zone: chrono_tz::Tz) -> Option<i64> {
    let local = if v.len() == 8 {
        NaiveDate::parse_from_str(v, "%Y%m%d")
            .ok()?
            .and_time(chrono::NaiveTime::MIN)
    } else if let Some(utc) = v.strip_suffix(['Z', 'z']) {
        let t = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some(t.and_utc().timestamp_millis());
    } else {
        NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?
    };
    zone.from_local_datetime(&local)
        .earliest()
        .map(|t| t.timestamp_millis())
}

/// The recurrence lines for a series whose every occurrence moves `days` days: weekdays in
/// BYDAY (keeping any ordinal, so `2TU` becomes `2WE`), BYMONTHDAY, UNTIL and every
/// EXDATE/RDATE move with it. Refuses rules that can't follow the move exactly.
pub fn shift_days(recurrence: &[String], days: i64) -> Result<Vec<String>, CalendarError> {
    if days == 0 {
        return Ok(recurrence.to_vec());
    }
    recurrence
        .iter()
        .map(|line| {
            let line = line.trim();
            let (head, values) = line.split_once(':').ok_or_else(|| invalid(UNREADABLE))?;
            match name_of(head).as_str() {
                "RRULE" => Ok(format!("{head}:{}", shift_rule(values, days)?)),
                "EXDATE" | "RDATE" => {
                    let kind = param(head, "VALUE").map(str::to_ascii_uppercase);
                    if kind
                        .as_deref()
                        .is_some_and(|k| k != "DATE" && k != "DATE-TIME")
                    {
                        return Err(invalid(UNREADABLE));
                    }
                    let shifted = values
                        .split(',')
                        .map(|v| shift_value(v.trim(), days).ok_or_else(|| invalid(UNREADABLE)))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(format!("{head}:{}", shifted.join(",")))
                }
                _ => Err(invalid(UNREADABLE)),
            }
        })
        .collect()
}

fn shift_rule(rule: &str, days: i64) -> Result<String, CalendarError> {
    let parts: Vec<&str> = rule.split(';').collect();
    if ["BYSETPOS", "BYYEARDAY", "BYWEEKNO"]
        .iter()
        .any(|k| part_value(&parts, k).is_some())
    {
        return Err(invalid(CHANGE_DAY_IN_EDITOR));
    }
    let weekly = part_value(&parts, "FREQ").is_some_and(|f| f.eq_ignore_ascii_case("WEEKLY"));
    let interval: i64 = match part_value(&parts, "INTERVAL") {
        Some(i) => i.parse().map_err(|_| invalid(UNREADABLE))?,
        None => 1,
    };
    let week_start = match part_value(&parts, "WKST") {
        Some(w) => weekday(w).ok_or_else(|| invalid(UNREADABLE))?,
        None => 0,
    };
    let step = days.rem_euclid(7) as usize;
    parts
        .iter()
        .map(|p| {
            let Some((key, value)) = p.split_once('=') else {
                return Ok((*p).to_owned());
            };
            let key = key.trim();
            if key.eq_ignore_ascii_case("BYDAY") {
                let mut weeks = std::collections::HashSet::new();
                let shifted = value
                    .split(',')
                    .map(|entry| {
                        let entry = entry.trim();
                        let split = entry
                            .len()
                            .checked_sub(2)
                            .ok_or_else(|| invalid(UNREADABLE))?;
                        let (ordinal, code) = (&entry[..split], &entry[split..]);
                        let ordinal_ok = ordinal
                            .strip_prefix(['+', '-'])
                            .unwrap_or(ordinal)
                            .chars()
                            .all(|c| c.is_ascii_digit());
                        let day = weekday(code)
                            .filter(|_| ordinal_ok)
                            .ok_or_else(|| invalid(UNREADABLE))?;
                        // Which week (counted from WKST) the moved day lands in.
                        weeks.insert((((day + 7 - week_start) % 7) as i64 + days).div_euclid(7));
                        Ok(format!("{ordinal}{}", WEEKDAYS[(day + step) % 7]))
                    })
                    .collect::<Result<Vec<_>, CalendarError>>()?;
                // Every other week on Sunday and Monday, a day later, can't be said with a
                // two-week rule: the days now fall in different weeks of the cycle.
                if weekly && interval > 1 && weeks.len() > 1 {
                    return Err(invalid(CHANGE_DAY_IN_EDITOR));
                }
                Ok(format!("{key}={}", shifted.join(",")))
            } else if key.eq_ignore_ascii_case("BYMONTHDAY") {
                let shifted = value
                    .split(',')
                    .map(|d| {
                        let d: i64 = d.trim().parse().map_err(|_| invalid(UNREADABLE))?;
                        // Days 29–31 and counts from the month's end skip some months, so
                        // moving them would add or lose occurrences.
                        let moved = d + days;
                        if !(1..=28).contains(&d) || !(1..=28).contains(&moved) {
                            return Err(invalid(CHANGE_DAY_IN_EDITOR));
                        }
                        Ok(moved.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(format!("{key}={}", shifted.join(",")))
            } else if key.eq_ignore_ascii_case("UNTIL") {
                let until = shift_value(value.trim(), days).ok_or_else(|| invalid(UNREADABLE))?;
                Ok(format!("{key}={until}"))
            } else {
                Ok((*p).to_owned())
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join(";"))
}

fn weekday(code: &str) -> Option<usize> {
    WEEKDAYS.iter().position(|w| w.eq_ignore_ascii_case(code))
}

/// A date or date-time value `days` days later, in the same form.
fn shift_value(v: &str, days: i64) -> Option<String> {
    let delta = TimeDelta::try_days(days)?;
    if v.len() == 8 {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(d.checked_add_signed(delta)?.format("%Y%m%d").to_string());
    }
    let (t, z) = match v.strip_suffix(['Z', 'z']) {
        Some(t) => (t, "Z"),
        None => (v, ""),
    };
    let t = NaiveDateTime::parse_from_str(t, "%Y%m%dT%H%M%S").ok()?;
    Some(format!(
        "{}{z}",
        t.checked_add_signed(delta)?.format("%Y%m%dT%H%M%S")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::edit::OriginalStart;
    use crate::calendar::recurrence::{expand, rule_count_before};
    use crate::db::calendar::DbEvent;
    use chrono::{NaiveDate, TimeZone, Utc};

    const NY: &str = "America/New_York";

    fn ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
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

    fn all_day_series(start: &str, recurrence: &[&str]) -> DbEvent {
        let d = day(start);
        let mut e = series(
            &format!("{start}T00:00:00Z"),
            &format!("{start}T00:00:00Z"),
            recurrence,
        );
        e.end_ms = Some(e.start_ms.unwrap() + 24 * 3_600_000);
        e.start_date = Some(start.into());
        e.end_date = Some(d.succ_opt().unwrap().format("%Y-%m-%d").to_string());
        e.time_zone = None;
        e
    }

    /// The second half of a split: the same event starting at `at`, with `recurrence`.
    fn continued(master: &DbEvent, at: &OriginalStart, recurrence: &[String]) -> DbEvent {
        let mut e = master.clone();
        let duration = master.end_ms.unwrap() - master.start_ms.unwrap();
        match at {
            OriginalStart::Ms(t) => e.start_ms = Some(*t),
            OriginalStart::Date(d) => {
                e.start_ms = Some(d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis());
                e.start_date = Some(d.format("%Y-%m-%d").to_string());
                e.end_date = Some(d.succ_opt().unwrap().format("%Y-%m-%d").to_string());
            }
        }
        e.end_ms = Some(e.start_ms.unwrap() + duration);
        e.recurrence = Some(serde_json::to_string(recurrence).unwrap());
        e
    }

    fn with_rules(master: &DbEvent, recurrence: &[String]) -> DbEvent {
        let mut e = master.clone();
        e.recurrence = Some(serde_json::to_string(recurrence).unwrap());
        e
    }

    /// Every occurrence of `e` from 2026 through 2027, as UTC times or dates.
    fn all(e: &DbEvent) -> Vec<String> {
        expand(
            e,
            &[],
            ms("2026-01-01T00:00:00Z"),
            ms("2028-01-01T00:00:00Z"),
            chrono_tz::UTC,
        )
        .iter()
        .map(|o| match (o.start_ms, &o.start_date) {
            (Some(t), _) => Utc
                .timestamp_millis_opt(t)
                .unwrap()
                .format("%Y-%m-%dT%H:%MZ")
                .to_string(),
            (None, Some(d)) => d.clone(),
            _ => unreachable!(),
        })
        .collect()
    }

    /// Splits `master` at `at` and checks the halves add up to the original exactly.
    fn split_and_check(master: &DbEvent, at: &OriginalStart) -> (Split, usize, usize) {
        let s = split(master, at)
            .unwrap()
            .expect("not the first occurrence");
        let old = all(&with_rules(master, &s.old));
        let new = all(&continued(master, at, &s.new));
        let mut union = old.clone();
        union.extend(new.iter().cloned());
        assert_eq!(union, all(master), "old {:?} + new {:?}", s.old, s.new);
        (s, old.len(), new.len())
    }

    fn weekly_monday(rule: &str) -> DbEvent {
        series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &[rule],
        )
    }

    #[test]
    fn split_count_series_keeps_every_occurrence_once() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO");
        // The 4th Monday, after New York left daylight time: 09:00 EST.
        let at = OriginalStart::Ms(ms("2026-11-16T14:00:00Z"));
        let (s, old, new) = split_and_check(&master, &at);
        assert_eq!((old, new), (3, 7));
        assert_eq!(
            s.old,
            lines(&["RRULE:FREQ=WEEKLY;UNTIL=20261116T135959Z;BYDAY=MO"])
        );
        assert_eq!(s.new, lines(&["RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=MO"]));
    }

    #[test]
    fn split_until_series() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261222T045959Z");
        let at = OriginalStart::Ms(ms("2026-11-09T14:00:00Z"));
        let (s, old, new) = split_and_check(&master, &at);
        assert_eq!((old, new), (2, 7));
        assert_eq!(
            s.old,
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T135959Z"])
        );
        assert_eq!(
            s.new,
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261222T045959Z"])
        );
    }

    #[test]
    fn split_open_ended_series() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;BYDAY=MO");
        let at = OriginalStart::Ms(ms("2026-11-02T14:00:00Z"));
        let (s, old, _) = split_and_check(&master, &at);
        assert_eq!(old, 1);
        assert_eq!(
            s.old,
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T135959Z"])
        );
        assert_eq!(s.new, lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO"]));
    }

    #[test]
    fn split_all_day_series_uses_date_until() {
        let master = all_day_series(
            "2026-11-08",
            &[
                "RRULE:FREQ=DAILY;COUNT=10",
                "EXDATE;VALUE=DATE:20261109,20261114",
            ],
        );
        let at = OriginalStart::Date(day("2026-11-11"));
        let (s, old, new) = split_and_check(&master, &at);
        assert_eq!((old, new), (2, 6));
        assert_eq!(
            s.old,
            lines(&[
                "RRULE:FREQ=DAILY;UNTIL=20261110",
                "EXDATE;VALUE=DATE:20261109"
            ])
        );
        assert_eq!(
            s.new,
            lines(&["RRULE:FREQ=DAILY;COUNT=7", "EXDATE;VALUE=DATE:20261114"])
        );
    }

    #[test]
    fn split_keeps_exdates_on_their_side() {
        let master = series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12",
                "EXDATE;TZID=America/New_York:20261102T090000,20261123T090000",
                "EXDATE:20261207T140000Z",
                // 12:00 in New York is after the 09:00 split even though "120000" in UTC
                // would not be.
                "RDATE;TZID=America/New_York:20261116T120000",
            ],
        );
        let at = OriginalStart::Ms(ms("2026-11-16T14:00:00Z"));
        let (s, old, new) = split_and_check(&master, &at);
        assert_eq!((old, new), (2, 8));
        assert_eq!(
            s.old,
            lines(&[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T135959Z",
                "EXDATE;TZID=America/New_York:20261102T090000",
            ])
        );
        assert_eq!(
            s.new,
            lines(&[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=9",
                "EXDATE;TZID=America/New_York:20261123T090000",
                "EXDATE:20261207T140000Z",
                "RDATE;TZID=America/New_York:20261116T120000",
            ])
        );
    }

    #[test]
    fn count_ignores_exdates() {
        // RFC 5545: COUNT counts the rule's occurrences before EXDATE removes any.
        let master = series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
                "EXDATE;TZID=America/New_York:20261102T090000",
            ],
        );
        let at = OriginalStart::Ms(ms("2026-11-16T14:00:00Z"));
        assert_eq!(rule_count_before(&master, &at), 3);
        let (s, old, new) = split_and_check(&master, &at);
        assert_eq!((old, new), (2, 7));
        assert_eq!(s.new[0], "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=7");
    }

    #[test]
    fn split_at_first_occurrence_is_none() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO");
        let at = OriginalStart::Ms(ms("2026-10-26T13:00:00Z"));
        assert!(split(&master, &at).unwrap().is_none());
        assert!(truncate(&master, &at).unwrap().is_none());
        // The first one left after an EXDATE counts as first too.
        let master = series(
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO",
                "EXDATE;TZID=America/New_York:20261026T090000",
            ],
        );
        let at = OriginalStart::Ms(ms("2026-11-02T14:00:00Z"));
        assert!(split(&master, &at).unwrap().is_none());
    }

    #[test]
    fn split_refuses_a_time_that_is_not_an_occurrence() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO");
        for at in [
            OriginalStart::Ms(ms("2026-11-16T15:00:00Z")),
            OriginalStart::Ms(ms("2027-06-07T13:00:00Z")),
            OriginalStart::Date(day("2026-11-16")),
        ] {
            assert!(matches!(
                split(&master, &at),
                Err(CalendarError::Invalid(_))
            ));
        }
    }

    #[test]
    fn truncate_returns_the_old_half() {
        let master = weekly_monday("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO");
        let at = OriginalStart::Ms(ms("2026-11-16T14:00:00Z"));
        assert_eq!(
            truncate(&master, &at).unwrap(),
            Some(lines(&[
                "RRULE:FREQ=WEEKLY;UNTIL=20261116T135959Z;BYDAY=MO"
            ]))
        );
    }

    #[test]
    fn shift_days_moves_weekdays() {
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]), 1).unwrap(),
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"])
        );
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=WEEKLY;BYDAY=SU"]), 1).unwrap(),
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO"])
        );
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=WEEKLY;BYDAY=MO"]), -8).unwrap(),
            lines(&["RRULE:FREQ=WEEKLY;BYDAY=SU"])
        );
    }

    #[test]
    fn shift_days_keeps_ordinals() {
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=MONTHLY;BYDAY=2TU"]), 1).unwrap(),
            lines(&["RRULE:FREQ=MONTHLY;BYDAY=2WE"])
        );
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=MONTHLY;BYDAY=-1MO"]), -1).unwrap(),
            lines(&["RRULE:FREQ=MONTHLY;BYDAY=-1SU"])
        );
    }

    #[test]
    fn shift_days_moves_month_days_within_1_to_28() {
        assert_eq!(
            shift_days(&lines(&["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"]), 3).unwrap(),
            lines(&["RRULE:FREQ=MONTHLY;BYMONTHDAY=18"])
        );
        for (rule, days) in [
            ("RRULE:FREQ=MONTHLY;BYMONTHDAY=28", 1),
            ("RRULE:FREQ=MONTHLY;BYMONTHDAY=1", -1),
            ("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1", -1),
            ("RRULE:FREQ=MONTHLY;BYMONTHDAY=31", -3),
        ] {
            assert!(
                matches!(
                    shift_days(&lines(&[rule]), days),
                    Err(CalendarError::Invalid(_))
                ),
                "{rule} {days}"
            );
        }
    }

    #[test]
    fn shift_days_refuses_bysetpos() {
        let got = shift_days(
            &lines(&["RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"]),
            1,
        );
        match got {
            Err(CalendarError::Invalid(m)) => {
                assert_eq!(
                    m,
                    "Change the day for this series from Repeat in the editor."
                )
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn shift_days_refuses_fortnightly_days_crossing_the_week_start() {
        // Every other week on Sunday and Monday: a day later, the Sunday becomes a Monday in
        // the off week, which a two-week rule can't say.
        assert!(matches!(
            shift_days(&lines(&["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO"]), 1),
            Err(CalendarError::Invalid(_))
        ));
        assert!(shift_days(&lines(&["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"]), 1).is_ok());
        assert!(shift_days(&lines(&["RRULE:FREQ=WEEKLY;BYDAY=SU,MO"]), 1).is_ok());
    }

    #[test]
    fn shift_days_moves_exdates_and_until() {
        let got = shift_days(
            &lines(&[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261222T045959Z",
                "EXDATE;TZID=America/New_York:20261102T090000,20261130T090000",
                "EXDATE:20261116T140000Z",
                "RDATE;VALUE=DATE:20261231",
            ]),
            1,
        )
        .unwrap();
        assert_eq!(
            got,
            lines(&[
                "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261223T045959Z",
                "EXDATE;TZID=America/New_York:20261103T090000,20261201T090000",
                "EXDATE:20261117T140000Z",
                "RDATE;VALUE=DATE:20270101",
            ])
        );
    }

    #[test]
    fn shifted_series_keeps_its_exceptions() {
        let master = series(
            "2026-11-09T09:00:00-05:00",
            "2026-11-09T09:15:00-05:00",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6",
                "EXDATE;TZID=America/New_York:20261123T090000",
            ],
        );
        let mut moved = with_rules(
            &master,
            &shift_days(
                &lines(&[
                    "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6",
                    "EXDATE;TZID=America/New_York:20261123T090000",
                ]),
                1,
            )
            .unwrap(),
        );
        moved.start_ms = Some(ms("2026-11-10T09:00:00-05:00"));
        moved.end_ms = Some(ms("2026-11-10T09:15:00-05:00"));
        let shifted: Vec<String> = all(&master)
            .iter()
            .map(|s| {
                let t = chrono::DateTime::parse_from_rfc3339(&s.replace('Z', ":00Z")).unwrap();
                (t + chrono::Duration::days(1))
                    .format("%Y-%m-%dT%H:%MZ")
                    .to_string()
            })
            .collect();
        assert_eq!(all(&moved), shifted);
        assert_eq!(shifted.len(), 5);
    }
}
