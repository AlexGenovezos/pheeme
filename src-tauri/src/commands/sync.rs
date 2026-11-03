//! Manual refresh.

use crate::AppState;
use tauri::State;

/// Sync one account (or all) in the background; progress arrives as `sync:*` events.
#[tauri::command]
pub fn sync_now(state: State<'_, AppState>, account_id: Option<String>) {
    state.mail.sync_now(account_id);
}
