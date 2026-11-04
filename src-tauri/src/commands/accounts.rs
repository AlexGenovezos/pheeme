//! Account management commands: thin adapters over [`crate::accounts::AccountService`].

use super::CommandError;
use crate::accounts::AccountInfo;
use crate::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> Result<Vec<AccountInfo>, CommandError> {
    Ok(state.accounts.list_accounts().await?)
}

#[tauri::command]
pub async fn remove_account(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
) -> Result<(), CommandError> {
    state.accounts.remove_account(&account_id).await?;
    state.sync.forget(&account_id);
    crate::desktop::refresh(&app);
    Ok(())
}
