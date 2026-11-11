//! What spends each account's Gmail quota: the units this copy of Pheeme sent in each of the last
//! 60 minutes, split by what they were for, and how many requests Gmail refused for its rate
//! limit. In memory only (Settings › Accounts shows it); nothing is stored.
//!
//! [`GmailClient`](super::GmailClient) records every attempt that reaches Gmail (Gmail charges
//! retries too). Only the Gmail client counts: Calendar, Tasks and People have quotas of their own.
//! A request's [`UsageSource`] is the innermost [`usage_source`] scope it runs in, else follows
//! from its priority: the backfill is older mail, sync is new mail, anything the user is waiting
//! on is something they asked for.

use super::client::Priority;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Minutes kept per account.
pub const MINUTES: usize = 60;
const MINUTE_MS: u64 = 60_000;

/// What a Gmail request was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageSource {
    /// Sync of new mail and changes.
    NewMail,
    /// The backfill of older mail.
    OlderMail,
    /// The outbox sending the user's queued changes and sends.
    YourChanges,
    /// Anything else the user asked for: opening mail, searches, attachments, drafts, labels.
    YouAsked,
    /// Calls made for AI assistants through the local API.
    Assistants,
}

impl UsageSource {
    const ALL: [UsageSource; 5] = [
        UsageSource::NewMail,
        UsageSource::OlderMail,
        UsageSource::YourChanges,
        UsageSource::YouAsked,
        UsageSource::Assistants,
    ];

    fn index(self) -> usize {
        self as usize
    }

    /// The source when no [`usage_source`] scope says otherwise. `priority` is the one the
    /// request runs at (a sync call inside `user_action` is already interactive).
    fn default_for(priority: Priority) -> Self {
        match priority {
            Priority::Interactive => UsageSource::YouAsked,
            Priority::Sync => UsageSource::NewMail,
            Priority::Background => UsageSource::OlderMail,
        }
    }

    /// The source a request at `priority` counts under right now.
    pub(crate) fn current(priority: Priority) -> Self {
        SOURCE
            .try_with(|s| *s)
            .unwrap_or_else(|_| Self::default_for(priority))
    }
}

tokio::task_local! {
    static SOURCE: UsageSource;
}

/// Count every Gmail request `f` makes under `source`, whatever its priority. Scopes nest: the
/// innermost wins. A task-local, so it reaches every request `f` makes but not spawned tasks.
pub async fn usage_source<F: Future>(source: UsageSource, f: F) -> F::Output {
    SOURCE.scope(source, f).await
}

/// Milliseconds since the Unix epoch; tests swap in their own.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct Minute {
    /// Minutes since the epoch this slot holds; a slot holding another minute reads as empty.
    at: u64,
    units: [u32; UsageSource::ALL.len()],
    refused: u32,
}

/// One account's last [`MINUTES`] minutes, a ring indexed by minute.
pub struct AccountUsage {
    clock: Clock,
    ring: Mutex<[Minute; MINUTES]>,
}

impl AccountUsage {
    fn new(clock: Clock) -> Self {
        Self {
            clock,
            ring: Mutex::new([Minute::default(); MINUTES]),
        }
    }

    fn ring(&self) -> MutexGuard<'_, [Minute; MINUTES]> {
        self.ring.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The slot for the minute `now_ms` falls in, emptied if it held an older minute.
    fn slot(ring: &mut [Minute; MINUTES], now_ms: u64) -> &mut Minute {
        let at = now_ms / MINUTE_MS;
        let slot = &mut ring[(at % MINUTES as u64) as usize];
        if slot.at != at {
            *slot = Minute {
                at,
                ..Minute::default()
            };
        }
        slot
    }

    /// The time on this meter's clock (ms since the epoch).
    pub fn now_ms(&self) -> u64 {
        (self.clock)()
    }

    /// A request of `units` went to Gmail now.
    pub fn record(&self, source: UsageSource, units: u32) {
        self.record_at(self.now_ms(), source, units);
    }

    /// A request of `units` went to Gmail at `sent_ms` (the minute it was sent is the one Gmail
    /// charges, however long the answer took). A minute already past the window is dropped.
    pub fn record_at(&self, sent_ms: u64, source: UsageSource, units: u32) {
        let window_start = (self.now_ms() / MINUTE_MS).saturating_sub(MINUTES as u64 - 1);
        if sent_ms / MINUTE_MS < window_start {
            return;
        }
        let mut ring = self.ring();
        let slot = Self::slot(&mut ring, sent_ms);
        let spent = &mut slot.units[source.index()];
        *spent = spent.saturating_add(units);
    }

    /// Gmail refused a request for its rate limit.
    pub fn refused(&self) {
        let now = (self.clock)();
        let mut ring = self.ring();
        let slot = Self::slot(&mut ring, now);
        slot.refused = slot.refused.saturating_add(1);
    }

    /// The last [`MINUTES`] minutes, oldest first, the current one last; quiet minutes are zeros.
    fn minutes(&self) -> Vec<MinuteUsage> {
        let window = MINUTES as u64;
        // Always `MINUTES` entries (a clock within the epoch's first hour starts at minute 0).
        let first = ((self.clock)() / MINUTE_MS).saturating_sub(window - 1);
        let ring = self.ring();
        (first..first + window)
            .map(|at| {
                let slot = ring[(at % window) as usize];
                let held = if slot.at == at {
                    slot
                } else {
                    Minute::default()
                };
                MinuteUsage {
                    start_ms: at * MINUTE_MS,
                    units: SourceUnits::from(held.units),
                    refused: held.refused,
                }
            })
            .collect()
    }
}

/// Every account's usage, shared by their Gmail clients and the `gmail_quota_usage` command.
#[derive(Clone)]
pub struct QuotaUsage {
    clock: Clock,
    accounts: Arc<Mutex<HashMap<String, Arc<AccountUsage>>>>,
}

impl Default for QuotaUsage {
    fn default() -> Self {
        Self::with_clock(system_clock())
    }
}

impl QuotaUsage {
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            clock,
            accounts: Arc::default(),
        }
    }

    fn accounts(&self) -> MutexGuard<'_, HashMap<String, Arc<AccountUsage>>> {
        self.accounts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The account's meter, for its Gmail client (every client of one account shares it).
    pub fn account(&self, account_id: &str) -> Arc<AccountUsage> {
        self.accounts()
            .entry(account_id.to_owned())
            .or_insert_with(|| Arc::new(AccountUsage::new(self.clock.clone())))
            .clone()
    }

    /// The last hour of `account_id`'s usage against a limit of `limit_per_minute` units.
    pub fn report(&self, account_id: &str, limit_per_minute: u32) -> UsageReport {
        let minutes = match self.accounts().get(account_id) {
            Some(usage) => usage.minutes(),
            None => AccountUsage::new(self.clock.clone()).minutes(),
        };
        UsageReport {
            limit_per_minute,
            minutes,
        }
    }
}

/// What `gmail_quota_usage` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// The user's Gmail limit (Settings › Sync).
    pub limit_per_minute: u32,
    /// Exactly [`MINUTES`] minutes, oldest first, the current minute last.
    pub minutes: Vec<MinuteUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinuteUsage {
    /// When the minute began (ms since the epoch).
    pub start_ms: u64,
    pub units: SourceUnits,
    /// Requests Gmail refused for its rate limit, retried ones included.
    pub refused: u32,
}

/// Units sent in a minute, by [`UsageSource`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUnits {
    pub new_mail: u32,
    pub older_mail: u32,
    pub your_changes: u32,
    pub you_asked: u32,
    pub assistants: u32,
}

impl From<[u32; 5]> for SourceUnits {
    fn from(units: [u32; 5]) -> Self {
        let [new_mail, older_mail, your_changes, you_asked, assistants] = units;
        Self {
            new_mail,
            older_mail,
            your_changes,
            you_asked,
            assistants,
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A clock tests move by hand.
    #[derive(Clone, Default)]
    pub struct TestClock(pub Arc<AtomicU64>);

    impl TestClock {
        pub fn at(ms: u64) -> Self {
            Self(Arc::new(AtomicU64::new(ms)))
        }

        pub fn set(&self, ms: u64) {
            self.0.store(ms, Ordering::SeqCst);
        }

        pub fn clock(&self) -> Clock {
            let now = self.0.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TestClock;
    use super::*;

    /// A time on a minute boundary.
    const T0: u64 = 1_794_391_200_000;

    fn usage_at(ms: u64) -> (QuotaUsage, TestClock) {
        let clock = TestClock::at(ms);
        (QuotaUsage::with_clock(clock.clock()), clock)
    }

    #[test]
    fn report_is_sixty_zero_filled_minutes_ending_now() {
        let (usage, _) = usage_at(T0 + 25_000);
        let report = usage.report("unknown", 6_000);
        assert_eq!(report.limit_per_minute, 6_000);
        assert_eq!(report.minutes.len(), MINUTES);
        assert_eq!(report.minutes[59].start_ms, T0);
        assert_eq!(report.minutes[0].start_ms, T0 - 59 * MINUTE_MS);
        for pair in report.minutes.windows(2) {
            assert_eq!(pair[1].start_ms - pair[0].start_ms, MINUTE_MS);
        }
        assert!(report
            .minutes
            .iter()
            .all(|m| m.units == SourceUnits::default() && m.refused == 0));

        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["limitPerMinute"], 6_000);
        assert_eq!(
            json["minutes"][59],
            serde_json::json!({
                "startMs": T0,
                "units": {"newMail": 0, "olderMail": 0, "yourChanges": 0, "youAsked": 0, "assistants": 0},
                "refused": 0,
            })
        );
    }

    #[test]
    fn units_land_in_the_minute_they_were_sent_by_source() {
        let (usage, clock) = usage_at(T0);
        let meter = usage.account("a1");
        meter.record(UsageSource::NewMail, 2);
        meter.record(UsageSource::NewMail, 5);
        meter.record(UsageSource::OlderMail, 10);
        clock.set(T0 + 59_999);
        meter.record(UsageSource::YourChanges, 50);
        meter.refused();
        clock.set(T0 + 60_000);
        meter.record(UsageSource::YouAsked, 10);
        meter.record(UsageSource::Assistants, 5);
        meter.refused();
        meter.refused();

        let minutes = usage.report("a1", 6_000).minutes;
        let before = &minutes[58];
        assert_eq!(before.start_ms, T0);
        assert_eq!(
            before.units,
            SourceUnits {
                new_mail: 7,
                older_mail: 10,
                your_changes: 50,
                ..SourceUnits::default()
            }
        );
        assert_eq!(before.refused, 1);
        let now = &minutes[59];
        assert_eq!(
            now.units,
            SourceUnits {
                you_asked: 10,
                assistants: 5,
                ..SourceUnits::default()
            }
        );
        assert_eq!(now.refused, 2);
        // A slow answer counts in the minute its request was sent.
        clock.set(T0 + 2 * MINUTE_MS);
        meter.record_at(T0 + 60_500, UsageSource::YouAsked, 100);
        assert_eq!(usage.report("a1", 6_000).minutes[58].units.you_asked, 110);
        // Another account's meter is its own.
        assert!(usage
            .report("a2", 6_000)
            .minutes
            .iter()
            .all(|m| m.units == SourceUnits::default()));
        // Every client of an account shares one meter.
        assert!(Arc::ptr_eq(&meter, &usage.account("a1")));
    }

    #[test]
    fn minutes_older_than_an_hour_roll_off() {
        let (usage, clock) = usage_at(T0);
        let meter = usage.account("a1");
        meter.record(UsageSource::NewMail, 100);
        meter.refused();

        clock.set(T0 + 59 * MINUTE_MS);
        let minutes = usage.report("a1", 6_000).minutes;
        assert_eq!(minutes[0].start_ms, T0);
        assert_eq!(minutes[0].units.new_mail, 100);
        assert_eq!(minutes[0].refused, 1);

        // An hour on, that minute's slot is reused: the old counts must not leak into it.
        clock.set(T0 + 60 * MINUTE_MS);
        let minutes = usage.report("a1", 6_000).minutes;
        assert!(minutes
            .iter()
            .all(|m| m.units.new_mail == 0 && m.refused == 0));
        meter.record(UsageSource::OlderMail, 5);
        let minutes = usage.report("a1", 6_000).minutes;
        assert_eq!(minutes[59].start_ms, T0 + 60 * MINUTE_MS);
        assert_eq!(
            minutes[59].units,
            SourceUnits {
                older_mail: 5,
                ..SourceUnits::default()
            }
        );
        assert_eq!(minutes[59].refused, 0);

        // Long after (a laptop asleep for hours), everything reads as quiet.
        clock.set(T0 + 1_000 * MINUTE_MS);
        assert!(usage
            .report("a1", 6_000)
            .minutes
            .iter()
            .all(|m| m.units == SourceUnits::default() && m.refused == 0));
    }

    #[tokio::test]
    async fn source_follows_priority_unless_a_scope_names_it() {
        assert_eq!(UsageSource::current(Priority::Sync), UsageSource::NewMail);
        assert_eq!(
            UsageSource::current(Priority::Background),
            UsageSource::OlderMail
        );
        assert_eq!(
            UsageSource::current(Priority::Interactive),
            UsageSource::YouAsked
        );
        let scoped = usage_source(UsageSource::YourChanges, async {
            let outer = UsageSource::current(Priority::Background);
            let inner = usage_source(UsageSource::Assistants, async {
                UsageSource::current(Priority::Interactive)
            })
            .await;
            (outer, inner)
        })
        .await;
        assert_eq!(scoped, (UsageSource::YourChanges, UsageSource::Assistants));
    }
}
