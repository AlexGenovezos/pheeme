//! One clock for the background checks (mail, calendar, tasks), so they wake the computer
//! together rather than each on its own schedule. Every check sleeps until the next whole
//! multiple of its period after a shared starting point, so their turns meet wherever the
//! periods' multiples do: every calendar and tasks check in the background (60 s) lands on a
//! mail check (10 s), and with Calendar mode in front (15 s) every other one does. A check
//! triggered early falls back into step at its next regular one.

use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::Instant;

/// The shared starting point: the first time any check asks.
fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// The first whole multiple of `period` after `epoch` that is later than `now`.
fn next_after(epoch: Instant, now: Instant, period: Duration) -> Instant {
    let period_ns = period.as_nanos().max(1);
    let Some(elapsed) = now.checked_duration_since(epoch) else {
        return now + period;
    };
    let periods = elapsed.as_nanos() / period_ns + 1;
    let offset = u64::try_from(periods * period_ns).unwrap_or(u64::MAX);
    epoch + Duration::from_nanos(offset)
}

/// Sleep until this check's next turn on the shared clock.
pub async fn sleep_until_next(period: Duration) {
    tokio::time::sleep_until(next_after(epoch(), Instant::now(), period)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn checks_land_on_the_same_moments() {
        let epoch = Instant::now();
        // A calendar check that took 3 s and a tasks check that took 8 s both wait for 60 s.
        assert_eq!(
            next_after(epoch, epoch + secs(3), secs(60)),
            epoch + secs(60)
        );
        assert_eq!(
            next_after(epoch, epoch + secs(8), secs(60)),
            epoch + secs(60)
        );
        // Mail's 10 s turn at 60 s is the same moment.
        assert_eq!(
            next_after(epoch, epoch + secs(51), secs(10)),
            epoch + secs(60)
        );
        // The 15 s foreground turn lines up with the minute too.
        assert_eq!(
            next_after(epoch, epoch + secs(46), secs(15)),
            epoch + secs(60)
        );
    }

    #[test]
    fn a_check_exactly_on_its_turn_waits_for_the_next_one() {
        let epoch = Instant::now();
        assert_eq!(
            next_after(epoch, epoch + secs(60), secs(60)),
            epoch + secs(120)
        );
        assert_eq!(next_after(epoch, epoch, secs(10)), epoch + secs(10));
    }

    #[test]
    fn an_early_check_falls_back_into_step() {
        let epoch = Instant::now();
        // Triggered at 61.5 s (a write, Calendar mode opening): the next regular check is 120 s.
        let now = epoch + Duration::from_millis(61_500);
        assert_eq!(next_after(epoch, now, secs(60)), epoch + secs(120));
    }

    #[test]
    fn a_clock_before_the_epoch_waits_one_period() {
        let now = Instant::now();
        let epoch = now + secs(5);
        assert_eq!(next_after(epoch, now, secs(60)), now + secs(60));
    }
}
