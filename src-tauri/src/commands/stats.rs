//! Settings › Mail stats commands: thin adapters over [`crate::stats`] and
//! [`crate::senders::unsubscribe`].

use super::CommandError;
use crate::db::accounts;
use crate::gmail::user_action;
use crate::mail::MailError;
use crate::senders::Unsubscribed;
use crate::stats::{MailStats, StatsAccount};
use crate::AppState;
use tauri::State;

/// Mail received since `since_ms` by one account, or every account when `account_id` is
/// `None` (local, no Gmail call).
#[tauri::command]
pub async fn mail_stats(
    state: State<'_, AppState>,
    account_id: Option<String>,
    since_ms: i64,
) -> Result<MailStats, CommandError> {
    let all = accounts::list_accounts(&state.db)
        .await
        .map_err(MailError::from)?;
    let chosen: Vec<StatsAccount> = all
        .iter()
        .filter(|a| account_id.as_deref().is_none_or(|id| id == a.id))
        .map(|a| StatsAccount {
            id: &a.id,
            email: &a.email,
        })
        .collect();
    Ok(crate::stats::mail_stats(&state.db, &chosen, since_ms).await?)
}

/// Unsubscribe from the list `message_id` (in `thread_id`) came from: one-click links are
/// followed; any other way comes back for the page to open. Loading its headers may call Gmail.
#[tauri::command]
pub async fn unsubscribe_sender(
    state: State<'_, AppState>,
    account_id: String,
    thread_id: String,
    message_id: Option<String>,
) -> Result<Unsubscribed, CommandError> {
    let account = accounts::get_account(&state.db, &account_id)
        .await
        .map_err(MailError::from)?
        .ok_or(MailError::NotFound)?;
    Ok(user_action(crate::senders::unsubscribe(
        &state.mail,
        &account.id,
        &account.email,
        &thread_id,
        message_id.as_deref(),
    ))
    .await?)
}
