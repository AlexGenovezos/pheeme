//! Sign-in commands: thin adapters over [`crate::accounts::AccountService`].

use super::CommandError;
use crate::accounts::{AccountInfo, ClientChoice, SignInStart};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn begin_oauth(
    state: State<'_, AppState>,
    client: ClientChoice,
) -> Result<SignInStart, CommandError> {
    Ok(state.accounts.begin_sign_in(client).await?)
}

/// Resolves once the browser sign-in finishes (or fails, times out or is cancelled).
#[tauri::command]
pub async fn complete_oauth(
    state: State<'_, AppState>,
    flow_id: String,
) -> Result<AccountInfo, CommandError> {
    let account = state.accounts.complete_sign_in(&flow_id).await?;
    state.sync.trigger(Some(account.id.clone()));
    // Allowing calendar access is a sign-in too: find out at once whether it now has it.
    state.calendar.trigger(Some(account.id.clone()));
    // Signing in again is how an account allows contacts: pick them up straight away.
    let contacts = state.contacts.clone();
    let account_id = account.id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = contacts.refresh_google(&account_id).await {
            tracing::warn!(error = %e, "Google Contacts refresh after sign-in failed");
        }
    });
    Ok(account)
}

#[tauri::command]
pub fn cancel_oauth(state: State<'_, AppState>, flow_id: String) {
    state.accounts.cancel_sign_in(&flow_id);
}

#[tauri::command]
pub async fn refresh_token(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<(), CommandError> {
    state.accounts.refresh_access_token(&account_id).await?;
    Ok(())
}
