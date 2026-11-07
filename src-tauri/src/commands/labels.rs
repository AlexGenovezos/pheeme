//! Label commands: thin adapters over [`crate::mail::MailService`] (reads) and
//! [`crate::labels::LabelService`] (create, edit, delete).

use super::CommandError;
use crate::diagnostics::{ms_since, PoolLoad, SLOW_READ};
use crate::labels::{DeletePreviewDto, LabelColorDto, LabelEdit};
use crate::mail::{CountDto, LabelCountDto, LabelDto};
use crate::AppState;
use std::time::Instant;
use tauri::State;

#[tauri::command]
pub async fn list_labels(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<LabelDto>, CommandError> {
    Ok(state.mail.list_labels(&account_id).await?)
}

/// Unread conversations in Inbox and each category tab, across accounts.
#[tauri::command]
pub async fn mailbox_counts(
    state: State<'_, AppState>,
    account_ids: Vec<String>,
) -> Result<Vec<CountDto>, CommandError> {
    let start = Instant::now();
    let pool = PoolLoad::of(&state.db);
    let result = state.mail.mailbox_counts(&account_ids).await;
    if start.elapsed() >= SLOW_READ {
        tracing::info!(elapsed_ms = ms_since(start), accounts = account_ids.len(), %pool, "slow mailbox counts");
    }
    Ok(result?)
}

/// Unread and total conversations per label of one account, counted from the local cache.
#[tauri::command]
pub async fn label_counts(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<LabelCountDto>, CommandError> {
    let start = Instant::now();
    let pool = PoolLoad::of(&state.db);
    let result = state.mail.label_counts(&account_id).await;
    if start.elapsed() >= SLOW_READ {
        tracing::info!(elapsed_ms = ms_since(start), account = %account_id, %pool, "slow label counts");
    }
    Ok(result?)
}

/// Create a user label in Gmail (`name` is the full path, e.g. `Clients/Acme`).
#[tauri::command]
pub async fn create_label(
    state: State<'_, AppState>,
    account_id: String,
    name: String,
    color: Option<LabelColorDto>,
) -> Result<LabelDto, CommandError> {
    Ok(state.labels.create_label(&account_id, &name, color).await?)
}

/// Rename, re-nest, recolour or change a label's visibility; returns every label changed.
#[tauri::command]
pub async fn update_label(
    state: State<'_, AppState>,
    account_id: String,
    label_id: String,
    edit: LabelEdit,
) -> Result<Vec<LabelDto>, CommandError> {
    Ok(state
        .labels
        .update_label(&account_id, &label_id, edit)
        .await?)
}

/// Delete a label and its sublabels in Gmail.
#[tauri::command]
pub async fn delete_label(
    state: State<'_, AppState>,
    account_id: String,
    label_id: String,
) -> Result<(), CommandError> {
    Ok(state.labels.delete_label(&account_id, &label_id).await?)
}

/// What deleting a label would take with it, for the confirmation.
#[tauri::command]
pub async fn delete_label_preview(
    state: State<'_, AppState>,
    account_id: String,
    label_id: String,
) -> Result<DeletePreviewDto, CommandError> {
    Ok(state.labels.delete_preview(&account_id, &label_id).await?)
}
