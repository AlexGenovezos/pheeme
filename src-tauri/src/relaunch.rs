//! How the process ends: restarting on macOS (after an update) without a second Dock icon, and
//! leaving without the C exit hooks while the database is still busy.
//!
//! Tauri relaunches a bundled app with `open -n` while the old process is still running, so
//! LaunchServices registers a second instance and the Dock gives it a tile of its own: the pinned
//! Pheeme loses its running dot and a second Pheeme sits among the running apps until the next
//! quit (seen after the 0.30 update). Instead, a detached shell waits for this process to end and
//! then `open`s the bundle normally, so the new process takes the pinned tile.
//!
//! SQLCipher frees its memory, locks and OpenSSL provider in an exit hook (`atexit` and a
//! module destructor). A query still running on a connection's own thread then reads freed
//! memory and the process crashes on its way out (seen on a Mac restarting into 0.34 while sync
//! held every connection). `lib.rs` closes the pool first; when that doesn't finish in time,
//! [`exit_without_exit_hooks`] ends the process with `_exit`, which runs no hooks. SQLite keeps
//! the database whole when a process ends in the middle of a write.

#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::Manager;

/// Set when the app is exiting to restart (`RunEvent::ExitRequested` with Tauri's restart code).
static RESTARTING: AtomicBool = AtomicBool::new(false);
/// The code the last exit request asked for (0 when the last window closed).
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

#[cfg(unix)]
/// How long the waiter waits for this process to end, in tenths of a second, before opening the
/// app anyway (an `open` then only brings the old one forward).
const WAIT_TENTHS: u32 = 300;

#[cfg(unix)]
/// Waits while the process `$1` lives, or LaunchServices still lists it (an `open` sent to an app
/// it thinks is running only activates it), for up to `$2` tenths of a second; then runs the rest.
const WAITER: &str = r#"pid=$1; tenths=$2; shift 2
running() { kill -0 "$pid" 2>/dev/null || [ -n "$(/usr/bin/lsappinfo find pid="$pid" 2>/dev/null)" ]; }
i=0
while running && [ "$i" -lt "$tenths" ]; do sleep 0.1; i=$((i + 1)); done
exec "$@""#;

/// Call on every `RunEvent::ExitRequested`: notes whether the exit is a restart, and its code.
pub fn note_exit_requested(code: Option<i32>) {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        RESTARTING.store(true, Ordering::Relaxed);
    } else {
        EXIT_CODE.store(code.unwrap_or(0), Ordering::Relaxed);
    }
}

/// Call last in `RunEvent::Exit` when the database didn't close in time. Does what Tauri does
/// after that event (cleanup, then the restart if one was asked for), then ends the process
/// without running exit hooks, so SQLCipher's can't pull memory from under a running query.
pub fn exit_without_exit_hooks<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> ! {
    app.cleanup_before_exit();
    let code = if RESTARTING.load(Ordering::Relaxed) {
        relaunch(app);
        0
    } else {
        EXIT_CODE.load(Ordering::Relaxed)
    };
    end_process(code)
}

/// Starts the new Pheeme for a restart: on macOS through the waiter (as [`take_over_restart`]),
/// anywhere else by running the binary again, as Tauri's restart does. The logs are already
/// shut down, so a failure here goes unrecorded; the user opens Pheeme again.
fn relaunch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(unix)]
    if let Some(open) = open_command(app) {
        if spawn_waiter(std::process::id(), WAIT_TENTHS, &open).is_ok() {
            return;
        }
    }
    if let Ok(exe) = tauri::process::current_binary(&app.env()) {
        let _ = std::process::Command::new(exe)
            .args(std::env::args_os().skip(1))
            .spawn();
    }
}

/// Ends the process at once with `code`: no exit hooks, destructors or buffered output.
fn end_process(code: i32) -> ! {
    // SAFETY: `_exit` takes no pointers and never returns.
    unsafe { libc::_exit(code) }
}

/// Call last in `RunEvent::Exit`. On macOS, when the exit is a restart, hands the relaunch to a
/// waiter and exits here, before Tauri's own `open -n` restart runs. Anywhere else, or if the
/// waiter can't start, it returns and Tauri restarts as usual.
#[cfg(unix)]
pub fn take_over_restart<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if !RESTARTING.load(Ordering::Relaxed) {
        return;
    }
    let Some(open) = open_command(app) else {
        return;
    };
    if spawn_waiter(std::process::id(), WAIT_TENTHS, &open).is_ok() {
        app.cleanup_before_exit();
        std::process::exit(0);
    }
}

#[cfg(unix)]
/// On macOS, the `open` that starts this app's bundle again with the same arguments. `None`
/// elsewhere, or when the binary isn't in a bundle (`tauri dev`).
fn open_command<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Vec<OsString>> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // The path Tauri's restart and the updater use (resolved at startup, before any update).
    let exe = tauri::process::current_binary(&app.env()).ok()?;
    let bundle = bundle_of(&exe)?;
    let mut open = vec![OsString::from("/usr/bin/open"), bundle.into_os_string()];
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if !args.is_empty() {
        open.push("--args".into());
        open.extend(args);
    }
    Some(open)
}

#[cfg(not(unix))]
pub fn take_over_restart<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

#[cfg(unix)]
/// The `.app` bundle an executable at `…/X.app/Contents/MacOS/x` belongs to.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

#[cfg(unix)]
/// Starts a shell, detached from this process, that runs `command` once `pid` has ended.
fn spawn_waiter(pid: u32, tenths: u32, command: &[OsString]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new("/bin/sh")
        .arg("-c")
        .arg(WAITER)
        .arg("sh")
        .arg(pid.to_string())
        .arg(tenths.to_string())
        .args(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group, so nothing sent to ours on the way out reaches it.
        .process_group(0)
        .spawn()
        .map(drop)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_bundle_of_an_app_executable_only() {
        let exe = Path::new("/Applications/Pheeme.app/Contents/MacOS/pheeme");
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from("/Applications/Pheeme.app"))
        );
        // `tauri dev` runs the bare binary: no bundle, so Tauri's own restart is kept.
        assert_eq!(
            bundle_of(Path::new("/code/pheeme/target/debug/pheeme")),
            None
        );
        assert_eq!(
            bundle_of(Path::new("/x/Pheeme/Contents/MacOS/pheeme")),
            None
        );
    }

    fn wait_for(path: &Path, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// A running `sleep` standing in for the old app, and a waiter on it whose `open` makes a file.
    fn wait_on_old_app(dir: &Path, tenths: u32) -> (std::process::Child, PathBuf) {
        let opened = dir.join("opened");
        let old = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let open = [OsString::from("touch"), opened.clone().into_os_string()];
        spawn_waiter(old.id(), tenths, &open).unwrap();
        (old, opened)
    }

    #[test]
    fn the_waiter_opens_only_after_the_old_process_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (mut old, opened) = wait_on_old_app(dir.path(), WAIT_TENTHS);

        assert!(
            !wait_for(&opened, Duration::from_millis(500)),
            "opened while still running"
        );
        old.kill().unwrap();
        old.wait().unwrap();
        assert!(wait_for(&opened, Duration::from_secs(5)), "never opened");
    }

    #[test]
    fn the_waiter_gives_up_waiting_after_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let (mut old, opened) = wait_on_old_app(dir.path(), 3);

        assert!(wait_for(&opened, Duration::from_secs(5)), "kept waiting");
        old.kill().unwrap();
        old.wait().unwrap();
    }
}

#[cfg(test)]
mod exit_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use std::process::Command;
    use std::time::Duration;

    /// Set in the child process `end_process_never_crashes_under_a_running_query` starts: the
    /// database file to use (the parent's temporary folder, so it's removed after the test).
    const CHILD: &str = "PHEEME_EXIT_CHILD";

    /// Keeps queries decrypting pages on the connections' own threads, then ends the process
    /// with [`super::end_process`] while they run.
    fn exit_while_queries_run(db: &std::path::Path) -> ! {
        let options = crate::storage::test_key()
            .database_options(db)
            .create_if_missing(true)
            // A tiny page cache, so every scan decrypts pages through SQLCipher.
            .pragma("cache_size", "8");
        // Kept alive to the end, so the queries are still running when the process ends.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(4)
                .connect_with(options)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE t (b BLOB); \
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) \
                 INSERT INTO t SELECT randomblob(1000) FROM n",
            )
            .execute(&pool)
            .await
            .unwrap();
            for _ in 0..4 {
                let pool = pool.clone();
                tokio::spawn(async move {
                    loop {
                        let _ = sqlx::query("SELECT sum(length(b)) FROM t")
                            .execute(&pool)
                            .await;
                    }
                });
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        });
        super::end_process(0)
    }

    /// The child side: does nothing in an ordinary test run.
    #[test]
    fn child() {
        if let Some(db) = std::env::var_os(CHILD) {
            exit_while_queries_run(std::path::Path::new(&db));
        }
    }

    /// With `std::process::exit` in its place, about one run in four died of SIGSEGV in
    /// SQLCipher's exit hook (as the Mac did restarting into 0.34).
    #[test]
    fn end_process_never_crashes_under_a_running_query() {
        let dir = tempfile::tempdir().unwrap();
        for run in 0..8 {
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "relaunch::exit_tests::child", "--quiet"])
                .env(CHILD, dir.path().join(format!("{run}.sqlite")))
                .status()
                .unwrap();
            assert!(status.success(), "the child ended with {status}");
        }
    }
}
