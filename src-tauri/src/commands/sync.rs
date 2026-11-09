//! Manual refresh.

use crate::AppState;
use tauri::State;

/// Sync one account (or all) in the background; progress arrives as `sync:*` events.
#[tauri::command]
pub fn sync_now(state: State<'_, AppState>, account_id: Option<String>) {
    state.mail.sync_now(account_id);
}

/// Whether Google answered the last time it was asked (`network:status` reports changes).
#[tauri::command]
pub fn network_online(state: State<'_, AppState>) -> bool {
    state.sync.online()
}

#[tauri::command]
pub async fn get_sync_progress(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::sync_state::SyncProgress>, super::CommandError> {
    crate::db::sync_state::progress(&state.db)
        .await
        .map_err(|error| super::CommandError {
            code: "internal".into(),
            message: format!("Couldn't read mail sync progress: {error}"),
        })
}
