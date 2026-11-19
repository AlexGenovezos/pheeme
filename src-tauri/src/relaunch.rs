//! Restarting on macOS (after an update) without a second Dock icon.
//!
//! Tauri relaunches a bundled app with `open -n` while the old process is still running, so
//! LaunchServices registers a second instance and the Dock gives it a tile of its own: the pinned
//! Pheeme loses its running dot and a second Pheeme sits among the running apps until the next
//! quit (seen after the 0.30 update). Instead, a detached shell waits for this process to end and
//! then `open`s the bundle normally, so the new process takes the pinned tile.

#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use tauri::Manager;

/// Set when the app is exiting to restart (`RunEvent::ExitRequested` with Tauri's restart code).
static RESTARTING: AtomicBool = AtomicBool::new(false);

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

/// Call on every `RunEvent::ExitRequested`: notes whether the exit is a restart.
pub fn note_exit_requested(code: Option<i32>) {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        RESTARTING.store(true, Ordering::Relaxed);
    }
}

/// Call last in `RunEvent::Exit`. On macOS, when the exit is a restart, hands the relaunch to a
/// waiter and exits here, before Tauri's own `open -n` restart runs. Anywhere else, or if the
/// waiter can't start, it returns and Tauri restarts as usual.
#[cfg(unix)]
pub fn take_over_restart<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if !cfg!(target_os = "macos") || !RESTARTING.load(Ordering::Relaxed) {
        return;
    }
    // The path Tauri's restart and the updater use (resolved at startup, before any update).
    let exe = tauri::process::current_binary(&app.env());
    let Some(bundle) = exe.ok().as_deref().and_then(bundle_of) else {
        return;
    };
    let mut open = vec![OsString::from("/usr/bin/open"), bundle.into_os_string()];
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if !args.is_empty() {
        open.push("--args".into());
        open.extend(args);
    }
    if spawn_waiter(std::process::id(), WAIT_TENTHS, &open).is_ok() {
        app.cleanup_before_exit();
        std::process::exit(0);
    }
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

    #[test]
    fn the_waiter_opens_only_after_the_old_process_ends() {
        let dir = tempfile::tempdir().unwrap();
        let opened = dir.path().join("opened");
        let mut old = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let open = [OsString::from("touch"), opened.clone().into_os_string()];
        spawn_waiter(old.id(), WAIT_TENTHS, &open).unwrap();

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
        let opened = dir.path().join("opened");
        let mut old = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let open = [OsString::from("touch"), opened.clone().into_os_string()];
        spawn_waiter(old.id(), 3, &open).unwrap();

        assert!(wait_for(&opened, Duration::from_secs(5)), "kept waiting");
        old.kill().unwrap();
        old.wait().unwrap();
    }
}
