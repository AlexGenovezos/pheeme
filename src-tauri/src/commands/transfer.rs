//! Native-only credential handling: the webview sees invitations and OAuth URLs,
//! never the transferred client secret.
use super::CommandError;
use crate::accounts::{ClientChoice, SignInStart};
use crate::transfer::{TransferError, TransferOffer, TransferStatus};
use crate::AppState;
use tauri::State;
use zeroize::Zeroizing;

impl From<TransferError> for CommandError {
    fn from(error: TransferError) -> Self {
        Self {
            code: match error {
                TransferError::Invalid => "invalid_transfer",
                TransferError::Busy => "transfer_busy",
                TransferError::Expired => "transfer_expired",
                TransferError::Connection => "transfer_connection",
                TransferError::Unconfirmed => "transfer_unconfirmed",
            }
            .into(),
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub fn transfer_interfaces() -> Result<Vec<String>, CommandError> {
    Ok(crate::transfer::interfaces()?)
}

#[tauri::command]
pub async fn offer_client_transfer(
    state: State<'_, AppState>,
    account_id: String,
    address: String,
) -> Result<TransferOffer, CommandError> {
    let creds = state.accounts.client_for_transfer(&account_id).await?;
    Ok(state.transfers.offer(&address, creds).await?)
}

#[tauri::command]
pub fn client_transfer_status(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<TransferStatus, CommandError> {
    Ok(state.transfers.status(&transfer_id)?)
}

#[tauri::command]
pub fn approve_client_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), CommandError> {
    Ok(state.transfers.approve(&transfer_id)?)
}

#[tauri::command]
pub fn cancel_client_transfer(state: State<'_, AppState>, transfer_id: String) {
    state.transfers.cancel(&transfer_id);
}

/// Waits for sender approval, then starts the normal Google sign-in flow.
#[tauri::command]
pub async fn receive_client_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
    invitation: String,
) -> Result<SignInStart, CommandError> {
    let invitation = Zeroizing::new(invitation);
    let creds = state.transfers.receive(&transfer_id, &invitation).await?;
    Ok(state
        .accounts
        .begin_sign_in(ClientChoice::New {
            client_id: creds.client_id,
            client_secret: creds.client_secret,
        })
        .await?)
}
