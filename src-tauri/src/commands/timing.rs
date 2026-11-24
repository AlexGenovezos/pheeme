//! One log line per Calendar or Tasks command, saying how long it took and how much of that
//! was Google's: the requests (`google_ms`), retries and their backoff, the request slots and
//! quota, the access token, and what's left (`local_ms`: the cache, locks, Pheeme itself).
//! Writes are always logged; reads only when slow or failed. No titles, ids or addresses.

use super::CommandError;
use crate::diagnostics::clip;
use crate::gmail::probe::{with_probe, ProbeStats, RequestProbe};
use std::future::Future;
use std::time::{Duration, Instant};

/// A read slower than this is logged.
const SLOW_READ: Duration = Duration::from_secs(1);

/// What a command does, which sets when it's logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Changes something (on Google or in the cache): always logged.
    Write,
    /// Answers something: logged when slow or failed.
    Read,
}

/// The command being timed.
#[derive(Debug, Clone)]
pub struct Call {
    /// `calendar` or `tasks`.
    area: &'static str,
    /// The command's name.
    op: &'static str,
    kind: Kind,
    account: Option<String>,
    /// `key=value` pairs that say what kind of change it was (`scope=following`), never what
    /// it changed.
    detail: Vec<String>,
}

impl Call {
    pub fn write(area: &'static str, op: &'static str) -> Self {
        Self::new(area, op, Kind::Write)
    }

    pub fn read(area: &'static str, op: &'static str) -> Self {
        Self::new(area, op, Kind::Read)
    }

    fn new(area: &'static str, op: &'static str, kind: Kind) -> Self {
        Self {
            area,
            op,
            kind,
            account: None,
            detail: Vec::new(),
        }
    }

    pub fn account(mut self, account_id: &str) -> Self {
        self.account = Some(account_id.to_owned());
        self
    }

    /// Adds `key=value` (a value's `Debug`, without quotes, so enums read `following`).
    pub fn with(mut self, key: &str, value: impl std::fmt::Debug) -> Self {
        let value = format!("{value:?}");
        self.detail
            .push(format!("{key}={}", value.trim_matches('"').to_lowercase()));
        self
    }

    /// Runs `f` with its Google requests counted, then logs how it went.
    pub async fn run<T, F>(self, f: F) -> Result<T, CommandError>
    where
        F: Future<Output = Result<T, CommandError>>,
    {
        let probe = RequestProbe::passive();
        let started = Instant::now();
        let result = with_probe(probe.clone(), f).await;
        self.log(started.elapsed(), &probe.snapshot(), result.as_ref().err());
        result
    }

    fn log(&self, elapsed: Duration, google: &ProbeStats, error: Option<&CommandError>) {
        let Some(level) = level(self.kind, elapsed, error.is_some()) else {
            return;
        };
        let elapsed_ms = elapsed.as_millis() as u64;
        let detail = self.detail.join(",");
        let outcome = error.map_or("ok", |e| e.code.as_str());
        let error = error.map(|e| clip(&e.message, 300));
        let kind = match self.kind {
            Kind::Write => "write",
            Kind::Read => "read",
        };
        macro_rules! log_call {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    op = %self.op,
                    account = ?self.account,
                    %detail,
                    %outcome,
                    error = ?error,
                    elapsed_ms,
                    google_ms = google.gmail_ms,
                    local_ms = local_ms(elapsed_ms, google),
                    requests = google.requests,
                    retries = google.retries,
                    backoff_ms = google.backoff_ms,
                    slot_wait_ms = google.slot_wait_ms,
                    quota_wait_ms = google.quota_wait_ms,
                    token_ms = google.token_ms,
                    last_status = ?google.last_status,
                    last_reason = ?google.last_reason,
                    "{} {}",
                    self.area,
                    kind
                )
            };
        }
        match level {
            tracing::Level::WARN => log_call!(tracing::Level::WARN),
            _ => log_call!(tracing::Level::INFO),
        }
    }
}

/// The level a command's line is written at, or `None` when it isn't worth a line.
fn level(kind: Kind, elapsed: Duration, failed: bool) -> Option<tracing::Level> {
    if failed {
        Some(tracing::Level::WARN)
    } else if kind == Kind::Write || elapsed >= SLOW_READ {
        Some(tracing::Level::INFO)
    } else {
        None
    }
}

/// The time that wasn't Google's or spent waiting for it. Requests running side by side make
/// the Google figures add up to more than the elapsed time, so this is then 0.
fn local_ms(elapsed_ms: u64, google: &ProbeStats) -> u64 {
    let google_side = google.gmail_ms
        + google.backoff_ms
        + google.slot_wait_ms
        + google.quota_wait_ms
        + google.token_ms;
    elapsed_ms.saturating_sub(google_side)
}

/// A calendar change as the window saw it (`src/calendar/writeTiming.ts`): from the user's
/// last answer (Save, Delete, the drop) to Google's confirmation reaching the window
/// (`write_ms`, so the backend's own line plus the IPC), then to the calendar redrawn with
/// it (`redraw_ms`). No titles or ids.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarWriteShown {
    /// `create`, `update`, `move`, `delete`, `copy` or `undo_create`.
    pub op: String,
    /// For a repeating event: `this`, `following` or `all`.
    pub scope: Option<String>,
    /// `shown`, `failed` or `conflict`.
    pub outcome: String,
    pub write_ms: u64,
    /// `None` when the write failed, so nothing was redrawn.
    pub redraw_ms: Option<u64>,
    pub total_ms: u64,
}

impl CalendarWriteShown {
    pub fn log(&self) {
        let failed = self.outcome != "shown";
        macro_rules! log_shown {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    op = %clip(&self.op, 16),
                    scope = ?self.scope.as_deref().map(|s| clip(s, 16)),
                    outcome = %clip(&self.outcome, 16),
                    write_ms = self.write_ms,
                    redraw_ms = ?self.redraw_ms,
                    total_ms = self.total_ms,
                    "calendar write shown"
                )
            };
        }
        if failed {
            log_shown!(tracing::Level::WARN);
        } else {
            log_shown!(tracing::Level::INFO);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn writes_always_log_and_reads_only_when_slow_or_failed() {
        let fast = Duration::from_millis(20);
        assert_eq!(level(Kind::Write, fast, false), Some(tracing::Level::INFO));
        assert_eq!(level(Kind::Read, fast, false), None);
        assert_eq!(
            level(Kind::Read, SLOW_READ, false),
            Some(tracing::Level::INFO)
        );
        assert_eq!(level(Kind::Read, fast, true), Some(tracing::Level::WARN));
        assert_eq!(level(Kind::Write, fast, true), Some(tracing::Level::WARN));
    }

    #[test]
    fn local_time_is_what_google_and_its_waits_dont_cover() {
        let google = ProbeStats {
            gmail_ms: 4_000,
            backoff_ms: 1_000,
            slot_wait_ms: 200,
            quota_wait_ms: 100,
            token_ms: 300,
            ..ProbeStats::default()
        };
        assert_eq!(local_ms(6_000, &google), 400);
        // Requests side by side: Google's figures can pass the elapsed time.
        assert_eq!(local_ms(3_000, &google), 0);
    }

    #[test]
    fn detail_reads_as_plain_words() {
        #[derive(Debug)]
        enum Scope {
            Following,
        }
        let call = Call::write("calendar", "delete_calendar_event")
            .with("scope", Scope::Following)
            .with("send_updates", "all");
        assert_eq!(call.detail, ["scope=following", "send_updates=all"]);
    }

    #[tokio::test]
    async fn run_passes_the_result_through() {
        let ok = Call::read("calendar", "x").run(async { Ok(7) }).await;
        assert_eq!(ok, Ok(7));
        let failed: Result<(), _> = Call::write("calendar", "x")
            .run(async {
                Err(CommandError {
                    code: "conflict".into(),
                    message: "changed elsewhere".into(),
                })
            })
            .await;
        assert_eq!(failed.unwrap_err().code, "conflict");
    }

    /// The log lines written while `f` runs.
    pub(crate) async fn logged<F: Future>(f: F) -> String {
        use std::sync::{Arc, Mutex};
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || Writer(sink.clone()))
            .finish();
        let _default = tracing::subscriber::set_default(subscriber);
        f.await;
        let bytes = out.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    struct Writer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Writer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_write_logs_googles_share_of_its_time() {
        use crate::gmail::probe::{current, RetryReason};
        let lines = logged(
            Call::write("calendar", "delete_calendar_event")
                .account("acct")
                .with("scope", "following")
                .with("send_updates", "all")
                .run(async {
                    // What `GmailClient::execute` reports for a slow, retried request.
                    let probe = current().expect("the call puts a probe in scope");
                    probe.token_wait(Duration::from_millis(30));
                    probe.sent(Duration::from_millis(4_000));
                    probe.retrying(0, Duration::from_millis(500), RetryReason::Network);
                    probe.sent(Duration::from_millis(1_200));
                    Ok(())
                }),
        )
        .await;
        for want in [
            "calendar write op=delete_calendar_event",
            "account=Some(\"acct\")",
            "detail=scope=following,send_updates=all",
            "outcome=ok",
            "google_ms=5200",
            "requests=2",
            "retries=1",
            "backoff_ms=500",
            "token_ms=30",
        ] {
            assert!(lines.contains(want), "{want} missing from {lines}");
        }
    }

    #[tokio::test]
    async fn a_fast_read_logs_nothing_and_a_failed_one_warns() {
        let quiet = logged(Call::read("calendar", "calendar_events").run(async { Ok(()) })).await;
        assert_eq!(quiet, "");
        let failed = logged(Call::read("calendar", "calendar_availability").run(async {
            Err::<(), _>(CommandError {
                code: "missing_scope".into(),
                message: "Allow free/busy first.".into(),
            })
        }))
        .await;
        assert!(failed.contains("WARN"), "{failed}");
        assert!(
            failed.contains("calendar read op=calendar_availability"),
            "{failed}"
        );
        assert!(failed.contains("outcome=missing_scope"), "{failed}");
    }
}
