//! Local diagnostics survive normal desktop launches, where stdout is discarded.

use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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

/// The most recent [`OPEN_TIMINGS`] opens, oldest first.
#[derive(Debug, Default)]
pub struct OpenTimings(Mutex<VecDeque<OpenTiming>>);

pub const OPEN_TIMINGS: usize = 50;

impl OpenTimings {
    pub fn record(&self, timing: OpenTiming) {
        let mut timings = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if timings.len() == OPEN_TIMINGS {
            timings.pop_front();
        }
        timings.push_back(timing);
    }

    pub fn recent(&self) -> Vec<OpenTiming> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

/// Warn when the async runtime falls behind: a tick that should come every 100 ms arriving
/// late means its worker threads were busy (blocking work on the runtime), so every command
/// and query result waited too. A machine that slept shows up as one long stall.
pub fn watch_runtime_stalls() {
    const TICK: Duration = Duration::from_millis(100);
    const STALL: Duration = Duration::from_millis(250);
    tauri::async_runtime::spawn(async {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        let mut last = Instant::now();
        loop {
            tick.tick().await;
            let lag = last.elapsed().saturating_sub(TICK);
            if lag >= STALL {
                tracing::warn!(lag_ms = lag.as_millis() as u64, "async runtime stalled");
            }
            last = Instant::now();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
