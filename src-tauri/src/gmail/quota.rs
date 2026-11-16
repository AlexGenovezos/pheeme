//! Pacing under Gmail's per-user quota: [`QuotaLimiter`] spaces each client's requests by the
//! quota units they cost and adapts to the limit Gmail actually enforces.

use super::client::{QuotaSetting, RATE_LIMIT_COOLDOWN};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// Paces requests by Gmail quota units, adapting to the limit Gmail actually enforces.
///
/// Each request reserves a send time on a schedule advancing `units / rate` seconds per call,
/// allowing up to [`QUOTA_BURST`] of backlog to go at once (a GCRA). A rate-limit answer halves
/// the rate and pauses the schedule; the rate then climbs back linearly, regaining the full
/// rate's worth per [`QUOTA_RECOVERY`] (so 30 s from half speed). Gmail enforces its limit per
/// minute, so a fixed rate either wastes quota or keeps tripping it, and recovering much faster
/// trips it again.
pub(super) struct QuotaLimiter {
    /// Units per second at full speed: `share` of a per-minute limit that may change.
    limit: Arc<AtomicU32>,
    share: f64,
    state: std::sync::Mutex<Pace>,
}

pub(super) struct Pace {
    /// When the schedule is next free.
    pub(super) next: Instant,
    /// When the user's schedule is next free.
    first: Instant,
    /// The rate set by the last cut, and when it took effect (may be ahead: a cooldown).
    pub(super) cut: Option<(f64, Instant)>,
}

pub(super) const QUOTA_BURST: Duration = Duration::from_secs(1);
pub(super) const QUOTA_RECOVERY: Duration = Duration::from_secs(60);

impl QuotaLimiter {
    pub(super) fn new(limit: &QuotaSetting, share: f64) -> Self {
        Self {
            limit: limit.0.clone(),
            share,
            state: std::sync::Mutex::new(Pace {
                next: Instant::now(),
                first: Instant::now(),
                cut: None,
            }),
        }
    }

    /// A fixed rate, for tests.
    pub(super) fn fixed(units_per_sec: u32) -> Self {
        let limit = Arc::new(AtomicU32::new(units_per_sec.saturating_mul(60)));
        Self::new(&QuotaSetting(limit), 1.0)
    }

    pub(super) fn max_rate(&self) -> f64 {
        (f64::from(self.limit.load(Ordering::Relaxed)) / 60.0 * self.share).max(0.1)
    }

    pub(super) fn pace(&self) -> std::sync::MutexGuard<'_, Pace> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Units per second allowed at `now`.
    pub(super) fn rate_at(&self, pace: &Pace, now: Instant) -> f64 {
        let max_rate = self.max_rate();
        match pace.cut {
            None => max_rate,
            Some((rate, at)) => {
                let regained =
                    max_rate * now.duration_since(at).as_secs_f64() / QUOTA_RECOVERY.as_secs_f64();
                (rate + regained).min(max_rate)
            }
        }
    }

    /// Wait for this request's turn to spend `units`.
    pub(super) async fn take(&self, units: u32) {
        let send_at = {
            let mut pace = self.pace();
            let now = Instant::now();
            let rate = self.rate_at(&pace, now);
            let start = pace.next.max(now);
            pace.next = start + Duration::from_secs_f64(f64::from(units) / rate);
            start.checked_sub(QUOTA_BURST).unwrap_or(now)
        };
        tokio::time::sleep_until(send_at).await;
    }

    /// [`Self::take`] for the user's requests: they wait only behind each other, at the full rate
    /// with 5 s of backlog going at once, and what they spend is booked on the shared schedule.
    pub(super) async fn take_first(&self, units: u32) {
        let send_at = {
            let mut pace = self.pace();
            let now = Instant::now();
            let spend = |rate: f64| Duration::from_secs_f64(f64::from(units) / rate);
            pace.next = pace.next.max(now) + spend(self.rate_at(&pace, now));
            let start = pace.first.max(now);
            pace.first = start + spend(self.max_rate());
            start.checked_sub(Duration::from_secs(5)).unwrap_or(now)
        };
        tokio::time::sleep_until(send_at).await;
    }

    /// Gmail said slow down: halve the rate (once per burst of rejections) and let the
    /// window drain before anything else goes.
    pub(super) fn rate_limited(&self) {
        let mut pace = self.pace();
        let now = Instant::now();
        if pace
            .cut
            .is_some_and(|(_, at)| now.duration_since(at) < QUOTA_BURST)
        {
            return;
        }
        let rate = (self.rate_at(&pace, now) / 2.0).max(self.max_rate() / 20.0);
        pace.cut = Some((rate, now));
        // `take` lets a request go `QUOTA_BURST` ahead of its slot, so push past that too:
        // otherwise the pause is used up before it starts.
        pace.next = pace.next.max(now) + 2 * QUOTA_BURST;
    }

    /// Book nothing for [`RATE_LIMIT_COOLDOWN`], then restart at a quarter of the full rate and
    /// climb back over [`QUOTA_RECOVERY`] (45 s).
    pub(super) fn cool_down(&self) {
        let until = Instant::now() + RATE_LIMIT_COOLDOWN;
        let mut pace = self.pace();
        pace.cut = Some((self.max_rate() / 4.0, until));
        pace.next = pace.next.max(until + QUOTA_BURST);
    }

    /// The time left of a [`Self::cool_down`].
    pub(super) fn cooling(&self) -> Option<Duration> {
        let (_, until) = self.pace().cut?;
        let left = until.saturating_duration_since(Instant::now());
        (!left.is_zero()).then_some(left)
    }

    #[cfg(test)]
    pub(super) fn rate(&self) -> f64 {
        self.rate_at(&self.pace(), Instant::now())
    }
}
