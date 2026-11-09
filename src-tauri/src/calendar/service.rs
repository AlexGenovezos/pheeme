//! The calendar service the commands call: every account's calendars and the events in a
//! range (series expanded), answered from the cache, plus the background loop that keeps the
//! cache current. Runs apart from mail sync, so a calendar problem never holds mail up.

use super::recurrence::{self, Occurrence};
use super::sync::{classify, sync_account, SyncError};
use super::{CalendarApi, CalendarFactory};
use crate::db;
use crate::db::calendar::{DbCalendarAccess, DbEvent};
use crate::gmail::GmailError;
use crate::mail::MailError;
use crate::sync::engine::now_ms;
use crate::sync::{SyncEvent, SyncEvents};
use chrono::{NaiveDate, TimeZone};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::warn;

/// The Google Calendar API page in the user's Google Cloud project.
pub const CALENDAR_API_URL: &str =
    "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

/// How often calendars are checked while the app runs.
const INTERVAL: Duration = Duration::from_secs(60);
/// How often while Calendar mode is in front.
const FOREGROUND_INTERVAL: Duration = Duration::from_secs(15);
/// How often the calendar list and settings are re-read.
const LIST_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// The first check waits for launch and mail's first sync to settle.
const FIRST_DELAY: Duration = Duration::from_secs(5);

/// Statuses that need the user (allow access, turn the API on); not polled until then.
const HELD: [&str; 2] = ["missing_scope", "api_disabled"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTimeDto {
    /// UTC ms, for timed events.
    pub ms: Option<i64>,
    /// `YYYY-MM-DD`, for all-day events (the end is exclusive).
    pub date: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    pub account_id: String,
    pub calendar_id: String,
    /// The event's id, or Google's instance id for an occurrence of a series.
    pub id: String,
    /// The series this is an occurrence of.
    pub master_id: Option<String>,
    pub summary: Option<String>,
    pub start: EventTimeDto,
    pub end: EventTimeDto,
    pub all_day: bool,
    pub status: String,
    pub self_response: Option<String>,
    pub location: Option<String>,
    pub has_conference: bool,
    pub color_id: Option<String>,
    pub transparency: Option<String>,
    pub recurring: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDto {
    pub id: String,
    pub summary: String,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    pub access_role: String,
    pub primary: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccessDto {
    /// `unknown` (never allowed), `on`, `missing_scope`, `api_disabled` or `error`.
    pub status: String,
    /// What failed, for `error`.
    pub message: Option<String>,
    /// The Calendar API page for the user's project, for `api_disabled`.
    pub enable_url: Option<String>,
    pub synced_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccountDto {
    pub account_id: String,
    pub email: String,
    pub access: CalendarAccessDto,
    /// The user's Google Calendar time zone.
    pub time_zone: Option<String>,
    /// 0 Sunday, 1 Monday, 6 Saturday.
    pub week_start: Option<u8>,
    pub calendars: Vec<CalendarDto>,
}

fn access_dto(access: Option<&DbCalendarAccess>) -> CalendarAccessDto {
    let Some(a) = access else {
        return CalendarAccessDto {
            status: "unknown".into(),
            message: None,
            enable_url: None,
            synced_at: None,
        };
    };
    CalendarAccessDto {
        status: a.status.clone(),
        message: (a.status == "error").then(|| a.detail.clone()).flatten(),
        enable_url: (a.status == "api_disabled").then(|| match &a.detail {
            Some(project) => format!("{CALENDAR_API_URL}?project={project}"),
            None => CALENDAR_API_URL.to_owned(),
        }),
        synced_at: a.synced_at,
    }
}

fn sync_error(e: SyncError) -> MailError {
    MailError::Sync(match e {
        SyncError::Api(e) => crate::sync::engine::SyncError::Gmail(e),
        SyncError::Db(e) => crate::sync::engine::SyncError::Db(e),
    })
}

/// A failure that may pass by itself, which doesn't change the account's status.
fn is_transient(e: &GmailError) -> bool {
    match e {
        GmailError::Network(_) | GmailError::Offline(_) | GmailError::RateLimit { .. } => true,
        GmailError::Api { status, .. } => *status >= 500,
        _ => false,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct CalendarService {
    db: SqlitePool,
    api_for: CalendarFactory,
    events: Arc<dyn SyncEvents>,
    foreground: AtomicBool,
    wake: Notify,
    /// Accounts to sync on the next tick whatever their status (just signed in, or asked).
    forced: Mutex<HashSet<String>>,
    /// One sync per account at a time.
    running: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl CalendarService {
    pub fn new(db: SqlitePool, api_for: CalendarFactory, events: Arc<dyn SyncEvents>) -> Arc<Self> {
        Arc::new(Self {
            db,
            api_for,
            events,
            foreground: AtomicBool::new(false),
            wake: Notify::new(),
            forced: Mutex::new(HashSet::new()),
            running: Mutex::new(HashMap::new()),
        })
    }

    /// Every account with its calendar access, settings and calendars.
    pub async fn accounts(&self) -> Result<Vec<CalendarAccountDto>, MailError> {
        let accounts = db::accounts::list_accounts(&self.db).await?;
        let calendars = db::calendar::calendars(&self.db, None).await?;
        let mut out = Vec::with_capacity(accounts.len());
        for account in accounts {
            let access = db::calendar::access(&self.db, &account.id).await?;
            out.push(CalendarAccountDto {
                access: access_dto(access.as_ref()),
                time_zone: access.as_ref().and_then(|a| a.time_zone.clone()),
                week_start: access
                    .as_ref()
                    .and_then(|a| a.week_start)
                    .and_then(|d| u8::try_from(d).ok()),
                calendars: calendars
                    .iter()
                    .filter(|c| c.account_id == account.id)
                    .map(|c| CalendarDto {
                        id: c.id.clone(),
                        summary: c.summary.clone(),
                        background_color: c.background_color.clone(),
                        foreground_color: c.foreground_color.clone(),
                        access_role: c.access_role.clone(),
                        primary: c.primary,
                        hidden: c.hidden,
                    })
                    .collect(),
                account_id: account.id,
                email: account.email,
            });
        }
        Ok(out)
    }

    /// Events of shown calendars overlapping `[from_ms, to_ms)`, series expanded, sorted by
    /// start. All-day events count by their dates as seen in `display_tz`.
    pub async fn events(
        &self,
        from_ms: i64,
        to_ms: i64,
        display_tz: &str,
    ) -> Result<Vec<CalendarEventDto>, MailError> {
        let tz: chrono_tz::Tz = display_tz.parse().unwrap_or(chrono_tz::UTC);
        let rows = db::calendar::events_overlapping(&self.db, from_ms, to_ms).await?;
        let key = |e: &DbEvent| (e.account_id.clone(), e.calendar_id.clone());
        let mut overrides: HashMap<(String, String, String), Vec<&DbEvent>> = HashMap::new();
        for e in rows.iter() {
            if let Some(master) = &e.recurring_event_id {
                let (a, c) = key(e);
                overrides.entry((a, c, master.clone())).or_default().push(e);
            }
        }
        let mut out = Vec::new();
        for e in &rows {
            if e.recurrence.is_some() {
                let (a, c) = key(e);
                let replaced = overrides
                    .get(&(a, c, e.id.clone()))
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                for occ in recurrence::expand(e, replaced, from_ms, to_ms, tz) {
                    out.push(dto(e, Some(&occ)));
                }
            } else if e.status != "cancelled" && overlaps(e, from_ms, to_ms, tz) {
                out.push(dto(e, None));
            }
        }
        let start_key = |e: &CalendarEventDto| {
            e.start.ms.unwrap_or_else(|| {
                e.start
                    .date
                    .as_deref()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                    .and_then(|d| {
                        tz.from_local_datetime(&d.and_time(chrono::NaiveTime::MIN))
                            .earliest()
                    })
                    .map_or(0, |d| d.timestamp_millis())
            })
        };
        out.sort_by_key(|e| (start_key(e), !e.all_day, e.id.clone()));
        Ok(out)
    }

    /// Show or hide a calendar's events (local only).
    pub async fn set_calendar_hidden(
        &self,
        account_id: &str,
        calendar_id: &str,
        hidden: bool,
    ) -> Result<(), MailError> {
        db::calendar::set_hidden(&self.db, account_id, calendar_id, hidden).await?;
        self.events.emit(SyncEvent::CalendarUpdated {
            account_id: account_id.to_owned(),
        });
        Ok(())
    }

    /// Sync the account now, whatever its status (after allowing access, or "Check again"),
    /// re-reading its calendar list; returns where its access stands.
    pub async fn sync_now(&self, account_id: &str) -> Result<CalendarAccessDto, MailError> {
        lock(&self.forced).remove(account_id);
        self.sync_one(account_id, now_ms(), true).await?;
        let access = db::calendar::access(&self.db, account_id).await?;
        Ok(access_dto(access.as_ref()))
    }

    /// Calendar mode is (or stopped being) in front: check every 15 s instead of 60 s.
    pub fn set_foreground(&self, on: bool) {
        let was = self.foreground.swap(on, Ordering::Relaxed);
        if on && !was {
            self.wake.notify_one();
        }
    }

    /// Check `account_id` (or every account) soon; an account named here is checked even if
    /// it never allowed calendar access, so signing in finds out whether it now has.
    pub fn trigger(&self, account_id: Option<String>) {
        if let Some(id) = account_id {
            lock(&self.forced).insert(id);
        }
        self.wake.notify_one();
    }

    /// One pass: every account that allowed calendar access and isn't waiting on the user,
    /// plus any triggered account.
    pub async fn tick(&self, now: i64) {
        let accounts = match db::accounts::list_accounts(&self.db).await {
            Ok(a) => a,
            Err(e) => {
                warn!(error = %e, "couldn't list accounts for calendar sync");
                return;
            }
        };
        let forced: HashSet<String> = std::mem::take(&mut *lock(&self.forced));
        for account in accounts {
            let access = match db::calendar::access(&self.db, &account.id).await {
                Ok(a) => a,
                Err(e) => {
                    warn!(error = %e, "couldn't read calendar access");
                    continue;
                }
            };
            let due = forced.contains(&account.id)
                || access
                    .as_ref()
                    .is_some_and(|a| a.status != "unknown" && !HELD.contains(&a.status.as_str()));
            if !due {
                continue;
            }
            let refresh_list = access
                .as_ref()
                .and_then(|a| a.settings_checked_at)
                .is_none_or(|at| now - at >= LIST_INTERVAL_MS);
            if let Err(e) = self.sync_one(&account.id, now, refresh_list).await {
                warn!(error = %e, "calendar sync failed");
            }
        }
    }

    /// Sync one account and record how it went. Errors are recorded (and emitted) here;
    /// the returned error is only a cache failure.
    async fn sync_one(
        &self,
        account_id: &str,
        now: i64,
        refresh_list: bool,
    ) -> Result<(), MailError> {
        let gate = lock(&self.running)
            .entry(account_id.to_owned())
            .or_default()
            .clone();
        let _held = gate.lock().await;
        let before = db::calendar::access(&self.db, account_id)
            .await?
            .map(|a| a.status);
        let api: Arc<dyn CalendarApi> = (self.api_for)(account_id);
        let (status, detail) =
            match sync_account(&self.db, api.as_ref(), account_id, now, refresh_list).await {
                Ok(report) => {
                    if report.changed {
                        self.events.emit(SyncEvent::CalendarUpdated {
                            account_id: account_id.to_owned(),
                        });
                    }
                    ("on", None)
                }
                Err(SyncError::Api(e)) if is_transient(&e) => {
                    warn!(error = %e, "calendar sync will retry");
                    return Ok(());
                }
                Err(SyncError::Api(e)) => classify(&e),
                Err(e) => return Err(sync_error(e)),
            };
        db::calendar::set_access(&self.db, account_id, status, detail.as_deref(), now).await?;
        if before.as_deref() != Some(status) {
            self.events.emit(SyncEvent::CalendarAccess {
                account_id: account_id.to_owned(),
                status: status.to_owned(),
            });
        }
        Ok(())
    }

    /// Check calendars soon after launch, then every minute (15 s while Calendar mode is in
    /// front), or sooner when triggered.
    pub async fn run(self: Arc<Self>) {
        tokio::time::sleep(FIRST_DELAY).await;
        loop {
            self.tick(now_ms()).await;
            let wait = if self.foreground.load(Ordering::Relaxed) {
                FOREGROUND_INTERVAL
            } else {
                INTERVAL
            };
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

/// Whether a single event (or a changed occurrence) overlaps the range; all-day events by
/// their dates in `tz`.
fn overlaps(e: &DbEvent, from_ms: i64, to_ms: i64, tz: chrono_tz::Tz) -> bool {
    if let (Some(start), Some(end)) = (e.start_date.as_deref(), e.end_date.as_deref()) {
        let local = |ms: i64| tz.timestamp_millis_opt(ms).single().map(|d| d.date_naive());
        let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
        return match (local(from_ms), local(to_ms - 1), parse(start), parse(end)) {
            (Some(first), Some(last), Some(start), Some(end)) => start <= last && end > first,
            _ => false,
        };
    }
    match (e.start_ms, e.end_ms) {
        (Some(start), Some(end)) => {
            start < to_ms && (end > from_ms || (end == start && start >= from_ms))
        }
        _ => false,
    }
}

fn dto(e: &DbEvent, occ: Option<&Occurrence>) -> CalendarEventDto {
    let time = |ms: Option<i64>, date: Option<String>| EventTimeDto {
        ms,
        date,
        time_zone: e.time_zone.clone(),
    };
    let (id, master_id, start, end) = match occ {
        Some(o) => (
            o.event_id.clone(),
            o.master_id.clone(),
            time(o.start_ms, o.start_date.clone()),
            time(o.end_ms, o.end_date.clone()),
        ),
        None => (
            e.id.clone(),
            e.recurring_event_id.clone(),
            time(
                e.start_date.is_none().then_some(e.start_ms).flatten(),
                e.start_date.clone(),
            ),
            time(
                e.end_date.is_none().then_some(e.end_ms).flatten(),
                e.end_date.clone(),
            ),
        ),
    };
    CalendarEventDto {
        account_id: e.account_id.clone(),
        calendar_id: e.calendar_id.clone(),
        id,
        recurring: master_id.is_some(),
        master_id,
        summary: e.summary.clone(),
        start,
        end,
        all_day: e.is_all_day(),
        status: e.status.clone(),
        self_response: e.self_response.clone(),
        location: e.location.clone(),
        has_conference: e.conference.is_some(),
        color_id: e.color_id.clone(),
        transparency: e.transparency.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::{calendar, timed, FakeCalendar};
    use crate::db::accounts::{insert_account, DbAccount};
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use serde_json::json;
    use std::collections::HashMap;

    fn ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    struct Harness {
        _db: TestDb,
        fakes: HashMap<String, Arc<FakeCalendar>>,
        events: Arc<RecordingEvents>,
        service: Arc<CalendarService>,
    }

    async fn harness(accounts: &[&str]) -> Harness {
        let db = TestDb::new().await;
        let mut fakes = HashMap::new();
        for id in accounts {
            insert_account(
                &db.pool,
                &DbAccount {
                    id: (*id).into(),
                    email: format!("{id}@example.com"),
                    display_name: None,
                    profile_photo_url: None,
                    client_id: "c".into(),
                    history_id: None,
                    created_at: 0,
                    updated_at: 0,
                },
            )
            .await
            .unwrap();
            let fake = Arc::new(FakeCalendar::default());
            let mut primary = calendar(&format!("{id}@example.com"));
            primary.primary = true;
            fake.add_calendar(primary);
            fakes.insert((*id).to_owned(), fake);
        }
        let by_account = fakes.clone();
        let api_for: CalendarFactory = Arc::new(move |account_id: &str| {
            by_account[account_id].clone() as Arc<dyn CalendarApi>
        });
        let events = Arc::new(RecordingEvents::default());
        let service = CalendarService::new(db.pool.clone(), api_for, events.clone());
        Harness {
            _db: db,
            fakes,
            events,
            service,
        }
    }

    impl Harness {
        fn fake(&self, account: &str) -> &FakeCalendar {
            &self.fakes[account]
        }

        async fn grant(&self, account: &str) {
            self.service.sync_now(account).await.unwrap();
        }
    }

    fn standup_series() -> serde_json::Value {
        let mut e = timed(
            "standup",
            "Standup",
            "2026-10-26T09:00:00-04:00",
            "2026-10-26T09:15:00-04:00",
        );
        e["recurrence"] = json!(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
        e
    }

    #[tokio::test]
    async fn events_merges_accounts_and_expands_series() {
        let h = harness(&["a", "b"]).await;
        h.fake("a").put("a@example.com", standup_series());
        h.fake("b").put(
            "b@example.com",
            timed(
                "lunch",
                "Lunch",
                "2026-11-10T12:00:00-05:00",
                "2026-11-10T13:00:00-05:00",
            ),
        );
        h.grant("a").await;
        h.grant("b").await;

        let got = h
            .service
            .events(
                ms("2026-11-08T00:00:00Z"),
                ms("2026-11-15T00:00:00Z"),
                "UTC",
            )
            .await
            .unwrap();

        let summary: Vec<(&str, &str, &str)> = got
            .iter()
            .map(|e| {
                (
                    e.account_id.as_str(),
                    e.id.as_str(),
                    e.summary.as_deref().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a", "standup_20261109T140000Z", "Standup"),
                ("b", "lunch", "Lunch")
            ]
        );
        assert_eq!(got[0].master_id.as_deref(), Some("standup"));
        assert!(got[0].recurring);
        assert_eq!(got[0].start.ms, Some(ms("2026-11-09T14:00:00Z")));
        assert!(!got[1].recurring);
    }

    #[tokio::test]
    async fn range_includes_override_moved_into_range() {
        let h = harness(&["a"]).await;
        h.fake("a").put("a@example.com", standup_series());
        let mut moved = timed(
            "standup_20261102T140000Z",
            "Standup (moved)",
            "2026-11-10T10:00:00-05:00",
            "2026-11-10T10:15:00-05:00",
        );
        moved["recurringEventId"] = json!("standup");
        moved["originalStartTime"] =
            json!({"dateTime": "2026-11-02T09:00:00-05:00", "timeZone": "America/New_York"});
        h.fake("a").put("a@example.com", moved);
        h.grant("a").await;

        let week = h
            .service
            .events(
                ms("2026-11-09T00:00:00Z"),
                ms("2026-11-16T00:00:00Z"),
                "UTC",
            )
            .await
            .unwrap();
        let ids: Vec<&str> = week.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["standup_20261109T140000Z", "standup_20261102T140000Z"]
        );
        assert_eq!(week[1].summary.as_deref(), Some("Standup (moved)"));
        assert_eq!(week[1].master_id.as_deref(), Some("standup"));

        let before = h
            .service
            .events(
                ms("2026-10-26T00:00:00Z"),
                ms("2026-11-09T00:00:00Z"),
                "UTC",
            )
            .await
            .unwrap();
        let ids: Vec<&str> = before.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["standup_20261026T130000Z"]);
    }

    #[tokio::test]
    async fn all_day_events_are_trimmed_by_the_viewers_zone() {
        let h = harness(&["a"]).await;
        h.fake("a").put(
            "a@example.com",
            json!({"id": "holiday", "status": "confirmed", "etag": "\"h\"", "summary": "Holiday",
                   "start": {"date": "2026-11-12"}, "end": {"date": "2026-11-13"}}),
        );
        h.grant("a").await;
        // Nov 11 in Los Angeles ends at Nov 12 08:00Z; the holiday is on Nov 12.
        let nov_11 = h
            .service
            .events(
                ms("2026-11-11T08:00:00Z"),
                ms("2026-11-12T08:00:00Z"),
                "America/Los_Angeles",
            )
            .await
            .unwrap();
        assert!(nov_11.is_empty(), "{nov_11:?}");
        let nov_12 = h
            .service
            .events(
                ms("2026-11-12T08:00:00Z"),
                ms("2026-11-13T08:00:00Z"),
                "America/Los_Angeles",
            )
            .await
            .unwrap();
        assert!(nov_12[0].all_day);
        assert_eq!(nov_12[0].start.date.as_deref(), Some("2026-11-12"));
        assert_eq!(nov_12[0].end.date.as_deref(), Some("2026-11-13"));
    }

    #[tokio::test]
    async fn hidden_calendar_events_are_left_out_and_toggle_emits_update() {
        let h = harness(&["a"]).await;
        h.fake("a").put(
            "a@example.com",
            timed(
                "lunch",
                "Lunch",
                "2026-11-10T12:00:00-05:00",
                "2026-11-10T13:00:00-05:00",
            ),
        );
        h.grant("a").await;
        h.events.take();

        h.service
            .set_calendar_hidden("a", "a@example.com", true)
            .await
            .unwrap();
        let got = h
            .service
            .events(
                ms("2026-11-10T00:00:00Z"),
                ms("2026-11-11T00:00:00Z"),
                "UTC",
            )
            .await
            .unwrap();
        assert!(got.is_empty());
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
        let accounts = h.service.accounts().await.unwrap();
        assert!(accounts[0].calendars[0].hidden);
    }

    #[tokio::test]
    async fn missing_scope_marks_status_and_skips_until_reset() {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        h.events.take();
        h.fake("a").fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        });

        h.service.tick(1_000).await;
        let accounts = h.service.accounts().await.unwrap();
        assert_eq!(accounts[0].access.status, "missing_scope");
        assert_eq!(h.events.names(), vec!["calendar:access"]);

        let calls = h.fake("a").calls();
        h.service.tick(2_000).await;
        assert_eq!(h.fake("a").calls(), calls, "a held account isn't polled");

        h.fake("a").succeed();
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "on");
        assert!(h.fake("a").calls() > calls);
        assert_eq!(h.events.names(), vec!["calendar:access"]);
    }

    #[tokio::test]
    async fn offline_leaves_the_status_alone() {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        h.fake("a")
            .fail_with(|| GmailError::Offline("no route".into()));
        h.service.tick(1_000).await;
        assert_eq!(h.service.accounts().await.unwrap()[0].access.status, "on");
    }

    #[tokio::test]
    async fn api_disabled_links_to_the_project() {
        let h = harness(&["a"]).await;
        h.fake("a").fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("accessNotConfigured".into()),
            message:
                "Google Calendar API has not been used in project 42 before or it is disabled."
                    .into(),
        });
        let access = h.service.sync_now("a").await.unwrap();
        assert_eq!(access.status, "api_disabled");
        assert_eq!(
            access.enable_url.as_deref(),
            Some("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=42")
        );
    }

    #[tokio::test]
    async fn accounts_lists_never_granted_accounts_as_unknown() {
        let h = harness(&["a", "b"]).await;
        h.grant("a").await;
        let accounts = h.service.accounts().await.unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].account_id, "a");
        assert_eq!(accounts[0].access.status, "on");
        assert_eq!(accounts[0].calendars.len(), 1);
        assert!(accounts[0].calendars[0].primary);
        assert_eq!(accounts[1].email, "b@example.com");
        assert_eq!(accounts[1].access.status, "unknown");
        assert!(accounts[1].calendars.is_empty());
    }

    #[tokio::test]
    async fn tick_only_syncs_granted_accounts_and_reports_changes() {
        let h = harness(&["a", "b"]).await;
        h.grant("a").await;
        h.events.take();
        let b_calls = h.fake("b").calls();

        h.fake("a").put(
            "a@example.com",
            timed(
                "new",
                "New",
                "2026-11-10T12:00:00-05:00",
                "2026-11-10T13:00:00-05:00",
            ),
        );
        h.service.tick(5_000).await;

        assert_eq!(h.fake("b").calls(), b_calls, "never-granted b isn't polled");
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
        h.service.tick(6_000).await;
        assert!(
            h.events.names().is_empty(),
            "nothing changed, nothing emitted"
        );
    }

    #[tokio::test]
    async fn triggered_account_is_synced_even_when_never_granted() {
        let h = harness(&["a"]).await;
        h.service.trigger(Some("a".into()));
        h.service.tick(1_000).await;
        assert_eq!(h.service.accounts().await.unwrap()[0].access.status, "on");
    }
}
