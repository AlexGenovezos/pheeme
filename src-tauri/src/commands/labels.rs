//! Label commands: thin adapters over [`crate::mail::MailService`].

use super::CommandError;
use crate::diagnostics::{ms_since, PoolLoad, SLOW_READ};
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
