//! Compose commands: thin adapters over [`crate::compose::ComposeService`].

use super::CommandError;
use crate::compose::signatures::SignatureSettings;
use crate::compose::{
    ComposeDraft, ComposeMode, DraftSummary, QueuedSend, SavedDraft, SendAsAddress,
    StagedAttachment,
};
use crate::gmail::user_action;
use crate::mail::MailError;
use crate::sync::outbox::{FailedSend, ReturnedDraft};
use crate::AppState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::path::PathBuf;
use tauri::State;

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

/// Attach a file the window holds as bytes (base64), such as an image pasted from the clipboard.
/// `inline`: the image goes in the message's text (it gets a Content-ID to be shown through).
#[tauri::command]
pub async fn stage_pasted_attachment(
    state: State<'_, AppState>,
    filename: String,
    mime_type: String,
    data: String,
    inline: Option<bool>,
) -> Result<StagedAttachment, CommandError> {
    let bytes = BASE64
        .decode(data)
        .map_err(|_| MailError::Invalid("That file couldn't be read.".into()))?;
    Ok(state
        .compose
        .stage_pasted(&filename, &mime_type, &bytes, inline.unwrap_or(false))
        .await?)
}

/// A staged file's bytes as a raw binary response, for the editor to show an inline image.
#[tauri::command]
pub async fn read_staged_attachment(
    state: State<'_, AppState>,
    id: String,
) -> Result<tauri::ipc::Response, CommandError> {
    Ok(tauri::ipc::Response::new(
        state.compose.staged_bytes(&id).await?,
    ))
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
