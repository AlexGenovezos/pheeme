//! Local diagnostics survive normal desktop launches, where stdout is discarded.

use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

const DEFAULT_FILTER: &str = "warn,pheeme_lib=info";
const RETAINED_FILES: usize = 7;
const FILE_BYTES: usize = 5 * 1024 * 1024;

pub struct LogGuard(Mutex<Option<WorkerGuard>>);

impl LogGuard {
    /// Tauri exits the process without running destructors, so flush on `RunEvent::Exit`.
    pub fn shutdown(&self) {
        let guard = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        drop(guard);
    }
}

fn file_writer(directory: &Path, max_bytes: usize) -> io::Result<(NonBlocking, WorkerGuard)> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    // Logs are local to this user, like the mail cache they diagnose.
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    std::fs::read_dir(directory)?;
    let path = directory.join("pheeme.log");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // FileRotate retries failed opens silently. Check once so initialization can fall back.
    options.open(&path)?;
    let appender = FileRotate::new(
        path,
        AppendCount::new(RETAINED_FILES - 1),
        ContentLimit::BytesSurpassed(max_bytes),
        Compression::None,
        Some(options),
    );
    Ok(tracing_appender::non_blocking(appender))
}

/// Keep the returned guard alive until shutdown: dropping it flushes the log queue.
/// A read-only/full disk must not prevent opening the mail cache; stderr remains available.
pub fn init(directory: tauri::Result<PathBuf>) -> LogGuard {
    let files = directory
        .map_err(io::Error::other)
        .and_then(|directory| file_writer(&directory, FILE_BYTES));
    let (writer, guard, error) = match files {
        Ok((writer, guard)) => (Some(writer), Some(guard), None),
        Err(error) => (None, None, Some(error)),
    };
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER)))
        .with(tracing_subscriber::fmt::layer().with_writer(io::stderr))
        .with(writer.map(|writer| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
        }))
        .init();
    if let Some(error) = error {
        tracing::warn!(%error, "persistent diagnostics unavailable; logging to stderr only");
    }
    LogGuard(Mutex::new(guard))
}

/// Reads the UI waits on that take at least this long are logged with their arguments.
pub const SLOW_READ: Duration = Duration::from_millis(100);

/// Connections in use when a request starts. All of them busy means the request queues
/// for one, which `elapsed_ms` then includes.
#[derive(Debug, Clone, Copy)]
pub struct PoolLoad {
    pub busy: u32,
    pub size: u32,
}

impl PoolLoad {
    pub fn of(pool: &sqlx::SqlitePool) -> Self {
        let size = pool.size();
        Self {
            busy: size.saturating_sub(pool.num_idle() as u32),
            size,
        }
    }
}

impl std::fmt::Display for PoolLoad {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.busy, self.size)
    }
}

/// Times one read the UI waits on, so a slow one can be logged with how busy the database
/// pool was when it started.
pub struct ReadTimer {
    start: Instant,
    pool: PoolLoad,
}

impl ReadTimer {
    pub fn start(db: &sqlx::SqlitePool) -> Self {
        Self {
            start: Instant::now(),
            pool: PoolLoad::of(db),
        }
    }

    /// The milliseconds the read took and the pool load it started under, when it took at
    /// least [`SLOW_READ`]; log them (with the read's arguments) as `elapsed_ms` and `%pool`.
    pub fn slow(&self) -> Option<(u64, PoolLoad)> {
        (self.start.elapsed() >= SLOW_READ).then(|| (ms_since(self.start), self.pool))
    }
}

/// Milliseconds since `start`, for log fields.
pub fn ms_since(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

/// How long one opened thread took and what it waited on, for the log and the diagnostics
/// bundle. No ids, subjects or addresses.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTiming {
    /// Milliseconds since the epoch.
    pub at_ms: i64,
    /// `cache` when every body was cached, `gmail` when some had to be fetched.
    pub source: &'static str,
    pub total_ms: u64,
    pub slot_wait_ms: u64,
    pub quota_wait_ms: u64,
    pub gmail_ms: u64,
    pub retries: u32,
    pub last_status: Option<u16>,
    pub last_reason: Option<String>,
    pub messages_fetched: usize,
    pub sync_busy: bool,
    /// `ok`, or the error code of the fetch that failed.
    pub outcome: String,
}

/// The most recent [`OPEN_TIMINGS`] entries, oldest first.
#[derive(Debug)]
pub struct Recent<T>(Mutex<VecDeque<T>>);

/// The most recent opened threads, as the backend timed them.
pub type OpenTimings = Recent<OpenTiming>;
/// The most recent picked conversations, as the window timed them.
pub type ShownTimings = Recent<ShownTiming>;

pub const OPEN_TIMINGS: usize = 50;

impl<T> Default for Recent<T> {
    fn default() -> Self {
        Self(Mutex::new(VecDeque::with_capacity(OPEN_TIMINGS)))
    }
}

impl<T: Clone> Recent<T> {
    pub fn record(&self, timing: T) {
        let mut timings = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if timings.len() == OPEN_TIMINGS {
            timings.pop_front();
        }
        timings.push_back(timing);
    }

    pub fn recent(&self) -> Vec<T> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

/// How a picked conversation's timing ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShownOutcome {
    /// Painted, with every image in its email bodies loaded or failed.
    #[default]
    Shown,
    /// The user picked another conversation (or closed it) first.
    Left,
    /// Still not finished after 30 seconds.
    TimedOut,
}

/// What the user waited for after picking a conversation, timed in the window (`src/mail/openTiming.ts`):
/// [`OpenTiming`] covers only `get_thread`, which a conversation already in memory never calls.
/// Milliseconds from the pick. No ids, subjects or addresses.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownTiming {
    /// Milliseconds since the epoch, stamped when the report arrives.
    #[serde(skip_deserializing)]
    pub at_ms: i64,
    pub outcome: ShownOutcome,
    /// The conversation was already in memory, so no `get_thread` ran.
    pub from_memory: bool,
    /// Until its data was in hand; `None` if it never was.
    pub data_ms: Option<u64>,
    /// Until the first frame painted with it.
    pub paint_ms: Option<u64>,
    /// Until every image settled; `None` with no images or when that never happened.
    pub images_ms: Option<u64>,
    pub images: u32,
    pub images_failed: u32,
    /// Of the failed images, those served over plain `http:`. Absent from older frontends.
    #[serde(default)]
    pub images_failed_http: u32,
    pub images_pending: u32,
    pub total_ms: u64,
}

impl ShownTiming {
    /// Write it to the log: at `info` when the user waited over a second, else `debug`.
    pub fn log(&self) {
        macro_rules! log_shown {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    outcome = ?self.outcome,
                    from_memory = self.from_memory,
                    data_ms = ?self.data_ms,
                    paint_ms = ?self.paint_ms,
                    images_ms = ?self.images_ms,
                    images = self.images,
                    images_failed = self.images_failed,
                    images_failed_http = self.images_failed_http,
                    images_pending = self.images_pending,
                    total_ms = self.total_ms,
                    "thread shown"
                )
            };
        }
        if self.total_ms > 1000 {
            log_shown!(tracing::Level::INFO);
        } else {
            log_shown!(tracing::Level::DEBUG);
        }
    }
}

/// Text from the window, cut to `max` characters, so a misbehaving window can't fill the log.
fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

/// How one attachment preview went, measured in the window (`src/mail/preview/trace.ts`). No file
/// name, contents or ids.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReport {
    /// The reader: `pdf`, `docx`, `pptx`, `xlsx`, `csv`, `image` or `text`.
    pub kind: String,
    pub bytes: Option<u64>,
    /// `shown`, `blank`, `not_drawn`, `load_failed`, `read_failed`, `render_failed` or `left`.
    pub outcome: String,
    pub load_ms: Option<u64>,
    pub read_ms: Option<u64>,
    pub shown_ms: Option<u64>,
    pub pages: Option<u32>,
    pub drawn: u32,
    pub blank: u32,
    /// The first drawn page's canvas in device pixels (`1600x2070`).
    pub canvas: Option<String>,
    /// Page 1: `drawn`, `blank`, `unknown` (its pixels couldn't be read) or `failed` to draw.
    pub first_page: Option<String>,
    pub pixel_ratio: f64,
    pub errors: u32,
    /// The first failure, `stage: Name: message`.
    pub error: Option<String>,
    pub total_ms: u64,
}

impl PreviewReport {
    /// Write it to the log: at `warn` when nothing usable showed, else `info`.
    pub fn log(&self) {
        macro_rules! log_preview {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    kind = %clip(&self.kind, 16),
                    outcome = %clip(&self.outcome, 16),
                    bytes = ?self.bytes,
                    load_ms = ?self.load_ms,
                    read_ms = ?self.read_ms,
                    shown_ms = ?self.shown_ms,
                    pages = ?self.pages,
                    drawn = self.drawn,
                    blank = self.blank,
                    canvas = ?self.canvas.as_deref().map(|c| clip(c, 24)),
                    first_page = ?self.first_page.as_deref().map(|c| clip(c, 8)),
                    pixel_ratio = self.pixel_ratio,
                    errors = self.errors,
                    error = ?self.error.as_deref().map(|e| clip(e, 600)),
                    total_ms = self.total_ms,
                    "attachment preview"
                )
            };
        }
        if matches!(self.outcome.as_str(), "shown" | "left") && self.errors == 0 {
            log_preview!(tracing::Level::INFO);
        } else {
            log_preview!(tracing::Level::WARN);
        }
    }
}

/// A problem in the window (`src/lib/windowProblems.ts`): an uncaught error or rejection, or its
/// main thread falling behind while focused. No email content.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowProblem {
    /// `error`, `rejection` or `stall`.
    pub kind: String,
    pub message: Option<String>,
    pub lag_ms: Option<u64>,
    /// Repeats folded into this report since the last one.
    pub repeats: u32,
    pub visible: bool,
    pub focused: bool,
}

impl WindowProblem {
    pub fn log(&self) {
        if self.kind == "stall" {
            tracing::warn!(
                lag_ms = ?self.lag_ms,
                visible = self.visible,
                focused = self.focused,
                "window stalled"
            );
        } else {
            tracing::warn!(
                kind = %clip(&self.kind, 16),
                repeats = self.repeats,
                visible = self.visible,
                focused = self.focused,
                // Not `message=`: the support bundle's scrubber blanks that to the end of the line.
                error = ?self.message.as_deref().map(|m| clip(m, 600)),
                "window error"
            );
        }
    }
}

/// How often the stall watch looks. A stall of 1.25 s or more always makes a tick late enough
/// to report; shorter ones only when a tick falls inside them. Once a second keeps the watch to
/// one wakeup a second, where every 100 ms cost the laptop's battery ten.
const STALL_TICK: Duration = Duration::from_secs(1);
/// Lateness worth a warning.
const STALL: Duration = Duration::from_millis(250);
/// The wall clock running ahead of the monotonic clock by more than this means the computer
/// slept: on macOS and Linux the monotonic clock stops while it sleeps.
const SLEEP_GAP: Duration = Duration::from_secs(1);
/// After a sleep, lateness isn't Pheeme's: the system wakes everything at once, and a Mac's
/// Power Nap runs apps throttled for a few seconds at a time while the screen stays off. Every
/// stall the Air logged on 2026-11-09/10 came within a minute of a wake.
const AFTER_WAKE: Duration = Duration::from_secs(60);

/// Decides which late ticks are worth a warning.
#[derive(Default)]
struct StallWatch {
    quiet_until: Option<Instant>,
}

impl StallWatch {
    /// One tick at `now`, `waited` since the last by the monotonic clock and `wall` by the wall
    /// clock (`None` when it went backwards). Returns the lag to report.
    fn tick(&mut self, now: Instant, waited: Duration, wall: Option<Duration>) -> Option<Duration> {
        if slept(waited, wall).is_some() {
            self.quiet_until = Some(now + AFTER_WAKE);
            return None;
        }
        if self.quiet_until.is_some_and(|until| now < until) {
            return None;
        }
        let lag = waited.saturating_sub(STALL_TICK);
        (lag >= STALL).then_some(lag)
    }
}

/// How long the computer slept between two ticks `waited` apart by the monotonic clock and
/// `wall` apart by the wall clock, if it did.
fn slept(waited: Duration, wall: Option<Duration>) -> Option<Duration> {
    wall.filter(|wall| *wall > waited + SLEEP_GAP)
        .map(|wall| wall - waited)
}

/// CPU time this process has used, all threads, user and system.
#[cfg(unix)]
fn cpu_time() -> Option<Duration> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `getrusage` fills the struct it's given, and reports failure by its return value.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: zeroed, then filled by the successful call above.
    let usage = unsafe { usage.assume_init() };
    let time = |t: libc::timeval| {
        Duration::from_secs(u64::try_from(t.tv_sec).unwrap_or(0))
            + Duration::from_micros(u64::try_from(t.tv_usec).unwrap_or(0))
    };
    Some(time(usage.ru_utime) + time(usage.ru_stime))
}

#[cfg(not(unix))]
fn cpu_time() -> Option<Duration> {
    None
}

/// Warn when the async runtime falls behind: a tick that should come every second arriving
/// late means every command and query result waited too. Each warning says which kind of late it
/// was: `cpu_ms` is the CPU time Pheeme used over the tick (`wall_ms`). Near zero means Pheeme
/// wasn't running at all (the system held it back: App Nap, Power Nap, a busy or hot machine);
/// close to `wall_ms` or more means its own threads were busy (blocking work on the runtime).
/// With it, whether the window was focused and visible, the displays asleep, Low Power Mode and
/// the thermal state ([`crate::presence`]). Sleeps are logged as such, and stalls within a minute
/// of waking aren't reported.
pub fn watch_runtime_stalls() {
    tauri::async_runtime::spawn(async {
        let mut tick = tokio::time::interval(STALL_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        let mut watch = StallWatch::default();
        let mut last = (Instant::now(), SystemTime::now(), cpu_time());
        loop {
            tick.tick().await;
            let now = (Instant::now(), SystemTime::now(), cpu_time());
            let waited = now.0.duration_since(last.0);
            let wall = now.1.duration_since(last.1).ok();
            if let Some(slept) = slept(waited, wall) {
                tracing::info!(slept_ms = slept.as_millis() as u64, "computer slept");
            }
            if let Some(lag) = watch.tick(now.0, waited, wall) {
                let cpu_ms = now
                    .2
                    .zip(last.2)
                    .map(|(now, then)| now.saturating_sub(then).as_millis() as u64);
                let presence = crate::presence::snapshot();
                tracing::warn!(
                    lag_ms = lag.as_millis() as u64,
                    wall_ms = waited.as_millis() as u64,
                    cpu_ms = ?cpu_ms,
                    focused = ?presence.focused,
                    visible = ?presence.visible,
                    displays_asleep = ?presence.displays_asleep,
                    low_power = ?presence.low_power,
                    thermal = ?presence.thermal,
                    "async runtime stalled"
                );
            }
            last = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn a_late_tick_is_a_stall() {
        let mut watch = StallWatch::default();
        let now = Instant::now();
        assert_eq!(watch.tick(now, ms(1_100), Some(ms(1_100))), None);
        assert_eq!(watch.tick(now, ms(1_400), Some(ms(1_400))), Some(ms(400)));
    }

    #[test]
    fn stalls_within_a_minute_of_waking_are_not_reported() {
        let mut watch = StallWatch::default();
        let woke = Instant::now();
        // A 4 s Power Nap sleep: the wall clock moved on, the monotonic clock barely did.
        assert_eq!(watch.tick(woke, ms(1_630), Some(ms(5_630))), None);
        // Throttled ticks in the seconds after the wake, as the Air logged at 16:53:51-55.
        assert_eq!(
            watch.tick(woke + ms(3_000), ms(2_434), Some(ms(2_434))),
            None
        );
        assert_eq!(
            watch.tick(woke + ms(59_000), ms(2_100), Some(ms(2_100))),
            None
        );
        // A minute on, a stall is Pheeme's again.
        assert_eq!(
            watch.tick(woke + ms(61_000), ms(2_100), Some(ms(2_100))),
            Some(ms(1_100))
        );
    }

    #[test]
    fn a_sleep_is_the_wall_clock_running_ahead() {
        assert_eq!(slept(ms(1_630), Some(ms(5_630))), Some(ms(4_000)));
        assert_eq!(slept(ms(1_400), Some(ms(1_900))), None);
        assert_eq!(slept(ms(1_400), None), None);
    }

    #[cfg(unix)]
    #[test]
    fn cpu_time_moves_forward_with_work() {
        let before = cpu_time().unwrap();
        let mut x = 0u64;
        let start = Instant::now();
        while start.elapsed() < ms(30) {
            x = std::hint::black_box(x.wrapping_add(1));
        }
        assert!(cpu_time().unwrap() > before);
    }

    #[test]
    fn a_wall_clock_set_back_is_not_a_sleep() {
        let mut watch = StallWatch::default();
        let now = Instant::now();
        assert_eq!(watch.tick(now, ms(1_500), None), Some(ms(500)));
    }

    #[test]
    fn logs_survive_shutdown_and_append_after_relaunch() {
        let directory = tempfile::tempdir().unwrap();
        let logs = directory.path().join("logs");
        for status in [403, 429] {
            let (writer, guard) = file_writer(&logs, FILE_BYTES).unwrap();
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(writer)
                .finish();
            tracing::subscriber::with_default(subscriber, || {
                tracing::warn!(status, reason = "rateLimitExceeded", "Gmail throttled");
            });
            let guard = LogGuard(Mutex::new(Some(guard)));
            guard.shutdown();
        }
        let files: Vec<_> = std::fs::read_dir(&logs).unwrap().collect();
        assert_eq!(files.len(), 1);
        let contents = std::fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        assert!(contents.contains("status=403"), "{contents}");
        assert!(contents.contains("status=429"), "{contents}");
        assert!(contents.contains("rateLimitExceeded"), "{contents}");
        assert!(!contents.contains('\u{1b}'));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(logs).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn open_timings_keep_the_newest() {
        let timings = OpenTimings::default();
        for n in 0..OPEN_TIMINGS as u64 + 5 {
            timings.record(OpenTiming {
                at_ms: 0,
                source: "cache",
                total_ms: n,
                slot_wait_ms: 0,
                quota_wait_ms: 0,
                gmail_ms: 0,
                retries: 0,
                last_status: None,
                last_reason: None,
                messages_fetched: 0,
                sync_busy: false,
                outcome: "ok".into(),
            });
        }
        let recent = timings.recent();
        assert_eq!(recent.len(), OPEN_TIMINGS);
        assert_eq!(recent[0].total_ms, 5);
        assert_eq!(recent.last().unwrap().total_ms, OPEN_TIMINGS as u64 + 4);
    }

    #[test]
    fn shown_timing_reads_what_the_window_sends() {
        let timing: ShownTiming = serde_json::from_value(serde_json::json!({
            "outcome": "timed_out",
            "fromMemory": true,
            "dataMs": 0,
            "paintMs": 412,
            "imagesMs": null,
            "images": 14,
            "imagesFailed": 2,
            "imagesFailedHttp": 1,
            "imagesPending": 3,
            "totalMs": 30000,
        }))
        .unwrap();
        assert_eq!(timing.outcome, ShownOutcome::TimedOut);
        assert!(timing.from_memory);
        assert_eq!(
            (timing.data_ms, timing.paint_ms, timing.images_ms),
            (Some(0), Some(412), None)
        );
        assert_eq!(
            (timing.images, timing.images_failed, timing.images_pending),
            (14, 2, 3)
        );
        assert_eq!(timing.images_failed_http, 1);
        assert_eq!(
            timing.at_ms, 0,
            "stamped on arrival, not taken from the window"
        );

        let older: ShownTiming = serde_json::from_value(serde_json::json!({
            "outcome": "shown", "fromMemory": false, "dataMs": 1, "paintMs": 2,
            "imagesMs": null, "images": 0, "imagesFailed": 0, "imagesPending": 0, "totalMs": 2,
        }))
        .unwrap();
        assert_eq!(
            older.images_failed_http, 0,
            "a window without the field still reports"
        );

        let unknown = serde_json::json!({
            "outcome": "exploded", "fromMemory": false, "dataMs": null, "paintMs": null,
            "imagesMs": null, "images": 0, "imagesFailed": 0, "imagesPending": 0, "totalMs": 1,
        });
        assert!(serde_json::from_value::<ShownTiming>(unknown).is_err());
    }

    #[test]
    fn shown_timings_keep_the_newest() {
        let timings = ShownTimings::default();
        for n in 0..OPEN_TIMINGS as u64 + 2 {
            timings.record(ShownTiming {
                total_ms: n,
                ..ShownTiming::default()
            });
        }
        let recent = timings.recent();
        assert_eq!(recent.len(), OPEN_TIMINGS);
        assert_eq!(recent[0].total_ms, 2);
    }

    #[test]
    fn unwritable_log_path_returns_an_error() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(file_writer(file.path(), FILE_BYTES).is_err());
    }

    #[test]
    fn rotation_caps_files_and_relaunch_preserves_all_retained_logs() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let (mut writer, guard) = file_writer(directory.path(), 16).unwrap();
        for _ in 0..24 {
            writer.write_all(b"0123456789abcdef").unwrap();
        }
        drop(guard);
        let unrelated = directory.path().join("notes.txt");
        std::fs::write(&unrelated, "keep this").unwrap();
        let snapshot = || {
            std::fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    (path.clone(), std::fs::read(path).unwrap())
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let before = snapshot();
        assert_eq!(before.len(), RETAINED_FILES + 1);
        let (_, guard) = file_writer(directory.path(), 16).unwrap();
        drop(guard);
        assert_eq!(snapshot(), before);
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "keep this");
    }

    #[test]
    fn desktop_launch_keeps_logs_when_console_is_discarded() {
        const TEST_DIRECTORY: &str = "PHEEME_DIAGNOSTICS_TEST_DIRECTORY";
        if let Some(directory) = std::env::var_os(TEST_DIRECTORY) {
            let logs = init(Ok(PathBuf::from(directory)));
            tracing::info!(
                status = 429,
                reason = "rateLimitExceeded",
                "Gmail throttled"
            );
            tracing::info!(target: "hyper", "third-party info is filtered");
            logs.shutdown();
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        for _ in 0..2 {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "diagnostics::tests::desktop_launch_keeps_logs_when_console_is_discarded",
                ])
                .env(TEST_DIRECTORY, directory.path())
                .env_remove("RUST_LOG")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        let text = std::fs::read_to_string(directory.path().join("pheeme.log")).unwrap();
        assert_eq!(text.matches("rateLimitExceeded").count(), 2, "{text}");
        assert!(!text.contains("third-party info"), "{text}");
    }
}
