//! Compose commands: thin adapters over [`crate::compose::ComposeService`].

use super::CommandError;
use crate::compose::{
    ComposeDraft, ComposeMode, DraftSummary, QueuedSend, SavedDraft, StagedAttachment,
};
use crate::gmail::user_action;
use crate::AppState;
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
    Ok(state
        .compose
        .send(&account_id, &message, undo_ms.unwrap_or(0))
        .await?)
}

/// Undo send: true if it was stopped before leaving.
#[tauri::command]
pub async fn cancel_send(state: State<'_, AppState>, op_id: String) -> Result<bool, CommandError> {
    Ok(state.compose.cancel_send(&op_id).await?)
}
