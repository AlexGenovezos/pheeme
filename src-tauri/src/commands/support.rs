//! Send diagnostics: thin adapters over [`crate::support`].

use super::CommandError;
use crate::diagnostics::ShownTiming;
use crate::support::{self, Sources};
use crate::AppState;
use tauri::State;

async fn prepare(
    state: &AppState,
    note: &str,
    reply_to: Option<&str>,
) -> Result<(support::upload::UploadMeta, Vec<u8>), CommandError> {
    let accounts = state.accounts.list_accounts().await?;
    let sources = Sources {
        db: &state.db,
        accounts: &accounts,
        quota_per_minute: state.gmail_quota.get(),
        opens: state.mail.recent_opens(),
        shown: state.mail.recent_shown(),
        log_dir: state.log_dir.clone(),
    };
    Ok(support::prepare(sources, note, reply_to).await?)
}

/// Uploads a scrubbed diagnostics bundle to the developer.
#[tauri::command]
pub async fn send_diagnostics(
    state: State<'_, AppState>,
    note: String,
    reply_to: Option<String>,
) -> Result<(), CommandError> {
    let (meta, zip) = prepare(&state, &note, reply_to.as_deref()).await?;
    support::upload::send(&support::diagnostics_url(), &meta, zip).await?;
    tracing::info!("diagnostics sent");
    Ok(())
}

/// Writes the same bundle to `path` (chosen in the save dialog).
#[tauri::command]
pub async fn save_diagnostics(
    state: State<'_, AppState>,
    note: String,
    reply_to: Option<String>,
    path: String,
) -> Result<(), CommandError> {
    let path = support::save_path(&path)?;
    let (_, zip) = prepare(&state, &note, reply_to.as_deref()).await?;
    tokio::fs::write(&path, zip)
        .await
        .map_err(support::SupportError::from)?;
    Ok(())
}

/// How long a picked conversation took to show in the window (`src/mail/openTiming.ts`).
#[tauri::command]
pub fn log_thread_shown(state: State<'_, AppState>, timing: ShownTiming) {
    state.mail.record_shown(timing);
}
