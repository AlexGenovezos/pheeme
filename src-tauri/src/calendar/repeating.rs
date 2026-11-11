//! Changing repeating events three ways, as calendar.google.com does: one occurrence ("this
//! event"), an occurrence and every later one ("this and following", which splits the
//! series in two), or the whole series ("all events"). A mangled series (occurrences lost
//! or shown twice) is worse than a refused change, so anything that can't be done exactly is
//! refused before Google is called.

use super::edit::{self, EventEdit, OriginalStart, TimeInput};
use super::error::CalendarError;
use super::recurrence;
use super::series::{self, Split};
use super::service::{unstored_occurrence, CalendarService};
use super::writes::{can_edit, new_id, raw, zone_of, EditScope, EventRef, Target, NOT_COPIED};
use crate::db;
use crate::db::calendar::{DbCalendar, DbEvent};
use crate::gmail::calendar::{ApiEvent, SendUpdates, WriteOptions};
use crate::gmail::GmailError;
use chrono::{NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

const THIS_KEEPS_REPEAT: &str = "Repeat can only change for the whole series.";
const KIND_SWITCH: &str =
    "Change this series to all-day or timed from the editor's Repeat setting.";
const SPLIT_INCOMPLETE: &str = "The change was saved as a new series, but the old one couldn't \
     be shortened, so some occurrences show twice. Delete the extra ones.";
const NO_SERIES: &str =
    "Pheeme doesn't have the rest of this series, so only this event can change.";
const UNREADABLE_TIMES: &str = "Pheeme couldn't read this series' times.";
const NO_SUCH_TIME: &str =
    "That time doesn't exist on the series' first day, because the clocks change then.";
const ORGANIZER_ONLY: &str = "Only the organizer can change this event.";
const SPLIT_UNKNOWN: &str = "Pheeme couldn't tell whether the new part of this series was \
     saved, so some occurrences may show twice. Check this series on calendar.google.com.";

/// A write error after which the write may still have landed: a lost reply, or a server
/// error (writes with an etag aren't retried).
fn ambiguous(e: &GmailError) -> bool {
    matches!(e, GmailError::Network(_))
        || matches!(e, GmailError::Api { status, .. } if *status >= 500)
}

/// Whether Google's answer to a read says the event is gone.
fn is_gone(read: &Result<ApiEvent, GmailError>) -> bool {
    match read {
        Ok(e) => e.status.as_deref() == Some("cancelled"),
        Err(e) => e.is_not_found() || e.is_gone(),
    }
}

fn invalid(message: &str) -> CalendarError {
    CalendarError::Invalid(message.to_owned())
}

/// What a write addresses once a series is involved.
pub(super) enum Resolved {
    /// An event that neither repeats nor belongs to a series.
    Single(Box<DbEvent>),
    Series(Box<InSeries>),
}

/// One occurrence of a series: the series (when cached), the occurrence's original start,
/// and its own row when it was changed before.
pub(super) struct InSeries {
    pub(super) master: Option<DbEvent>,
    pub(super) at: OriginalStart,
    pub(super) row: Option<DbEvent>,
}

impl InSeries {
    /// The occurrence's id at Google: its row's, or the instance id.
    fn id(&self) -> String {
        match (&self.row, &self.master) {
            (Some(r), _) => r.id.clone(),
            (None, Some(m)) => edit::instance_id(&m.id, &self.at),
            (None, None) => String::new(),
        }
    }

    fn zone<'a>(&'a self, calendar: &'a DbCalendar) -> &'a str {
        self.master
            .iter()
            .chain(&self.row)
            .find_map(|e| e.time_zone.as_deref())
            .unwrap_or_else(|| zone_of(calendar))
    }
}

/// A series' first start, as an instance id would name it.
fn first_start(e: &DbEvent) -> Result<OriginalStart, CalendarError> {
    match (&e.start_date, e.start_ms) {
        (Some(d), _) => NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map(OriginalStart::Date)
            .map_err(|_| invalid(UNREADABLE_TIMES)),
        (None, Some(ms)) => Ok(OriginalStart::Ms(ms)),
        _ => Err(invalid(UNREADABLE_TIMES)),
    }
}

fn is_first(master: &DbEvent, at: &OriginalStart) -> bool {
    first_start(master).is_ok_and(|f| f == *at)
}

/// A changed occurrence's original start.
fn original_start(e: &DbEvent) -> Option<OriginalStart> {
    match (&e.original_start_date, e.original_start_ms) {
        (Some(d), _) => NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .ok()
            .map(OriginalStart::Date),
        (None, Some(ms)) => Some(OriginalStart::Ms(ms)),
        _ => None,
    }
}

/// `originalStartTime` as Google writes it.
fn original_start_json(at: &OriginalStart, zone: &str) -> Value {
    match at {
        OriginalStart::Date(d) => json!({ "date": d.format("%Y-%m-%d").to_string() }),
        OriginalStart::Ms(ms) => {
            let utc = Utc.timestamp_millis_opt(*ms).single().unwrap_or_default();
            json!({
                "dateTime": utc.to_rfc3339_opts(SecondsFormat::Secs, true),
                "timeZone": zone,
            })
        }
    }
}

fn parse_date(d: &str) -> Result<NaiveDate, CalendarError> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| invalid(UNREADABLE_TIMES))
}

fn date_input(d: NaiveDate) -> TimeInput {
    TimeInput {
        ms: None,
        date: Some(d.format("%Y-%m-%d").to_string()),
        time_zone: None,
    }
}

/// A series' new first times after an edit moved one occurrence (`at`), and where the
/// first occurrence lands when its rule has to move with it.
struct Moved {
    start: TimeInput,
    end: TimeInput,
    /// The new first start, when the series moved in time without changing kind.
    shift: Option<OriginalStart>,
    /// The series' new zone, when the move also changes it.
    zone: Option<chrono_tz::Tz>,
}

/// Switching a whole series between all-day and timed keeps its RRULE as is, which is
/// exact only when nothing in it names a date or time.
fn check_kind_switch(master: &DbEvent, own_rule: bool) -> Result<(), CalendarError> {
    let dated = recurrence::recurrence_lines(master).iter().any(|line| {
        let upper = line.trim().to_ascii_uppercase();
        upper.starts_with("EXDATE")
            || upper.starts_with("RDATE")
            || (upper.starts_with("RRULE") && upper.contains("UNTIL="))
    });
    if dated && !own_rule {
        return Err(invalid(KIND_SWITCH));
    }
    Ok(())
}

/// The times `master` gets when its occurrence `at` is moved to `start`..`end`: the series
/// moves by the same change, in wall-clock time from `zone` to the edit's zone (days for
/// all-day series), and keeps the edit's length. Between all-day and timed, the first date stays and takes the
/// edit's time; that can't also change the day.
fn series_times(
    master: &DbEvent,
    at: &OriginalStart,
    start: &TimeInput,
    end: &TimeInput,
    zone: &str,
    own_rule: bool,
) -> Result<Moved, CalendarError> {
    let tz = recurrence::zone(Some(zone));
    let local_in = |tz: chrono_tz::Tz, ms: i64| -> Result<NaiveDateTime, CalendarError> {
        tz.timestamp_millis_opt(ms)
            .single()
            .map(|t| t.naive_local())
            .ok_or_else(|| invalid(UNREADABLE_TIMES))
    };
    let local = |ms: i64| local_in(tz, ms);
    let instant = |zone: chrono_tz::Tz, t: NaiveDateTime| {
        zone.from_local_datetime(&t)
            .earliest()
            .map(|t| t.timestamp_millis())
            .ok_or_else(|| invalid(NO_SUCH_TIME))
    };
    let timed = |ms: i64, like: &TimeInput| TimeInput {
        ms: Some(ms),
        date: None,
        time_zone: like.time_zone.clone(),
    };
    match (
        at,
        start.ms,
        end.ms,
        start.date.as_deref(),
        end.date.as_deref(),
    ) {
        (OriginalStart::Ms(at), Some(s), Some(e), None, None) => {
            // The edit's wall clock is read in its own zone, which the series moves to.
            let new_tz = start
                .time_zone
                .as_deref()
                .and_then(|z| z.parse().ok())
                .unwrap_or(tz);
            let rezoned = (new_tz != tz).then_some(new_tz);
            let from = master.start_ms.ok_or_else(|| invalid(UNREADABLE_TIMES))?;
            let first = instant(new_tz, local(from)? + (local_in(new_tz, s)? - local(*at)?))?;
            Ok(Moved {
                start: timed(first, start),
                end: timed(first + (e - s), end),
                shift: (first != from || rezoned.is_some()).then_some(OriginalStart::Ms(first)),
                zone: rezoned,
            })
        }
        (OriginalStart::Date(at), None, None, Some(s), Some(e)) => {
            let (s, e) = (parse_date(s)?, parse_date(e)?);
            let from = parse_date(master.start_date.as_deref().unwrap_or_default())?;
            let first = from + (s - *at);
            Ok(Moved {
                start: date_input(first),
                end: date_input(first + (e - s)),
                shift: (first != from).then_some(OriginalStart::Date(first)),
                zone: None,
            })
        }
        (OriginalStart::Ms(at), None, None, Some(s), Some(e)) => {
            check_kind_switch(master, own_rule)?;
            let (s, e) = (parse_date(s)?, parse_date(e)?);
            if s != local(*at)?.date() {
                return Err(invalid(KIND_SWITCH));
            }
            let from = master.start_ms.ok_or_else(|| invalid(UNREADABLE_TIMES))?;
            let first = local(from)?.date();
            Ok(Moved {
                start: date_input(first),
                end: date_input(first + (e - s)),
                shift: None,
                zone: None,
            })
        }
        (OriginalStart::Date(at), Some(s), Some(e), None, None) => {
            check_kind_switch(master, own_rule)?;
            let edit_tz = recurrence::zone(Some(start.time_zone.as_deref().unwrap_or(zone)));
            let at_time = edit_tz
                .timestamp_millis_opt(s)
                .single()
                .map(|t| t.naive_local())
                .ok_or_else(|| invalid(UNREADABLE_TIMES))?;
            if at_time.date() != *at {
                return Err(invalid(KIND_SWITCH));
            }
            let from = parse_date(master.start_date.as_deref().unwrap_or_default())?;
            let first = instant(edit_tz, from.and_time(at_time.time()))?;
            Ok(Moved {
                start: timed(first, start),
                end: timed(first + (e - s), end),
                shift: None,
                zone: None,
            })
        }
        _ => Err(invalid(UNREADABLE_TIMES)),
    }
}

impl CalendarService {
    /// Works out whether `target` is part of a series, and which occurrence. A series' own
    /// id stands for its first occurrence.
    pub(super) async fn resolve(
        &self,
        account_id: &str,
        calendar_id: &str,
        target: Target,
        scope: EditScope,
    ) -> Result<Resolved, CalendarError> {
        match target {
            Target::Occurrence { master, at } => Ok(Resolved::Series(Box::new(InSeries {
                master: Some(*master),
                at,
                row: None,
            }))),
            Target::Stored(e) if e.recurrence.is_some() => {
                let at = first_start(&e)?;
                // "This event" on a series' own id is its first occurrence, which may have a
                // row of its own.
                let row = if scope == EditScope::This {
                    let id = edit::instance_id(&e.id, &at);
                    match self.target(account_id, calendar_id, &id).await? {
                        Target::Stored(r) => Some(*r),
                        Target::Occurrence { .. } => None,
                    }
                } else {
                    None
                };
                Ok(Resolved::Series(Box::new(InSeries {
                    master: Some(*e),
                    at,
                    row,
                })))
            }
            Target::Stored(e) => {
                let Some(master_id) = e.recurring_event_id.clone() else {
                    return Ok(Resolved::Single(e));
                };
                let at = original_start(&e).ok_or(CalendarError::NotFound)?;
                let master = db::calendar::event(&self.db, account_id, calendar_id, &master_id)
                    .await?
                    .filter(|m| m.recurrence.is_some() && m.status != "cancelled");
                Ok(Resolved::Series(Box::new(InSeries {
                    master,
                    at,
                    row: Some(*e),
                })))
            }
        }
    }

    /// Changes one occurrence, it and the later ones, or the whole series.
    pub(super) async fn update_in_series(
        &self,
        calendar: &DbCalendar,
        s: Box<InSeries>,
        scope: EditScope,
        edit: EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        // An occurrence that names no organizer follows its series' rules.
        let own_flags = s
            .row
            .as_ref()
            .map(raw)
            .filter(|r| scope == EditScope::This && r.get("organizer").is_some());
        let flags = own_flags
            .or_else(|| s.master.as_ref().map(raw))
            .or_else(|| s.row.as_ref().map(raw))
            .unwrap_or_default();
        if !can_edit(calendar, &flags) {
            return Err(CalendarError::ReadOnly(ORGANIZER_ONLY.into()));
        }
        edit::validate(&edit, false)?;
        if scope == EditScope::This {
            return self.update_this(calendar, &s, &edit, send).await;
        }
        let master = s.master.as_ref().ok_or_else(|| invalid(NO_SERIES))?;
        if scope == EditScope::Following && !is_first(master, &s.at) {
            if let Some(split) = series::split(master, &s.at)? {
                return self
                    .update_following(calendar, master, &s.at, split, &edit, send)
                    .await;
            }
        }
        self.update_all(calendar, master, &s.at, &edit, send).await
    }

    /// "This event": a patch of the occurrence alone, guarded by its etag when it has a row.
    async fn update_this(
        &self,
        calendar: &DbCalendar,
        s: &InSeries,
        edit: &EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        if edit.recurrence.is_some() {
            return Err(invalid(THIS_KEEPS_REPEAT));
        }
        let (account_id, calendar_id) = (calendar.account_id.as_str(), calendar.id.as_str());
        let existing = s.row.as_ref().or(s.master.as_ref()).map(raw);
        let body = edit::body(edit, existing.as_ref(), s.zone(calendar));
        let opts = WriteOptions {
            send_updates: send,
            if_match: s.row.as_ref().map(|r| r.etag.as_str()),
            conference: edit::touches_conference(edit, existing.as_ref()),
        };
        let api = (self.api_for)(account_id);
        let result = api.patch_event(calendar_id, &s.id(), body, opts).await;
        let row_id = s.row.as_ref().map(|r| r.id.as_str());
        let saved = self.settle(account_id, calendar_id, row_id, result).await?;
        self.save(account_id, calendar_id, saved).await
    }

    /// "All events": a patch of the series. A new time or day for the occurrence `at` moves
    /// every occurrence by the same change, rule included.
    async fn update_all(
        &self,
        calendar: &DbCalendar,
        master: &DbEvent,
        at: &OriginalStart,
        edit: &EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        let (account_id, calendar_id) = (calendar.account_id.as_str(), calendar.id.as_str());
        let zone = master
            .time_zone
            .as_deref()
            .unwrap_or_else(|| zone_of(calendar));
        let mut edit = edit.clone();
        if let (Some(start), Some(end)) = (&edit.start, &edit.end) {
            let own_rule = edit.recurrence.is_some();
            let moved = series_times(master, at, start, end, zone, own_rule)?;
            if let (false, Some(first)) = (own_rule, &moved.shift) {
                edit.recurrence = Some(series::shift(master, first, moved.zone)?);
            }
            edit.start = Some(moved.start);
            edit.end = Some(moved.end);
        }
        let existing = raw(master);
        let body = edit::body(&edit, Some(&existing), zone);
        let opts = WriteOptions {
            send_updates: send,
            if_match: Some(&master.etag),
            conference: edit::touches_conference(&edit, Some(&existing)),
        };
        let api = (self.api_for)(account_id);
        let result = api.patch_event(calendar_id, &master.id, body, opts).await;
        let saved = self
            .settle(account_id, calendar_id, Some(&master.id), result)
            .await?;
        self.save(account_id, calendar_id, saved).await
    }

    /// "This and following": a new series from `at` with the edit, then the old one cut
    /// short just before it. If the old one can't be cut, the new one is deleted again, so
    /// no occurrence shows twice.
    async fn update_following(
        &self,
        calendar: &DbCalendar,
        master: &DbEvent,
        at: &OriginalStart,
        split: Split,
        edit: &EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        let (account_id, calendar_id) = (calendar.account_id.as_str(), calendar.id.as_str());
        let zone = master
            .time_zone
            .as_deref()
            .unwrap_or_else(|| zone_of(calendar));
        let body = new_series_body(master, at, &split, edit, zone)?;
        let id = body["id"].as_str().unwrap_or_default().to_owned();
        let conference = body.get("conferenceData").is_some();
        let api = (self.api_for)(account_id);

        // 1. The new series. If it may have landed unseen, it's looked for, and removed when
        //    it can't be found, so the unchanged old series doesn't show twice.
        let opts = WriteOptions {
            send_updates: send,
            if_match: None,
            conference,
        };
        let result = match api.insert_event(calendar_id, body, opts).await {
            Err(e) if ambiguous(&e) => match api.get_event(calendar_id, &id).await {
                Ok(found) => Ok(found),
                Err(_) => {
                    self.trigger(Some(account_id.to_owned()));
                    let opts = WriteOptions {
                        send_updates: send,
                        if_match: None,
                        conference: false,
                    };
                    if api.delete_event(calendar_id, &id, opts).await.is_err() {
                        return Err(CalendarError::Incomplete(SPLIT_UNKNOWN.into()));
                    }
                    Err(e)
                }
            },
            other => other,
        };
        let inserted = self.settle(account_id, calendar_id, None, result).await?;

        // 2. The old series ends just before it.
        let opts = WriteOptions {
            send_updates: send,
            if_match: Some(&master.etag),
            conference: false,
        };
        let cut = json!({ "recurrence": split.old });
        let result = match api.patch_event(calendar_id, &master.id, cut, opts).await {
            // The cut may have landed: only an unchanged series is safe to undo the new one for.
            Err(err) if ambiguous(&err) => match api.get_event(calendar_id, &master.id).await {
                Ok(e) if e.recurrence == split.old => Ok(e),
                Ok(e) if e.etag == master.etag => Err(err),
                _ => {
                    self.trigger(Some(account_id.to_owned()));
                    return Err(CalendarError::Unconfirmed);
                }
            },
            other => other,
        };

        // 3. If it couldn't be cut, undo the new series.
        let truncated = match result {
            Ok(e) => e,
            Err(err) => {
                let opts = WriteOptions {
                    send_updates: send,
                    if_match: Some(&inserted.etag),
                    conference: false,
                };
                let undone = match api.delete_event(calendar_id, &inserted.id, opts).await {
                    Err(e) if ambiguous(&e) => {
                        is_gone(&api.get_event(calendar_id, &inserted.id).await)
                    }
                    r => r.is_ok(),
                };
                if !undone {
                    self.save(account_id, calendar_id, inserted).await?;
                    return Err(CalendarError::Incomplete(SPLIT_INCOMPLETE.into()));
                }
                return self
                    .settle(account_id, calendar_id, Some(&master.id), Err(err))
                    .await;
            }
        };

        // 4. Changed occurrences from `at` on went with the old tail (Google drops them too).
        db::calendar::delete_overrides_from(
            &self.db,
            account_id,
            calendar_id,
            &master.id,
            recurrence::at_ms(at),
        )
        .await?;
        let new_id = inserted.id.clone();
        self.save_all(account_id, calendar_id, vec![truncated, inserted])
            .await?;
        Ok(EventRef {
            account_id: account_id.to_owned(),
            calendar_id: calendar_id.to_owned(),
            id: new_id,
        })
    }

    /// Deletes one occurrence, it and the later ones, or the whole series.
    pub(super) async fn delete_in_series(
        &self,
        calendar: &DbCalendar,
        s: Box<InSeries>,
        scope: EditScope,
        send: SendUpdates,
    ) -> Result<(), CalendarError> {
        let (account_id, calendar_id) = (calendar.account_id.as_str(), calendar.id.as_str());
        if scope == EditScope::This {
            let id = s.id();
            let opts = WriteOptions {
                send_updates: send,
                if_match: s.row.as_ref().map(|r| r.etag.as_str()),
                conference: false,
            };
            let api = (self.api_for)(account_id);
            let result = api.delete_event(calendar_id, &id, opts).await;
            let row_id = s.row.as_ref().map(|r| r.id.as_str());
            self.settle(account_id, calendar_id, row_id, result).await?;
            let master_id = s
                .row
                .as_ref()
                .and_then(|r| r.recurring_event_id.clone())
                .or_else(|| s.master.as_ref().map(|m| m.id.clone()));
            let cancelled = json!({
                "id": id,
                "status": "cancelled",
                "recurringEventId": master_id,
                "originalStartTime": original_start_json(&s.at, s.zone(calendar)),
            });
            self.save(account_id, calendar_id, ApiEvent::try_from(cancelled)?)
                .await?;
            return Ok(());
        }
        let master = s.master.as_ref().ok_or_else(|| invalid(NO_SERIES))?;
        if scope == EditScope::Following && !is_first(master, &s.at) {
            if let Some(old) = series::truncate(master, &s.at)? {
                if !can_edit(calendar, &raw(master)) {
                    return Err(CalendarError::ReadOnly(ORGANIZER_ONLY.into()));
                }
                let opts = WriteOptions {
                    send_updates: send,
                    if_match: Some(&master.etag),
                    conference: false,
                };
                let api = (self.api_for)(account_id);
                let cut = json!({ "recurrence": old });
                let result = api.patch_event(calendar_id, &master.id, cut, opts).await;
                let saved = self
                    .settle(account_id, calendar_id, Some(&master.id), result)
                    .await?;
                db::calendar::delete_overrides_from(
                    &self.db,
                    account_id,
                    calendar_id,
                    &master.id,
                    recurrence::at_ms(&s.at),
                )
                .await?;
                self.save(account_id, calendar_id, saved).await?;
                return Ok(());
            }
        }
        self.delete_stored(account_id, calendar_id, master, send)
            .await
    }
}

/// The insert body of the series that takes over at `at`: the old series' fields without
/// Google's ids (its Meet kept, minus the request that made it), starting at the
/// occurrence's original times, the edit on top. A new time or day moves its rule too.
fn new_series_body(
    master: &DbEvent,
    at: &OriginalStart,
    split: &Split,
    edit: &EventEdit,
    zone: &str,
) -> Result<Value, CalendarError> {
    // The new series as it would be with no edit: the old one from `at`, with the new lines.
    let (occ, _) = unstored_occurrence(master, "", at);
    let midnight = |d: &Option<String>| {
        d.as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .map(|d| {
                d.and_time(chrono::NaiveTime::MIN)
                    .and_utc()
                    .timestamp_millis()
            })
    };
    let mut tail = master.clone();
    tail.start_ms = occ.start_ms.or_else(|| midnight(&occ.start_date));
    tail.end_ms = occ.end_ms.or_else(|| midnight(&occ.end_date));
    tail.start_date = occ.start_date.clone();
    tail.end_date = occ.end_date.clone();
    tail.recurrence = Some(serde_json::to_string(&split.new).map_err(anyhow::Error::from)?);

    let time = |ms: Option<i64>, date: Option<String>| TimeInput {
        ms: date.is_none().then_some(ms).flatten(),
        date,
        time_zone: master.time_zone.clone(),
    };
    let mut edit = edit.clone();
    let mut lines = edit.recurrence.clone().unwrap_or_else(|| split.new.clone());
    match (&edit.start, &edit.end) {
        (Some(start), Some(end)) => {
            let own_rule = edit.recurrence.is_some();
            let moved = series_times(&tail, at, start, end, zone, own_rule)?;
            if let (false, Some(first)) = (own_rule, &moved.shift) {
                lines = series::shift(&tail, first, moved.zone)?;
            }
            edit.start = Some(moved.start);
            edit.end = Some(moved.end);
        }
        _ => {
            edit.start = Some(time(occ.start_ms, occ.start_date));
            edit.end = Some(time(occ.end_ms, occ.end_date));
        }
    }
    edit.recurrence = None;

    let existing = raw(master);
    let mut body = existing.clone();
    let fields = body.as_object_mut().ok_or(CalendarError::NotFound)?;
    for key in NOT_COPIED.iter().filter(|k| **k != "conferenceData") {
        fields.remove(*key);
    }
    fields.remove("recurrence");
    if let Some(Value::Object(conference)) = fields.get_mut("conferenceData") {
        conference.remove("createRequest");
    }
    if let Value::Object(changes) = edit::body(&edit, Some(&existing), zone) {
        fields.extend(changes);
    }
    if !lines.is_empty() {
        fields.insert("recurrence".into(), json!(lines));
    }
    fields.insert("id".into(), Value::String(new_id()));
    fields.retain(|_, v| !v.is_null());
    Ok(body)
}

#[cfg(test)]
mod tests {
    use crate::calendar::edit::{EventEdit, TimeInput};
    use crate::calendar::error::CalendarError;
    use crate::calendar::fake::timed;
    use crate::calendar::service::tests::{harness, ms, Harness};
    use crate::calendar::service::CalendarEventDto;
    use crate::calendar::writes::EditScope;
    use crate::db;
    use crate::db::calendar::DbEvent;
    use crate::gmail::calendar::SendUpdates;
    use crate::gmail::GmailError;
    use chrono::{NaiveDate, TimeZone};
    use chrono_tz::America::New_York;
    use serde_json::{json, Value};

    const CAL: &str = "a@example.com";
    const RULE: &str = "RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TU";
    /// The moved occurrence in week 6 (originally Tuesday 24 November, 10:00 New York).
    const WEEK_6: &str = "weekly_20261124T150000Z";

    /// Ten Tuesdays at 10:00 New York from 20 October 2026 (across the end of DST).
    fn weekly() -> Value {
        let mut e = timed(
            "weekly",
            "Weekly",
            "2026-10-20T10:00:00-04:00",
            "2026-10-20T11:00:00-04:00",
        );
        e["recurrence"] = json!([RULE]);
        e["organizer"] = json!({"email": CAL, "self": true});
        e
    }

    /// Week 6, moved to 14:00.
    fn moved_week_6() -> Value {
        let mut e = timed(
            WEEK_6,
            "Weekly",
            "2026-11-24T14:00:00-05:00",
            "2026-11-24T15:00:00-05:00",
        );
        e["recurringEventId"] = json!("weekly");
        e["originalStartTime"] =
            json!({"dateTime": "2026-11-24T10:00:00-05:00", "timeZone": "America/New_York"});
        e
    }

    async fn seeded_with(master: Value) -> Harness {
        let h = harness(&["a"]).await;
        h.fake("a").put(CAL, master);
        h.fake("a").put(CAL, moved_week_6());
        h.grant("a").await;
        h.events.take();
        h
    }

    async fn seeded() -> Harness {
        seeded_with(weekly()).await
    }

    /// Week `n`'s occurrence start (10:00 New York).
    fn start_of(n: u64) -> i64 {
        let day = NaiveDate::from_ymd_opt(2026, 10, 20).unwrap() + chrono::Days::new(7 * (n - 1));
        New_York
            .from_local_datetime(&day.and_hms_opt(10, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp_millis()
    }

    /// Week `n`'s instance id.
    fn occ(n: u64) -> String {
        let utc = chrono::Utc.timestamp_millis_opt(start_of(n)).unwrap();
        format!("weekly_{}", utc.format("%Y%m%dT%H%M%SZ"))
    }

    fn at(ms: i64) -> TimeInput {
        TimeInput {
            ms: Some(ms),
            date: None,
            time_zone: None,
        }
    }

    fn day(d: &str) -> TimeInput {
        TimeInput {
            ms: None,
            date: Some(d.into()),
            time_zone: None,
        }
    }

    fn times(start: TimeInput, end: TimeInput) -> EventEdit {
        EventEdit {
            start: Some(start),
            end: Some(end),
            ..Default::default()
        }
    }

    fn summary(s: &str) -> EventEdit {
        EventEdit {
            summary: Some(s.into()),
            ..Default::default()
        }
    }

    async fn update(
        h: &Harness,
        id: &str,
        scope: EditScope,
        edit: EventEdit,
    ) -> Result<crate::calendar::writes::EventRef, CalendarError> {
        h.service
            .update_event("a", CAL, id, scope, edit, SendUpdates::None)
            .await
    }

    async fn delete(h: &Harness, id: &str, scope: EditScope) -> Result<(), CalendarError> {
        h.service
            .delete_event("a", CAL, id, scope, SendUpdates::None)
            .await
    }

    async fn cached(h: &Harness, id: &str) -> Option<DbEvent> {
        db::calendar::event(&h.service.db, "a", CAL, id)
            .await
            .unwrap()
    }

    /// Everything shown from 19 October to the end of the year.
    async fn shown(h: &Harness) -> Vec<CalendarEventDto> {
        h.service
            .events(
                ms("2026-10-19T00:00:00Z"),
                ms("2027-01-01T00:00:00Z"),
                "America/New_York",
            )
            .await
            .unwrap()
    }

    /// "Tue 03 Nov 10:00 Weekly", in New York; all-day events by their date.
    fn line(e: &CalendarEventDto) -> String {
        let when = match (e.start.ms, &e.start.date) {
            (Some(ms), _) => New_York
                .timestamp_millis_opt(ms)
                .unwrap()
                .format("%a %d %b %H:%M")
                .to_string(),
            (None, Some(d)) => NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .unwrap()
                .format("%a %d %b all-day")
                .to_string(),
            _ => "?".into(),
        };
        format!("{when} {}", e.summary.as_deref().unwrap_or_default())
    }

    async fn lines(h: &Harness) -> Vec<String> {
        shown(h).await.iter().map(line).collect()
    }

    fn rows_sql() -> &'static str {
        "SELECT id, etag, raw FROM events ORDER BY id"
    }

    async fn rows(h: &Harness) -> Vec<(String, String, String)> {
        sqlx::query_as(rows_sql())
            .fetch_all(&h.service.db)
            .await
            .unwrap()
    }

    fn api_500() -> GmailError {
        GmailError::Api {
            status: 500,
            reason: Some("backendError".into()),
            message: "Backend Error".into(),
        }
    }

    #[tokio::test]
    async fn this_edit_patches_instance_only() {
        let h = seeded().await;
        let r = update(&h, &occ(3), EditScope::This, summary("Moved"))
            .await
            .unwrap();
        assert_eq!(r.id, occ(3));
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].method, "patch");
        assert_eq!(writes[0].event_id.as_deref(), Some(occ(3).as_str()));
        assert_eq!(
            writes[0].if_match, None,
            "an unstored occurrence has no etag"
        );
        assert_eq!(writes[0].body, json!({"summary": "Moved"}));
        assert_eq!(
            h.fake("a").event(CAL, "weekly").unwrap()["summary"],
            "Weekly"
        );

        let shown = lines(&h).await;
        assert_eq!(shown.len(), 10);
        assert_eq!(shown[2], "Tue 03 Nov 10:00 Moved");
        assert_eq!(shown.iter().filter(|l| l.ends_with("Moved")).count(), 1);
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn this_edit_of_a_changed_occurrence_sends_its_etag() {
        let h = seeded().await;
        update(&h, WEEK_6, EditScope::This, summary("Late"))
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.event_id.as_deref(), Some(WEEK_6));
        assert_eq!(
            w.if_match.as_deref(),
            Some(format!("\"{WEEK_6}\"").as_str())
        );
        assert!(lines(&h)
            .await
            .contains(&"Tue 24 Nov 14:00 Late".to_owned()));
    }

    #[tokio::test]
    async fn this_scope_refuses_a_repeat_change() {
        let h = seeded().await;
        let edit = EventEdit {
            recurrence: Some(vec!["RRULE:FREQ=DAILY".into()]),
            ..Default::default()
        };
        let err = update(&h, &occ(3), EditScope::This, edit)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(
            err.to_string(),
            "Repeat can only change for the whole series."
        );
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn this_delete_hides_one_occurrence() {
        let h = seeded().await;
        delete(&h, &occ(3), EditScope::This).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "delete");
        assert_eq!(w.event_id.as_deref(), Some(occ(3).as_str()));
        assert_eq!(w.if_match, None);
        let row = cached(&h, &occ(3)).await.unwrap();
        assert_eq!(row.status, "cancelled");
        assert_eq!(row.recurring_event_id.as_deref(), Some("weekly"));
        assert_eq!(row.original_start_ms, Some(start_of(3)));

        let shown = lines(&h).await;
        assert_eq!(shown.len(), 9);
        assert!(!shown.iter().any(|l| l.contains("03 Nov")));
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn this_delete_of_a_changed_occurrence_sends_its_etag() {
        let h = seeded().await;
        delete(&h, WEEK_6, EditScope::This).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(
            w.if_match.as_deref(),
            Some(format!("\"{WEEK_6}\"").as_str())
        );
        let shown = lines(&h).await;
        assert_eq!(shown.len(), 9);
        assert!(!shown.iter().any(|l| l.contains("24 Nov")));
    }

    #[tokio::test]
    async fn all_edit_new_time_shifts_master() {
        let h = seeded().await;
        // Week 3 dragged from 10:00 to 11:00, and made 90 minutes long.
        let edit = times(
            at(ms("2026-11-03T16:00:00Z")),
            at(ms("2026-11-03T17:30:00Z")),
        );
        let r = update(&h, &occ(3), EditScope::All, edit).await.unwrap();
        assert_eq!(r.id, "weekly");
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "patch");
        assert_eq!(w.event_id.as_deref(), Some("weekly"));
        assert_eq!(w.if_match.as_deref(), Some("\"weekly\""));
        assert_eq!(w.body["start"]["dateTime"], "2026-10-20T11:00:00-04:00");
        assert_eq!(w.body["end"]["dateTime"], "2026-10-20T12:30:00-04:00");
        assert_eq!(w.body["recurrence"], json!([RULE]));

        let series: Vec<CalendarEventDto> = shown(&h)
            .await
            .into_iter()
            .filter(|e| e.id != WEEK_6)
            .collect();
        assert_eq!(series.len(), 10);
        for e in &series {
            let l = line(e);
            assert!(l.starts_with("Tue") && l.contains(" 11:00 "), "{l}");
            assert_eq!(e.end.ms.unwrap() - e.start.ms.unwrap(), 90 * 60_000);
        }
    }

    #[tokio::test]
    async fn all_edit_new_day_shifts_byday() {
        let h = seeded().await;
        let edit = times(
            at(ms("2026-11-04T15:00:00Z")),
            at(ms("2026-11-04T16:00:00Z")),
        );
        update(&h, &occ(3), EditScope::All, edit).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.body["start"]["dateTime"], "2026-10-21T10:00:00-04:00");
        assert_eq!(
            w.body["recurrence"],
            json!(["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=WE"])
        );
        let google = h.fake("a").event(CAL, "weekly").unwrap();
        assert_eq!(google["recurrence"], w.body["recurrence"]);

        let series: Vec<String> = shown(&h)
            .await
            .iter()
            .filter(|e| e.id != WEEK_6)
            .map(line)
            .collect();
        assert_eq!(series.len(), 10);
        assert!(
            series
                .iter()
                .all(|l| l.starts_with("Wed") && l.contains(" 10:00 ")),
            "{series:?}"
        );
    }

    #[tokio::test]
    async fn all_edit_switches_kind_when_the_rule_has_no_dates() {
        let h = seeded().await;
        // Week 3 made all-day: the series becomes all-day from its first date.
        update(
            &h,
            &occ(3),
            EditScope::All,
            times(day("2026-11-03"), day("2026-11-04")),
        )
        .await
        .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.event_id.as_deref(), Some("weekly"));
        assert_eq!(w.body["start"]["date"], "2026-10-20");
        assert_eq!(w.body["end"]["date"], "2026-10-21");
        assert!(w.body.get("recurrence").is_none(), "the rule is kept as is");
        let master = cached(&h, "weekly").await.unwrap();
        assert!(master.is_all_day());
        let all_day: Vec<String> = shown(&h)
            .await
            .iter()
            .filter(|e| e.all_day)
            .map(line)
            .collect();
        assert_eq!(all_day.len(), 10);
        assert!(all_day.iter().all(|l| l.starts_with("Tue")), "{all_day:?}");

        // And back: week 3 at 09:00 puts the series' first date at 09:00.
        update(
            &h,
            "weekly_20261103",
            EditScope::All,
            times(
                at(ms("2026-11-03T14:00:00Z")),
                at(ms("2026-11-03T15:00:00Z")),
            ),
        )
        .await
        .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.body["start"]["dateTime"], "2026-10-20T09:00:00-04:00");
        assert_eq!(w.body["end"]["dateTime"], "2026-10-20T10:00:00-04:00");
        assert!(w.body.get("recurrence").is_none());
        assert!(!cached(&h, "weekly").await.unwrap().is_all_day());
    }

    #[tokio::test]
    async fn all_edit_refuses_kind_switch_when_the_rule_has_dates() {
        let mut master = weekly();
        master["recurrence"] = json!([RULE, "EXDATE;TZID=America/New_York:20261201T100000"]);
        let h = seeded_with(master).await;
        let to_all_day = || times(day("2026-11-03"), day("2026-11-04"));
        let err = update(&h, &occ(3), EditScope::All, to_all_day())
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(
            err.to_string(),
            "Change this series to all-day or timed from the editor's Repeat setting."
        );

        // Without dates in the rule, a switch that also moves the day is refused too.
        let h2 = seeded().await;
        let err = update(
            &h2,
            &occ(3),
            EditScope::All,
            times(day("2026-11-04"), day("2026-11-05")),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(h.fake("a").writes().is_empty());
        assert!(h2.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn following_edit_on_count_series() {
        let mut master = weekly();
        master["hangoutLink"] = json!("https://meet.google.com/abc");
        master["conferenceData"] = json!({
            "conferenceId": "abc",
            "conferenceSolution": {"key": {"type": "hangoutsMeet"}},
            "entryPoints": [{"entryPointType": "video", "uri": "https://meet.google.com/abc"}],
            "createRequest": {"requestId": "r1", "status": {"statusCode": "success"}}
        });
        let h = seeded_with(master).await;
        let r = update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap();
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 2, "{writes:?}");

        let insert = &writes[0];
        assert_eq!(insert.method, "insert");
        assert_eq!(insert.send_updates, Some(SendUpdates::None));
        assert_eq!(insert.body["id"], r.id.as_str());
        assert_eq!(r.id.len(), 32);
        assert_eq!(insert.body["summary"], "Renamed");
        assert_eq!(
            insert.body["recurrence"],
            json!(["RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=TU"])
        );
        assert_eq!(
            insert.body["start"]["dateTime"],
            "2026-11-10T10:00:00-05:00"
        );
        assert_eq!(insert.body["end"]["dateTime"], "2026-11-10T11:00:00-05:00");
        for key in [
            "iCalUID",
            "etag",
            "organizer",
            "hangoutLink",
            "recurringEventId",
        ] {
            assert!(insert.body.get(key).is_none(), "{key} should be stripped");
        }
        assert_eq!(insert.body["conferenceData"]["conferenceId"], "abc");
        assert!(insert.body["conferenceData"].get("createRequest").is_none());
        assert!(insert.conference);

        let truncate = &writes[1];
        assert_eq!(truncate.method, "patch");
        assert_eq!(truncate.event_id.as_deref(), Some("weekly"));
        assert_eq!(truncate.if_match.as_deref(), Some("\"weekly\""));
        let old = json!({"recurrence": ["RRULE:FREQ=WEEKLY;UNTIL=20261110T145959Z;BYDAY=TU"]});
        assert_eq!(truncate.body, old);
        assert_eq!(
            h.fake("a").event(CAL, "weekly").unwrap()["recurrence"],
            old["recurrence"]
        );

        assert!(
            cached(&h, WEEK_6).await.is_none(),
            "dropped with the old tail"
        );
        let shown = lines(&h).await;
        assert_eq!(shown.len(), 10, "{shown:?}");
        assert!(shown[..3].iter().all(|l| l.ends_with(" 10:00 Weekly")));
        assert!(shown[3..].iter().all(|l| l.ends_with(" 10:00 Renamed")));
        assert_eq!(shown[3], "Tue 10 Nov 10:00 Renamed");
        assert_eq!(shown[9], "Tue 22 Dec 10:00 Renamed");
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    /// `ms` as "Tue 03 Nov 10:00" in Tokyo.
    fn tokyo(ms: i64) -> String {
        chrono_tz::Asia::Tokyo
            .timestamp_millis_opt(ms)
            .unwrap()
            .format("%a %d %b %H:%M")
            .to_string()
    }

    fn in_tokyo(ms: i64) -> TimeInput {
        TimeInput {
            time_zone: Some("Asia/Tokyo".into()),
            ..at(ms)
        }
    }

    /// Tuesday 10:00 in Tokyo is Monday evening in New York: the days follow the new zone.
    #[tokio::test]
    async fn all_edit_new_zone_keeps_days_in_the_new_zone() {
        let mut master = weekly();
        master["recurrence"] = json!([RULE, "EXDATE;TZID=America/New_York:20261201T100000"]);
        let h = seeded_with(master).await;
        let edit = times(
            in_tokyo(ms("2026-11-03T01:00:00Z")),
            in_tokyo(ms("2026-11-03T02:00:00Z")),
        );
        update(&h, &occ(3), EditScope::All, edit).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.body["start"]["dateTime"], "2026-10-20T10:00:00+09:00");
        assert_eq!(w.body["start"]["timeZone"], "Asia/Tokyo");
        assert_eq!(
            w.body["recurrence"],
            json!([RULE, "EXDATE;TZID=America/New_York:20261130T200000"])
        );

        let series: Vec<String> = shown(&h)
            .await
            .iter()
            .filter(|e| e.id != WEEK_6)
            .map(|e| tokyo(e.start.ms.unwrap()))
            .collect();
        assert_eq!(series.len(), 9, "{series:?}");
        assert!(
            series
                .iter()
                .all(|l| l.starts_with("Tue") && l.ends_with(" 10:00")),
            "{series:?}"
        );
        assert!(!series.iter().any(|l| l.contains("01 Dec")), "{series:?}");
    }

    #[tokio::test]
    async fn following_edit_new_zone_keeps_days_in_the_new_zone() {
        let mut master = weekly();
        master["recurrence"] = json!([RULE, "EXDATE;TZID=America/New_York:20261201T100000"]);
        let h = seeded_with(master).await;
        let edit = times(
            in_tokyo(ms("2026-11-10T01:00:00Z")),
            in_tokyo(ms("2026-11-10T02:00:00Z")),
        );
        update(&h, &occ(4), EditScope::Following, edit)
            .await
            .unwrap();
        let insert = &h.fake("a").writes()[0];
        assert_eq!(
            insert.body["start"]["dateTime"],
            "2026-11-10T10:00:00+09:00"
        );
        assert_eq!(
            insert.body["recurrence"],
            json!([
                "RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=TU",
                "EXDATE;TZID=America/New_York:20261130T200000"
            ])
        );
        let shown = shown(&h).await;
        assert_eq!(
            shown.len(),
            9,
            "{:?}",
            shown.iter().map(line).collect::<Vec<_>>()
        );
        assert!(shown[..3]
            .iter()
            .all(|e| line(e).contains("Tue") && line(e).contains(" 10:00 ")));
        let later: Vec<String> = shown[3..]
            .iter()
            .map(|e| tokyo(e.start.ms.unwrap()))
            .collect();
        assert!(
            later
                .iter()
                .all(|l| l.starts_with("Tue") && l.ends_with(" 10:00")),
            "{later:?}"
        );
        assert!(!later.iter().any(|l| l.contains("01 Dec")), "{later:?}");
    }

    #[tokio::test]
    async fn following_edit_moving_the_time_moves_the_new_series_exceptions() {
        let mut master = weekly();
        master["recurrence"] = json!([RULE, "EXDATE;TZID=America/New_York:20261201T100000"]);
        let h = seeded_with(master).await;
        let edit = times(
            at(ms("2026-11-10T16:00:00Z")),
            at(ms("2026-11-10T17:00:00Z")),
        );
        update(&h, &occ(4), EditScope::Following, edit)
            .await
            .unwrap();
        let insert = &h.fake("a").writes()[0];
        assert_eq!(
            insert.body["start"]["dateTime"],
            "2026-11-10T11:00:00-05:00"
        );
        assert_eq!(
            insert.body["recurrence"],
            json!([
                "RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=TU",
                "EXDATE;TZID=America/New_York:20261201T110000"
            ])
        );
        let shown = lines(&h).await;
        assert_eq!(shown.len(), 9, "{shown:?}");
        assert!(shown[..3].iter().all(|l| l.contains(" 10:00 ")));
        assert!(shown[3..].iter().all(|l| l.contains(" 11:00 ")));
        assert!(!shown.iter().any(|l| l.contains("01 Dec")));
    }

    #[tokio::test]
    async fn following_split_rolls_back_new_series_when_truncate_fails() {
        let h = seeded().await;
        let before = rows(&h).await;
        h.fake("a").fail_write(1, api_500);
        let err = update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "api");
        let writes = h.fake("a").writes();
        let methods: Vec<&str> = writes.iter().map(|w| w.method).collect();
        assert_eq!(methods, vec!["insert", "patch", "delete"]);
        let new_id = writes[0].body["id"].as_str().unwrap();
        assert_eq!(writes[2].event_id.as_deref(), Some(new_id));
        assert_eq!(
            h.fake("a").event(CAL, new_id).unwrap()["status"],
            "cancelled"
        );
        assert_eq!(
            h.fake("a").event(CAL, "weekly").unwrap()["recurrence"],
            json!([RULE])
        );
        assert_eq!(rows(&h).await, before, "the cache is unchanged");
        assert!(h.events.names().is_empty());
    }

    #[tokio::test]
    async fn following_split_reports_incomplete_when_rollback_fails() {
        let h = seeded().await;
        h.fake("a").fail_write(1, api_500);
        h.fake("a").fail_write(2, api_500);
        let err = update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "incomplete");
        assert_eq!(
            err.to_string(),
            "The change was saved as a new series, but the old one couldn't be shortened, so \
             some occurrences show twice. Delete the extra ones."
        );
        let new_id = h.fake("a").writes()[0].body["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            h.fake("a").event(CAL, &new_id).unwrap()["status"],
            "confirmed"
        );
        assert!(
            cached(&h, &new_id).await.is_some(),
            "what Google has is shown"
        );
    }

    #[tokio::test]
    async fn following_split_keeps_both_halves_when_the_truncate_reply_is_lost() {
        let h = seeded().await;
        h.fake("a").lose_reply(1);
        update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap();
        let methods: Vec<&str> = h.fake("a").writes().iter().map(|w| w.method).collect();
        assert_eq!(methods, vec!["insert", "patch"], "nothing rolled back");
        let shown = lines(&h).await;
        assert_eq!(shown.len(), 10, "{shown:?}");
        assert!(shown[3..].iter().all(|l| l.ends_with("Renamed")));
    }

    fn offline() -> GmailError {
        GmailError::Offline("down".into())
    }

    #[tokio::test]
    async fn following_split_keeps_the_new_series_when_the_cut_fails_ambiguously() {
        let h = seeded().await;
        // The cut lands but answers 503, and Google can't be asked what it has.
        h.fake("a").fail_after_apply(1, || GmailError::Api {
            status: 503,
            reason: Some("backendError".into()),
            message: "Service Unavailable".into(),
        });
        h.fake("a").fail_reads(Some(offline));
        let err = update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Unconfirmed), "{err:?}");
        let writes = h.fake("a").writes();
        let methods: Vec<&str> = writes.iter().map(|w| w.method).collect();
        assert_eq!(
            methods,
            vec!["insert", "patch"],
            "the new series isn't undone"
        );
        let new_id = writes[0].body["id"].as_str().unwrap();
        assert_eq!(
            h.fake("a").event(CAL, new_id).unwrap()["status"],
            "confirmed"
        );
        assert!(h.service.is_forced("a"));

        h.fake("a").fail_reads(None);
        h.service.tick(crate::sync::engine::now_ms()).await;
        let series: Vec<String> = shown(&h)
            .await
            .iter()
            .filter(|e| e.id != WEEK_6)
            .map(line)
            .collect();
        assert_eq!(series.len(), 10, "{series:?}");
        assert!(series[..3].iter().all(|l| l.ends_with("Weekly")));
        assert!(series[3..].iter().all(|l| l.ends_with("Renamed")));
    }

    #[tokio::test]
    async fn following_split_removes_a_new_series_it_cannot_confirm() {
        let h = seeded().await;
        let before = rows(&h).await;
        // The insert lands but its reply is lost, and Google can't be asked about it.
        h.fake("a").lose_reply(0);
        h.fake("a").fail_reads(Some(offline));
        let err = update(&h, &occ(4), EditScope::Following, summary("Renamed"))
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Unconfirmed), "{err:?}");
        let writes = h.fake("a").writes();
        let methods: Vec<&str> = writes.iter().map(|w| w.method).collect();
        assert_eq!(methods, vec!["insert", "delete"]);
        let new_id = writes[0].body["id"].as_str().unwrap();
        assert_eq!(writes[1].event_id.as_deref(), Some(new_id));
        assert_eq!(writes[1].if_match, None);
        assert_eq!(
            h.fake("a").event(CAL, new_id).unwrap()["status"],
            "cancelled"
        );
        assert_eq!(
            h.fake("a").event(CAL, "weekly").unwrap()["recurrence"],
            json!([RULE])
        );
        assert_eq!(rows(&h).await, before);
        assert!(h.service.is_forced("a"));
    }

    #[tokio::test]
    async fn following_delete_truncates_and_drops_later_overrides() {
        let h = seeded().await;
        delete(&h, &occ(4), EditScope::Following).await.unwrap();
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].method, "patch");
        assert_eq!(writes[0].event_id.as_deref(), Some("weekly"));
        assert_eq!(writes[0].if_match.as_deref(), Some("\"weekly\""));
        assert_eq!(
            writes[0].body,
            json!({"recurrence": ["RRULE:FREQ=WEEKLY;UNTIL=20261110T145959Z;BYDAY=TU"]})
        );
        assert!(cached(&h, WEEK_6).await.is_none());
        let shown = lines(&h).await;
        assert_eq!(
            shown,
            vec![
                "Tue 20 Oct 10:00 Weekly",
                "Tue 27 Oct 10:00 Weekly",
                "Tue 03 Nov 10:00 Weekly",
            ]
        );
    }

    #[tokio::test]
    async fn following_at_first_occurrence_acts_on_all() {
        let h = seeded().await;
        update(&h, &occ(1), EditScope::Following, summary("Renamed"))
            .await
            .unwrap();
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1, "no new series");
        assert_eq!(writes[0].method, "patch");
        assert_eq!(writes[0].event_id.as_deref(), Some("weekly"));
        assert_eq!(writes[0].if_match.as_deref(), Some("\"weekly\""));
        assert_eq!(writes[0].body, json!({"summary": "Renamed"}));

        delete(&h, &occ(1), EditScope::Following).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "delete");
        assert_eq!(w.event_id.as_deref(), Some("weekly"));
        assert!(w.if_match.is_some());
        assert!(cached(&h, "weekly").await.is_none());
        assert!(cached(&h, WEEK_6).await.is_none());
        assert!(shown(&h).await.is_empty());
    }

    #[tokio::test]
    async fn all_delete_removes_the_series() {
        let h = seeded().await;
        delete(&h, &occ(3), EditScope::All).await.unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "delete");
        assert_eq!(w.event_id.as_deref(), Some("weekly"));
        assert_eq!(w.if_match.as_deref(), Some("\"weekly\""));
        assert!(shown(&h).await.is_empty());
    }

    #[tokio::test]
    async fn guest_cannot_change_the_series() {
        let mut master = weekly();
        master["organizer"] = json!({"email": "boss@example.com"});
        let h = seeded_with(master).await;
        for scope in [EditScope::This, EditScope::Following, EditScope::All] {
            let err = update(&h, &occ(4), scope, summary("Mine"))
                .await
                .unwrap_err();
            assert_eq!(err.code(), "read_only", "{scope:?}");
        }
        assert!(h.fake("a").writes().is_empty());
    }
}
