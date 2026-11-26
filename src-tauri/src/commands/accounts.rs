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
    state.google_clients.forget(&account_id);
    state.sync.forget(&account_id);
    state.contacts.forget(&account_id);
    state.mail.forget_account(&account_id).await;
    crate::desktop::refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_account_color(
    state: State<'_, AppState>,
    account_id: String,
    color: i64,
) -> Result<(), CommandError> {
    Ok(state.accounts.set_account_color(&account_id, color).await?)
}

#[tauri::command]
pub async fn reorder_accounts(
    app: AppHandle,
    state: State<'_, AppState>,
    account_ids: Vec<String>,
) -> Result<(), CommandError> {
    state.accounts.reorder_accounts(&account_ids).await?;
    crate::desktop::refresh(&app);
    Ok(())
}
