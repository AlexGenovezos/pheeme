//! Compose commands: thin adapters over [`crate::compose::ComposeService`].

use super::CommandError;
use crate::compose::signatures::SignatureSettings;
use crate::compose::{
    ComposeDraft, ComposeMode, DraftSummary, QueuedSend, SavedDraft, SendAsAddress,
    StagedAttachment,
};
use crate::gmail::user_action;
use crate::sync::outbox::{FailedSend, ReturnedDraft};
use crate::AppState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, State};

/// Asks the window to save every compose panel with unsaved text, before the app quits.
pub const SAVE_BEFORE_EXIT_EVENT: &str = "compose:save_before_exit";
/// The window's answer: `true` when nothing is left unsaved, `false` when a save failed.
pub const SAVED_BEFORE_EXIT_EVENT: &str = "compose:saved_before_exit";
/// How long quitting waits for that answer. Past it the app quits anyway.
const EXIT_WAIT: Duration = Duration::from_secs(10);
/// After a save failed and the app stayed open, how long a second Quit goes straight through.
const EXIT_PASS: Duration = Duration::from_secs(30);

const EXIT_IDLE: u8 = 0;
const EXIT_ASKING: u8 = 1;
const EXIT_ALLOWED: u8 = 2;
static EXIT_STATE: AtomicU8 = AtomicU8::new(EXIT_IDLE);

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

fn exit_step(state: &AtomicU8, code: Option<i32>, has_window: bool) -> ExitStep {
    // No code means the last window closed, and without the window no panel is left to save.
    if code.is_none() || !has_window {
        return ExitStep::Proceed;
    }
    match state.compare_exchange(EXIT_IDLE, EXIT_ASKING, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => ExitStep::Ask,
        Err(EXIT_ASKING) => ExitStep::Wait,
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
        EXIT_STATE.store(EXIT_ALLOWED, Ordering::SeqCst);
        if saved {
            app.exit(code);
            return;
        }
        tracing::info!("not quitting: a draft couldn't be saved");
        tokio::time::sleep(EXIT_PASS).await;
        EXIT_STATE.store(EXIT_IDLE, Ordering::SeqCst);
    });
}

/// Reply, Reply All or Forward of a message, prefilled.
#[tauri::command]
pub async fn compose_template(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    mode: ComposeMode,
) -> Result<ComposeDraft, CommandError> {
    Ok(user_action(state.compose.template(&account_id, &message_id, mode)).await?)
}

/// The account's signature as set in Gmail (HTML), or `None` when it has none.
#[tauri::command]
pub async fn gmail_signature(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Option<String>, CommandError> {
    Ok(user_action(state.compose.gmail_signature(&account_id)).await?)
}

/// The account's signature choices, or `null` if Settings never saved any (local).
#[tauri::command]
pub async fn signature_settings(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Option<SignatureSettings>, CommandError> {
    Ok(state.compose.signature_settings(&account_id).await?)
}

/// Save the account's signature choices (local).
#[tauri::command]
pub async fn set_signature_settings(
    state: State<'_, AppState>,
    account_id: String,
    settings: SignatureSettings,
) -> Result<(), CommandError> {
    Ok(state
        .compose
        .set_signature_settings(&account_id, &settings)
        .await?)
}

/// The addresses the account can send from (Gmail's "Send mail as"), its own first.
#[tauri::command]
pub async fn send_as_addresses(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<SendAsAddress>, CommandError> {
    Ok(user_action(state.compose.send_as_addresses(&account_id)).await?)
}

/// Attach a file the user picked or dropped.
#[tauri::command]
pub async fn stage_attachment(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<StagedAttachment, CommandError> {
    Ok(state.compose.stage_file(&path).await?)
}

#[tauri::command]
pub async fn discard_attachments(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), CommandError> {
    state.compose.discard_attachments(&ids).await;
    Ok(())
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    account_id: String,
    message: ComposeDraft,
) -> Result<SavedDraft, CommandError> {
    Ok(user_action(state.compose.save_draft(&account_id, &message)).await?)
}

#[tauri::command]
pub async fn get_drafts(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<DraftSummary>, CommandError> {
    Ok(user_action(state.compose.list_drafts(&account_id)).await?)
}

/// The draft behind a message in Drafts, for editing.
#[tauri::command]
pub async fn open_draft(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
) -> Result<ComposeDraft, CommandError> {
    Ok(user_action(state.compose.open_draft(&account_id, &message_id)).await?)
}

#[tauri::command]
pub async fn delete_draft(
    state: State<'_, AppState>,
    account_id: String,
    draft_id: String,
) -> Result<(), CommandError> {
    Ok(user_action(state.compose.delete_draft(&account_id, &draft_id)).await?)
}

/// Queue a message; it leaves after `undo_ms` unless `cancel_send` comes first.
#[tauri::command]
pub async fn send_email(
    state: State<'_, AppState>,
    account_id: String,
    message: ComposeDraft,
    undo_ms: Option<u64>,
) -> Result<QueuedSend, CommandError> {
    Ok(user_action(
        state
            .compose
            .send(&account_id, &message, undo_ms.unwrap_or(0)),
    )
    .await?)
}

/// Undo send: true if it was stopped before leaving.
#[tauri::command]
pub async fn cancel_send(state: State<'_, AppState>, op_id: String) -> Result<bool, CommandError> {
    Ok(state.compose.cancel_send(&op_id).await?)
}

/// The account's sends that Gmail refused or never confirmed and are still in the outbox,
/// oldest first: after a restart no panel remembers them, so the window lists them at launch.
#[tauri::command]
pub async fn failed_sends(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<FailedSend>, CommandError> {
    Ok(state.compose.failed_sends(&account_id).await?)
}

/// Put a failed or unconfirmed send back in the account's Drafts, out of the outbox, for the
/// window to open in a panel (by the returned message id). `None` when it went meanwhile.
#[tauri::command]
pub async fn reopen_failed_send(
    state: State<'_, AppState>,
    account_id: String,
    op_id: String,
) -> Result<Option<ReturnedDraft>, CommandError> {
    Ok(user_action(state.compose.reopen_failed_send(&account_id, &op_id)).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_the_window_to_save_once_then_goes_through() {
        let state = AtomicU8::new(EXIT_IDLE);
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Ask);
        // Quit again while the window is still saving: held, not asked twice.
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Wait);
        // Answered (or timed out): the exit that follows isn't held again.
        state.store(EXIT_ALLOWED, Ordering::SeqCst);
        assert_eq!(exit_step(&state, Some(0), true), ExitStep::Proceed);
    }

    #[test]
    fn an_exit_with_no_window_left_is_never_held() {
        let state = AtomicU8::new(EXIT_IDLE);
        assert_eq!(exit_step(&state, None, true), ExitStep::Proceed);
        assert_eq!(exit_step(&state, Some(0), false), ExitStep::Proceed);
        assert_eq!(state.load(Ordering::SeqCst), EXIT_IDLE);
    }

    #[test]
    fn only_an_explicit_false_keeps_the_app_open() {
        assert!(!drafts_saved("false"));
        assert!(drafts_saved("true"));
        assert!(drafts_saved("null"));
    }
}
