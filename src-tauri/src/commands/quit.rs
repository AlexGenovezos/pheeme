//! Quitting: before the app exits, the window saves its open compose panels to Gmail Drafts.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

/// Asks the window to save every compose panel with unsaved text, before the app quits.
pub const SAVE_BEFORE_EXIT_EVENT: &str = "compose:save_before_exit";
/// The window's answer: `true` when nothing is left unsaved, `false` when a save failed.
pub const SAVED_BEFORE_EXIT_EVENT: &str = "compose:saved_before_exit";
/// How long quitting waits for that answer. Past it the app quits anyway.
const EXIT_WAIT: Duration = Duration::from_secs(10);
/// After a save failed and the app stayed open, how long a second Quit goes straight through.
const EXIT_PASS: Duration = Duration::from_secs(30);

/// Where the save-before-exit exchange stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum ExitState {
    /// Nothing asked yet.
    Idle = 0,
    /// The window was asked to save and hasn't answered.
    Asking = 1,
    /// The window answered (or the wait ran out): the next exit goes through.
    Allowed = 2,
}

impl ExitState {
    fn from_repr(value: u8) -> Self {
        match value {
            0 => Self::Idle,
            1 => Self::Asking,
            _ => Self::Allowed,
        }
    }
}

/// An [`ExitState`] shared between the exit event and the task waiting for the window.
struct ExitCell(AtomicU8);

impl ExitCell {
    const fn new(state: ExitState) -> Self {
        Self(AtomicU8::new(state as u8))
    }

    #[cfg(test)]
    fn get(&self) -> ExitState {
        ExitState::from_repr(self.0.load(Ordering::SeqCst))
    }

    fn set(&self, state: ExitState) {
        self.0.store(state as u8, Ordering::SeqCst);
    }

    /// Idle becomes asking; any other state is left alone and returned.
    fn start_asking(&self) -> Result<(), ExitState> {
        self.0
            .compare_exchange(
                ExitState::Idle as u8,
                ExitState::Asking as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map(|_| ())
            .map_err(ExitState::from_repr)
    }
}

static EXIT_STATE: ExitCell = ExitCell::new(ExitState::Idle);

/// What an exit request does, given where the save-before-exit exchange stands.
#[derive(Debug, PartialEq, Eq)]
enum ExitStep {
    /// Quit now.
    Proceed,
    /// Hold the quit and ask the window to save its drafts.
    Ask,
    /// Hold the quit: the window was already asked and hasn't answered.
    Wait,
}

fn exit_step(state: &ExitCell, code: Option<i32>, has_window: bool) -> ExitStep {
    // No code means the last window closed, and without the window no panel is left to save.
    if code.is_none() || !has_window {
        return ExitStep::Proceed;
    }
    match state.start_asking() {
        Ok(()) => ExitStep::Ask,
        Err(ExitState::Asking) => ExitStep::Wait,
        Err(_) => ExitStep::Proceed,
    }
}

/// Whether the window's answer says every draft is saved (anything but `false`).
fn drafts_saved(payload: &str) -> bool {
    payload.trim() != "false"
}

/// Called on `RunEvent::ExitRequested` (Quit, or a restart): before the app goes, the window
/// saves its open compose panels to Gmail Drafts. The quit is held until it answers, for
/// [`EXIT_WAIT`] at most, so quitting can never hang. If a draft couldn't be saved the app
/// stays open (the window says why); quitting again within [`EXIT_PASS`] goes through.
pub fn save_drafts_before_exit<R: Runtime>(
    app: &AppHandle<R>,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    // Tauri doesn't let a restart be held (`prevent_exit` is ignored for it); the updater saves
    // the panels itself before it restarts.
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return;
    }
    let has_window = app.get_webview_window("main").is_some();
    let code = match (exit_step(&EXIT_STATE, code, has_window), code) {
        (ExitStep::Proceed, _) | (_, None) => return,
        (ExitStep::Wait, _) => return api.prevent_exit(),
        (ExitStep::Ask, Some(code)) => code,
    };
    api.prevent_exit();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = Mutex::new(Some(tx));
    let listener = app.listen(SAVED_BEFORE_EXIT_EVENT, move |event| {
        if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(drafts_saved(event.payload()));
        }
    });
    let asked = app.emit(SAVE_BEFORE_EXIT_EVENT, ()).is_ok();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let saved = if asked {
            // No answer in time (or the window is gone): quit anyway.
            !matches!(tokio::time::timeout(EXIT_WAIT, rx).await, Ok(Ok(false)))
        } else {
            true
        };
        app.unlisten(listener);
        EXIT_STATE.set(ExitState::Allowed);
        if saved {
            app.exit(code);
            return;
        }
        tracing::info!("not quitting: a draft couldn't be saved");
        tokio::time::sleep(EXIT_PASS).await;
        EXIT_STATE.set(ExitState::Idle);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_the_window_to_save_once_then_goes_through() {
        let state = ExitCell::new(ExitState::Idle);
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Ask);
        // Quit again while the window is still saving: held, not asked twice.
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Wait);
        // Answered (or timed out): the exit that follows isn't held again.
        state.set(ExitState::Allowed);
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Proceed);
    }

    #[test]
    fn an_exit_with_no_window_left_is_never_held() {
        let state = ExitCell::new(ExitState::Idle);
        assert_eq!(exit_step(&state, None, true), ExitStep::Proceed);
        assert_eq!(exit_step(&state, Some(0), false), ExitStep::Proceed);
        assert_eq!(state.get(), ExitState::Idle);
    }

    #[test]
    fn only_an_explicit_false_keeps_the_app_open() {
        assert!(!drafts_saved("false"));
        assert!(drafts_saved("true"));
        assert!(drafts_saved("null"));
    }
}
