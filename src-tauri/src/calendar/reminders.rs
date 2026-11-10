//! Event reminders as desktop notifications, planned from the local calendar cache.
//!
//! Each shown event's "notification" reminders (its own, else its calendar's defaults) fire at
//! their time. The plan covers the next 24 hours and is read again after every calendar change
//! (`replan`), every 15 minutes, and whenever a reminder comes due, so it never fires from a
//! stale cache. A reminder that came due less than 5 minutes ago (the computer slept, or
//! Pheeme started late) still fires once; older ones are skipped. What has fired is recorded
//! in `calendar_reminders_fired`, so a restart never shows one twice. Tauri-free: the OS
//! notification is behind [`ReminderAlerts`].

use super::recurrence;
use crate::db;
use crate::db::calendar::{DbCalendar, DbEvent};
use crate::db::reminders::ReminderKey;
use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::{info, warn};

const MINUTE_MS: i64 = 60 * 1000;
/// How far ahead the plan looks.
pub const LOOKAHEAD_MS: i64 = 24 * 60 * MINUTE_MS;
/// A reminder this late still fires (after sleep or a late launch); an older one doesn't.
pub const CATCH_UP_MS: i64 = 5 * MINUTE_MS;
/// Google's longest reminder: four weeks before the event.
const MAX_LEAD_MINUTES: i64 = 4 * 7 * 24 * 60;
/// The plan is read again at least this often, as the 24 hours move on.
const REPLAN_MS: i64 = 15 * MINUTE_MS;
/// How long fired reminders are remembered; by then they can't come due again.
const KEEP_FIRED_MS: i64 = 2 * 24 * 60 * MINUTE_MS;
/// The loop wakes at least this often and goes by the wall clock, so a sleep that stops
/// timers can't make it miss the catch-up window by much.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// One reminder of one occurrence, due at `fire_at_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub key: ReminderKey,
    pub fire_at_ms: i64,
    pub summary: Option<String>,
    pub location: Option<String>,
    /// All-day events: the first day (`YYYY-MM-DD`).
    pub start_date: Option<String>,
    /// The account's Calendar time zone, for "Today" and "Tomorrow".
    zone: chrono_tz::Tz,
    /// The same reminder of the same event on another account's calendar (an invite both
    /// accounts got): recorded with this one, shown once.
    pub also: Vec<ReminderKey>,
}

/// The event a reminder opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTarget {
    pub account_id: String,
    pub calendar_id: String,
    pub event_id: String,
}

/// What a reminder shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub title: String,
    pub body: String,
    pub target: EventTarget,
}

/// The OS side of a reminder: whether notifications may show, and showing one.
#[async_trait::async_trait]
pub trait ReminderAlerts: Send + Sync {
    /// Whether the OS lets Pheeme show notifications. Never prompts.
    async fn permitted(&self) -> bool;
    /// Show the notification; `false` if the OS refused it.
    async fn show(&self, alert: Alert) -> bool;
}

/// How a due reminder was handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Shown,
    Failed,
    /// Settings › Notifications turned calendar reminders off.
    Off,
    /// Outside the notification schedule: dropped, not saved for later (as with mail).
    Quiet,
    /// The OS doesn't allow Pheeme's notifications.
    NotPermitted,
}

#[derive(Default)]
struct PlanState {
    plan: Vec<Reminder>,
    planned_at: Option<i64>,
    dirty: bool,
    /// Fired this run, in case recording one in the database failed.
    fired: HashMap<ReminderKey, i64>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct ReminderService {
    db: SqlitePool,
    alerts: Arc<dyn ReminderAlerts>,
    /// The zone the notification schedule's hours are in; `None` is the computer's.
    schedule_zone: Option<chrono_tz::Tz>,
    state: Mutex<PlanState>,
    wake: Notify,
}

impl ReminderService {
    pub fn new(db: SqlitePool, alerts: Arc<dyn ReminderAlerts>) -> Arc<Self> {
        Self::build(db, alerts, None)
    }

    fn build(
        db: SqlitePool,
        alerts: Arc<dyn ReminderAlerts>,
        schedule_zone: Option<chrono_tz::Tz>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            alerts,
            schedule_zone,
            state: Mutex::new(PlanState {
                dirty: true,
                ..PlanState::default()
            }),
            wake: Notify::new(),
        })
    }

    /// Read the plan again on the next tick: the cache, the hidden calendars or calendar
    /// access changed.
    pub fn replan(&self) {
        lock(&self.state).dirty = true;
        self.wake.notify_one();
    }

    /// Reminders due in `[now - CATCH_UP_MS, now + LOOKAHEAD_MS]` that haven't fired, by when
    /// they're due.
    pub async fn plan(&self, now: i64) -> anyhow::Result<Vec<Reminder>> {
        let from = now - CATCH_UP_MS;
        let until = now + LOOKAHEAD_MS;
        let access: HashMap<String, (String, Option<String>)> = db::calendar::access_all(&self.db)
            .await?
            .into_iter()
            .map(|(account, status, zone)| (account, (status, zone)))
            .collect();
        let calendars: HashMap<(String, String), DbCalendar> =
            db::calendar::calendars(&self.db, None)
                .await?
                .into_iter()
                .map(|c| ((c.account_id.clone(), c.id.clone()), c))
                .collect();
        let mut fired: HashSet<ReminderKey> =
            db::reminders::fired(&self.db).await?.into_iter().collect();
        fired.extend(lock(&self.state).fired.keys().cloned());
        let rows =
            db::calendar::events_overlapping(&self.db, from, until + MAX_LEAD_MINUTES * MINUTE_MS)
                .await?;
        let mut overrides: HashMap<(&str, &str, &str), Vec<&DbEvent>> = HashMap::new();
        for e in &rows {
            if let Some(master) = &e.recurring_event_id {
                overrides
                    .entry((&e.account_id, &e.calendar_id, master))
                    .or_default()
                    .push(e);
            }
        }
        let mut out: Vec<Reminder> = Vec::new();
        // The same event on two accounts' calendars (iCalUID, start, lead) reminds once.
        let mut seen: HashMap<(String, i64, i64), usize> = HashMap::new();
        for e in &rows {
            // Access taken away (or never given): the cache may be stale.
            let Some((status, account_zone)) = access.get(&e.account_id) else {
                continue;
            };
            if matches!(status.as_str(), "unknown" | "missing_scope") {
                continue;
            }
            let Some(calendar) = calendars.get(&(e.account_id.clone(), e.calendar_id.clone()))
            else {
                continue;
            };
            if calendar.hidden || e.self_response.as_deref() == Some("declined") {
                continue;
            }
            let leads = popup_minutes(e, calendar);
            if leads.is_empty() {
                continue;
            }
            let zone = account_zone
                .as_deref()
                .or(calendar.time_zone.as_deref())
                .and_then(|z| z.parse().ok())
                .unwrap_or(chrono_tz::UTC);
            // (event id, start ms, first day if all-day)
            let mut starts: Vec<(String, i64, Option<String>)> = Vec::new();
            if e.recurrence.is_some() {
                let replaced = overrides
                    .get(&(e.account_id.as_str(), e.calendar_id.as_str(), e.id.as_str()))
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let to = until + MAX_LEAD_MINUTES * MINUTE_MS;
                for occ in recurrence::expand(e, replaced, from, to, zone) {
                    let start = match &occ.start_date {
                        Some(day) => midnight(day, zone),
                        None => occ.start_ms,
                    };
                    if let Some(start) = start {
                        starts.push((occ.event_id, start, occ.start_date));
                    }
                }
            } else if e.status != "cancelled" {
                let start = match &e.start_date {
                    Some(day) => midnight(day, zone),
                    None => e.start_ms,
                };
                if let Some(start) = start {
                    starts.push((e.id.clone(), start, e.start_date.clone()));
                }
            }
            for (event_id, start_ms, start_date) in starts {
                for &minutes in &leads {
                    let fire_at_ms = start_ms - minutes * MINUTE_MS;
                    if fire_at_ms < from || fire_at_ms > until {
                        continue;
                    }
                    let key = ReminderKey {
                        account_id: e.account_id.clone(),
                        calendar_id: e.calendar_id.clone(),
                        event_id: event_id.clone(),
                        start_ms,
                        minutes,
                    };
                    if fired.contains(&key) {
                        continue;
                    }
                    let same = (
                        e.ical_uid.clone().unwrap_or_else(|| event_id.clone()),
                        start_ms,
                        minutes,
                    );
                    if let Some(&first) = seen.get(&same) {
                        out[first].also.push(key);
                        continue;
                    }
                    seen.insert(same, out.len());
                    out.push(Reminder {
                        key,
                        fire_at_ms,
                        summary: e.summary.clone(),
                        location: e.location.clone(),
                        start_date: start_date.clone(),
                        zone,
                        also: Vec::new(),
                    });
                }
            }
        }
        out.sort_by(|a, b| (a.fire_at_ms, &a.key).cmp(&(b.fire_at_ms, &b.key)));
        Ok(out)
    }

    /// Re-plan if needed and fire what's due at `now`. Returns when the next reminder is due.
    pub async fn tick(&self, now: i64) -> Option<i64> {
        let needs_plan = {
            let s = lock(&self.state);
            s.dirty
                || s.planned_at.is_none_or(|at| now < at || now - at >= REPLAN_MS)
                // Read the cache again before firing, so a reminder never comes from an event
                // that was just moved, declined or deleted.
                || s.plan.iter().any(|r| r.fire_at_ms <= now)
        };
        if needs_plan {
            match self.plan(now).await {
                Ok(plan) => {
                    let mut s = lock(&self.state);
                    s.plan = plan;
                    s.dirty = false;
                    s.planned_at = Some(now);
                    s.fired.retain(|_, at| *at >= now - KEEP_FIRED_MS);
                }
                Err(error) => {
                    warn!(%error, "couldn't plan event reminders");
                    lock(&self.state).planned_at = Some(now);
                }
            }
            if let Err(error) = db::reminders::prune(&self.db, now - KEEP_FIRED_MS).await {
                warn!(%error, "couldn't forget old event reminders");
            }
        }
        let due: Vec<Reminder> = {
            let mut s = lock(&self.state);
            let (due, later) = std::mem::take(&mut s.plan)
                .into_iter()
                .partition(|r| r.fire_at_ms <= now);
            s.plan = later;
            due
        };
        let mut counts: HashMap<&'static str, usize> = HashMap::new();
        for reminder in due {
            if reminder.fire_at_ms < now - CATCH_UP_MS {
                *counts.entry("too_late").or_default() += 1;
                continue;
            }
            let outcome = self.deliver(&reminder, now).await;
            *counts
                .entry(match outcome {
                    Outcome::Shown => "shown",
                    Outcome::Failed => "failed",
                    Outcome::Off => "off",
                    Outcome::Quiet => "quiet",
                    Outcome::NotPermitted => "not_permitted",
                })
                .or_default() += 1;
            for key in std::iter::once(&reminder.key).chain(&reminder.also) {
                lock(&self.state).fired.insert(key.clone(), now);
                if let Err(error) = db::reminders::mark_fired(&self.db, key, now).await {
                    warn!(%error, "couldn't record an event reminder as shown");
                }
            }
        }
        if !counts.is_empty() {
            // Counts only: never the event's title or place.
            let mut counts: Vec<_> = counts.into_iter().collect();
            counts.sort();
            info!(?counts, "event reminders due");
        }
        lock(&self.state)
            .plan
            .iter()
            .map(|r| r.fire_at_ms)
            .filter(|&at| at > now)
            .min()
    }

    async fn deliver(&self, reminder: &Reminder, now: i64) -> Outcome {
        if !db::settings::calendar_reminders(&self.db)
            .await
            .unwrap_or(true)
        {
            return Outcome::Off;
        }
        let schedule = db::settings::notify_schedule(&self.db)
            .await
            .unwrap_or_default();
        if !schedule.allows(self.local_time(now)) {
            return Outcome::Quiet;
        }
        if !self.alerts.permitted().await {
            return Outcome::NotPermitted;
        }
        if self.alerts.show(alert(reminder, now)).await {
            Outcome::Shown
        } else {
            Outcome::Failed
        }
    }

    fn local_time(&self, now: i64) -> NaiveDateTime {
        match self.schedule_zone {
            Some(zone) => zone
                .timestamp_millis_opt(now)
                .single()
                .map(|d| d.naive_local()),
            None => Local
                .timestamp_millis_opt(now)
                .single()
                .map(|d| d.naive_local()),
        }
        .unwrap_or_default()
    }

    /// Plan and fire until the app quits, waking for the next reminder, a re-plan, or at
    /// least every 30 seconds.
    pub async fn run(self: Arc<Self>) {
        loop {
            let now = crate::sync::engine::now_ms();
            let next = self.tick(now).await;
            let wait = next
                .map(|at| Duration::from_millis(u64::try_from(at - now).unwrap_or(0)))
                .map_or(MAX_WAIT, |d| d.min(MAX_WAIT));
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reminders {
    #[serde(default)]
    use_default: bool,
    #[serde(default)]
    overrides: Vec<Lead>,
}

#[derive(Deserialize)]
struct Lead {
    method: String,
    minutes: i64,
}

/// The event's notification reminders, in minutes before it starts: its own, or its
/// calendar's defaults. Email reminders are Google's to send. The defaults Google shares are
/// for timed events (all-day ones have their own, which the API doesn't expose), so an
/// all-day event reminds only when it has reminders of its own.
fn popup_minutes(e: &DbEvent, calendar: &DbCalendar) -> Vec<i64> {
    let own: Option<Reminders> = e
        .reminders
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok());
    let leads = match own {
        Some(r) if !r.use_default => r.overrides,
        _ if e.is_all_day() => Vec::new(),
        _ => serde_json::from_str(&calendar.default_reminders).unwrap_or_default(),
    };
    let mut minutes: Vec<i64> = leads
        .into_iter()
        .filter(|l| l.method == "popup" && (0..=MAX_LEAD_MINUTES).contains(&l.minutes))
        .map(|l| l.minutes)
        .collect();
    minutes.sort_unstable();
    minutes.dedup();
    minutes
}

fn midnight(day: &str, zone: chrono_tz::Tz) -> Option<i64> {
    let day = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    zone.from_local_datetime(&day.and_time(chrono::NaiveTime::MIN))
        .earliest()
        .map(|d| d.timestamp_millis())
}

fn plural(n: i64, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

/// When the event is, said from `now`: "In 10 minutes", "Now", "Tomorrow".
fn when(reminder: &Reminder, now: i64) -> String {
    if let Some(day) = reminder
        .start_date
        .as_deref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    {
        let today = reminder
            .zone
            .timestamp_millis_opt(now)
            .single()
            .map(|d| d.date_naive())
            .unwrap_or(day);
        return match (day - today).num_days() {
            ..=0 => "Today".into(),
            1 => "Tomorrow".into(),
            n => format!("In {n} days"),
        };
    }
    // Rounded to the minute: a reminder fired a few seconds late still says "In 10 minutes".
    let minutes = (reminder.key.start_ms - now + MINUTE_MS / 2).div_euclid(MINUTE_MS);
    match minutes {
        ..=0 => "Now".into(),
        1..=59 => format!("In {}", plural(minutes, "minute")),
        60..=1439 => {
            let (hours, rest) = (minutes / 60, minutes % 60);
            if rest == 0 {
                format!("In {}", plural(hours, "hour"))
            } else {
                format!("In {} {}", plural(hours, "hour"), plural(rest, "minute"))
            }
        }
        _ => format!("In {}", plural((minutes + 720) / 1440, "day")),
    }
}

/// Bounded plain text for the OS: no control characters, no unbounded titles.
fn clean(text: &str, limit: usize) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn alert(reminder: &Reminder, now: i64) -> Alert {
    let title = reminder
        .summary
        .as_deref()
        .map(|s| clean(s, 160))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(No title)".into());
    let mut body = when(reminder, now);
    if let Some(place) = reminder
        .location
        .as_deref()
        .map(|l| clean(l.lines().next().unwrap_or_default(), 160))
        .filter(|l| !l.is_empty())
    {
        body.push_str(" · ");
        body.push_str(&place);
    }
    Alert {
        title,
        body,
        target: EventTarget {
            account_id: reminder.key.account_id.clone(),
            calendar_id: reminder.key.calendar_id.clone(),
            event_id: reminder.key.event_id.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::{calendar, timed};
    use crate::calendar::service::tests::{harness, ms, standup_series, Harness};
    use crate::desktop::{NotifySchedule, ScheduleMode};
    use crate::gmail::calendar::ApiReminder;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct FakeAlerts {
        shown: Mutex<Vec<Alert>>,
        denied: AtomicBool,
    }

    #[async_trait::async_trait]
    impl ReminderAlerts for FakeAlerts {
        async fn permitted(&self) -> bool {
            !self.denied.load(Ordering::Relaxed)
        }
        async fn show(&self, alert: Alert) -> bool {
            self.shown.lock().unwrap().push(alert);
            true
        }
    }

    impl FakeAlerts {
        fn take(&self) -> Vec<(String, String, String)> {
            std::mem::take(&mut *self.shown.lock().unwrap())
                .into_iter()
                .map(|a| (a.title, a.body, a.target.event_id))
                .collect()
        }
    }

    const NY: chrono_tz::Tz = chrono_tz::America::New_York;

    struct Setup {
        h: Harness,
        alerts: Arc<FakeAlerts>,
        reminders: Arc<ReminderService>,
    }

    impl Setup {
        fn pool(&self) -> &SqlitePool {
            &self.h.service.db
        }
        async fn tick(&self, at: &str) -> Option<i64> {
            self.reminders.tick(ms(at)).await
        }
        async fn put(&self, account: &str, event: serde_json::Value) {
            self.h
                .fake(account)
                .put(&format!("{account}@example.com"), event);
            self.h.grant(account).await;
            self.reminders.replan();
        }
    }

    /// Accounts whose primary calendar reminds 10 minutes before by default.
    async fn setup(accounts: &[&str]) -> Setup {
        let h = harness(accounts).await;
        for account in accounts {
            let mut primary = calendar(&format!("{account}@example.com"));
            primary.primary = true;
            primary.default_reminders = vec![ApiReminder {
                method: "popup".into(),
                minutes: 10,
            }];
            h.fake(account).remove_calendar(&primary.id);
            h.fake(account).add_calendar(primary);
            h.grant(account).await;
        }
        let alerts = Arc::new(FakeAlerts::default());
        let reminders = ReminderService::build(h.service.db.clone(), alerts.clone(), Some(NY));
        Setup {
            h,
            alerts,
            reminders,
        }
    }

    fn with_reminders(mut e: serde_json::Value, reminders: serde_json::Value) -> serde_json::Value {
        e["reminders"] = reminders;
        e
    }

    // 2026-11-11 is a Wednesday; New York is UTC-5.
    fn review() -> serde_json::Value {
        let mut e = timed(
            "review",
            "Design review",
            "2026-11-11T14:00:00-05:00",
            "2026-11-11T15:00:00-05:00",
        );
        e["location"] = json!("Room 4\nSecond floor");
        e
    }

    #[tokio::test]
    async fn default_reminder_fires_once_at_its_time_and_says_when() {
        let s = setup(&["a"]).await;
        s.put("a", review()).await;
        let next = s.tick("2026-11-11T13:00:00-05:00").await;
        assert_eq!(next, Some(ms("2026-11-11T13:50:00-05:00")));
        assert!(s.alerts.take().is_empty());
        assert_eq!(s.tick("2026-11-11T13:49:59-05:00").await, next);
        assert!(s.alerts.take().is_empty());

        assert_eq!(s.tick("2026-11-11T13:50:02-05:00").await, None);
        let shown = std::mem::take(&mut *s.alerts.shown.lock().unwrap());
        assert_eq!(
            shown,
            vec![Alert {
                title: "Design review".into(),
                body: "In 10 minutes · Room 4".into(),
                target: EventTarget {
                    account_id: "a".into(),
                    calendar_id: "a@example.com".into(),
                    event_id: "review".into(),
                },
            }]
        );

        // Re-planned and ticked again: never twice, even after a restart.
        s.reminders.replan();
        s.tick("2026-11-11T13:51:00-05:00").await;
        let restarted = ReminderService::build(s.pool().clone(), s.alerts.clone(), Some(NY));
        restarted.tick(ms("2026-11-11T13:52:00-05:00")).await;
        assert!(s.alerts.take().is_empty());
    }

    #[tokio::test]
    async fn own_reminders_replace_the_defaults_and_email_ones_are_left_to_google() {
        let s = setup(&["a"]).await;
        s.put(
            "a",
            with_reminders(
                review(),
                json!({"useDefault": false, "overrides": [
                    {"method": "email", "minutes": 60},
                    {"method": "popup", "minutes": 30},
                    {"method": "popup", "minutes": 0}
                ]}),
            ),
        )
        .await;
        let plan = s
            .reminders
            .plan(ms("2026-11-11T09:00:00-05:00"))
            .await
            .unwrap();
        let leads: Vec<i64> = plan.iter().map(|r| r.key.minutes).collect();
        assert_eq!(leads, vec![30, 0]);

        s.tick("2026-11-11T13:30:00-05:00").await;
        s.tick("2026-11-11T14:00:20-05:00").await;
        let bodies: Vec<String> = s.alerts.take().into_iter().map(|a| a.1).collect();
        assert_eq!(bodies, vec!["In 30 minutes · Room 4", "Now · Room 4"]);

        // No reminders of its own and not the defaults: silent.
        let mut quiet = timed(
            "quiet",
            "Quiet",
            "2026-11-11T16:00:00-05:00",
            "2026-11-11T17:00:00-05:00",
        );
        quiet["reminders"] = json!({"useDefault": false});
        s.put("a", quiet).await;
        s.tick("2026-11-11T15:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());
    }

    #[tokio::test]
    async fn the_plan_looks_a_day_ahead_including_long_leads() {
        let s = setup(&["a"]).await;
        let mut far = timed(
            "far",
            "Far",
            "2026-11-14T10:00:00-05:00",
            "2026-11-14T11:00:00-05:00",
        );
        far["reminders"] =
            json!({"useDefault": false, "overrides": [{"method": "popup", "minutes": 2880}]});
        s.put("a", far).await;
        s.put(
            "a",
            timed(
                "later",
                "Later",
                "2026-11-13T10:00:00-05:00",
                "2026-11-13T11:00:00-05:00",
            ),
        )
        .await;
        // Far reminds two days ahead, at 10:00 on the 12th; Later 10 minutes before.
        let ids =
            |plan: Vec<Reminder>| plan.into_iter().map(|r| r.key.event_id).collect::<Vec<_>>();
        let plan = |at: &str| s.reminders.plan(ms(at));
        assert!(ids(plan("2026-11-11T09:59:00-05:00").await.unwrap()).is_empty());
        assert_eq!(
            ids(plan("2026-11-11T10:00:00-05:00").await.unwrap()),
            vec!["far"]
        );
        let both = plan("2026-11-12T09:50:00-05:00").await.unwrap();
        assert_eq!(both[0].fire_at_ms, ms("2026-11-12T10:00:00-05:00"));
        assert_eq!(ids(both), vec!["far", "later"]);
        s.tick("2026-11-12T10:00:00-05:00").await;
        assert_eq!(s.alerts.take()[0].1, "In 2 days");
    }

    #[tokio::test]
    async fn a_change_is_planned_again_moved_events_remind_at_the_new_time() {
        let s = setup(&["a"]).await;
        s.put("a", review()).await;
        assert_eq!(
            s.tick("2026-11-11T13:00:00-05:00").await,
            Some(ms("2026-11-11T13:50:00-05:00"))
        );
        let mut moved = review();
        moved["start"]["dateTime"] = json!("2026-11-11T16:00:00-05:00");
        moved["end"]["dateTime"] = json!("2026-11-11T17:00:00-05:00");
        moved["etag"] = json!("\"2\"");
        s.put("a", moved).await;
        assert_eq!(
            s.tick("2026-11-11T13:01:00-05:00").await,
            Some(ms("2026-11-11T15:50:00-05:00"))
        );
        // Nothing at the old time.
        s.tick("2026-11-11T13:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());
        s.tick("2026-11-11T15:50:00-05:00").await;
        assert_eq!(s.alerts.take().len(), 1);

        // Deleted before its reminder: the cache is read again first, so nothing shows.
        s.put(
            "a",
            timed(
                "gone",
                "Gone",
                "2026-11-11T18:00:00-05:00",
                "2026-11-11T19:00:00-05:00",
            ),
        )
        .await;
        assert_eq!(
            s.tick("2026-11-11T16:00:00-05:00").await,
            Some(ms("2026-11-11T17:50:00-05:00"))
        );
        s.h.fake("a").cancel("a@example.com", "gone");
        s.h.grant("a").await; // no replan(): the due reminder itself triggers the re-read
        s.tick("2026-11-11T17:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());
    }

    #[tokio::test]
    async fn after_sleep_a_reminder_up_to_five_minutes_late_fires_older_ones_dont() {
        let s = setup(&["a"]).await;
        s.put("a", review()).await;
        s.put(
            "a",
            timed(
                "late",
                "Late",
                "2026-11-11T14:10:00-05:00",
                "2026-11-11T15:00:00-05:00",
            ),
        )
        .await;
        s.tick("2026-11-11T13:00:00-05:00").await;
        // Asleep from 13:00 to 14:04: review's 13:50 reminder is 14 min late, late's 14:00 is 4.
        s.tick("2026-11-11T14:04:00-05:00").await;
        let shown = s.alerts.take();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].0, "Late");
        assert_eq!(shown[0].1, "In 6 minutes");
    }

    #[tokio::test]
    async fn a_late_launch_catches_up_within_the_window() {
        let s = setup(&["a"]).await;
        s.put("a", review()).await;
        // First tick ever, 3 minutes after the reminder was due.
        s.tick("2026-11-11T13:53:00-05:00").await;
        assert_eq!(s.alerts.take()[0].1, "In 7 minutes · Room 4");
    }

    #[tokio::test]
    async fn declined_events_and_hidden_calendars_are_skipped() {
        let s = setup(&["a"]).await;
        let mut declined = timed(
            "no",
            "Declined",
            "2026-11-11T14:00:00-05:00",
            "2026-11-11T15:00:00-05:00",
        );
        declined["attendees"] = json!([
            {"email": "a@example.com", "self": true, "responseStatus": "declined"},
            {"email": "o@example.com", "organizer": true, "responseStatus": "accepted"}
        ]);
        s.put("a", declined).await;
        let mut team = calendar("team");
        team.default_reminders = vec![ApiReminder {
            method: "popup".into(),
            minutes: 10,
        }];
        s.h.fake("a").add_calendar(team);
        s.h.fake("a").put(
            "team",
            timed(
                "t",
                "Team",
                "2026-11-11T14:00:00-05:00",
                "2026-11-11T15:00:00-05:00",
            ),
        );
        s.h.service.sync_now("a").await.unwrap();
        let now = ms("2026-11-11T13:00:00-05:00");
        let ids =
            |plan: Vec<Reminder>| plan.into_iter().map(|r| r.key.event_id).collect::<Vec<_>>();
        assert_eq!(ids(s.reminders.plan(now).await.unwrap()), vec!["t"]);
        s.h.service
            .set_calendar_hidden("a", "team", true)
            .await
            .unwrap();
        assert!(s.reminders.plan(now).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn repeating_events_remind_per_occurrence_and_changed_ones_by_their_own() {
        let s = setup(&["a"]).await;
        // Mondays 09:00 New York.
        s.put("a", standup_series()).await;
        let mut moved = timed(
            "standup_20261116T140000Z",
            "Standup (moved)",
            "2026-11-16T11:00:00-05:00",
            "2026-11-16T11:15:00-05:00",
        );
        moved["recurringEventId"] = json!("standup");
        moved["originalStartTime"] = json!({"dateTime": "2026-11-16T09:00:00-05:00"});
        s.put("a", moved).await;
        let plan = s
            .reminders
            .plan(ms("2026-11-09T08:00:00-05:00"))
            .await
            .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].key.event_id, "standup_20261109T140000Z");
        assert_eq!(plan[0].fire_at_ms, ms("2026-11-09T08:50:00-05:00"));
        let plan = s
            .reminders
            .plan(ms("2026-11-16T08:00:00-05:00"))
            .await
            .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].key.event_id, "standup_20261116T140000Z");
        assert_eq!(plan[0].fire_at_ms, ms("2026-11-16T10:50:00-05:00"));
    }

    #[tokio::test]
    async fn all_day_events_use_only_their_own_reminders_at_midnight_in_the_users_zone() {
        let s = setup(&["a"]).await;
        let day = |id: &str| {
            json!({
                "id": id, "status": "confirmed", "summary": "Offsite", "etag": "\"1\"",
                "iCalUID": format!("{id}@google.com"), "updated": "2026-11-01T00:00:00Z",
                "start": {"date": "2026-11-12"}, "end": {"date": "2026-11-13"}
            })
        };
        s.put("a", day("defaults")).await;
        // The day before at 17:00: 7 hours before midnight.
        s.put(
            "a",
            with_reminders(
                day("own"),
                json!({"useDefault": false, "overrides": [{"method": "popup", "minutes": 420}]}),
            ),
        )
        .await;
        let plan = s
            .reminders
            .plan(ms("2026-11-11T12:00:00-05:00"))
            .await
            .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].key.event_id, "own");
        assert_eq!(plan[0].fire_at_ms, ms("2026-11-11T17:00:00-05:00"));
        s.tick("2026-11-11T17:00:00-05:00").await;
        assert_eq!(s.alerts.take()[0].1, "Tomorrow");
    }

    #[tokio::test]
    async fn the_same_invite_on_two_accounts_reminds_once() {
        let s = setup(&["a", "b"]).await;
        let mut on_b = review();
        on_b["id"] = json!("review-b");
        on_b["iCalUID"] = json!("review@google.com");
        s.put("a", review()).await;
        s.put("b", on_b).await;
        s.tick("2026-11-11T13:50:00-05:00").await;
        assert_eq!(s.alerts.take().len(), 1);
        let fired = db::reminders::fired(s.pool()).await.unwrap();
        assert_eq!(fired.len(), 2);
    }

    #[tokio::test]
    async fn quiet_hours_and_the_setting_drop_reminders_without_saving_them() {
        let s = setup(&["a"]).await;
        db::settings::set_notify_schedule(
            s.pool(),
            &NotifySchedule {
                mode: ScheduleMode::WorkHours,
                start_hour: 9,
                end_hour: 13,
                weekdays_only: true,
            },
        )
        .await
        .unwrap();
        s.put("a", review()).await;
        s.tick("2026-11-11T13:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());
        // Quiet hours end at 14:00; the dropped reminder doesn't come back then.
        db::settings::set_notify_schedule(s.pool(), &NotifySchedule::default())
            .await
            .unwrap();
        s.tick("2026-11-11T13:54:00-05:00").await;
        assert!(s.alerts.take().is_empty());

        s.put(
            "a",
            timed(
                "next",
                "Next",
                "2026-11-11T16:00:00-05:00",
                "2026-11-11T17:00:00-05:00",
            ),
        )
        .await;
        db::settings::set_calendar_reminders(s.pool(), false)
            .await
            .unwrap();
        s.tick("2026-11-11T15:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());

        db::settings::set_calendar_reminders(s.pool(), true)
            .await
            .unwrap();
        s.alerts.denied.store(true, Ordering::Relaxed);
        s.put(
            "a",
            timed(
                "blocked",
                "Blocked",
                "2026-11-11T18:00:00-05:00",
                "2026-11-11T19:00:00-05:00",
            ),
        )
        .await;
        s.tick("2026-11-11T17:50:00-05:00").await;
        assert!(s.alerts.take().is_empty());
    }

    #[tokio::test]
    async fn accounts_without_calendar_access_dont_remind() {
        let s = setup(&["a"]).await;
        s.put("a", review()).await;
        db::calendar::set_access(s.pool(), "a", "missing_scope", None, 0)
            .await
            .unwrap();
        assert!(s
            .reminders
            .plan(ms("2026-11-11T13:00:00-05:00"))
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reminder_text_is_bounded_and_plain() {
        assert_eq!(clean("Hi\u{1b}[31m\nthere", 9), "Hi [31m t");
        let r = |start: &str| Reminder {
            key: ReminderKey {
                account_id: "a".into(),
                calendar_id: "c".into(),
                event_id: "e".into(),
                start_ms: ms(start),
                minutes: 0,
            },
            fire_at_ms: 0,
            summary: Some("  ".into()),
            location: None,
            start_date: None,
            zone: NY,
            also: vec![],
        };
        let now = ms("2026-11-11T12:00:00-05:00");
        assert_eq!(when(&r("2026-11-11T13:00:00-05:00"), now), "In 1 hour");
        assert_eq!(
            when(&r("2026-11-11T13:31:00-05:00"), now),
            "In 1 hour 31 minutes"
        );
        assert_eq!(when(&r("2026-11-11T12:01:00-05:00"), now), "In 1 minute");
        assert_eq!(when(&r("2026-11-11T11:58:00-05:00"), now), "Now");
        assert_eq!(
            alert(&r("2026-11-11T13:00:00-05:00"), now).title,
            "(No title)"
        );
    }
}
