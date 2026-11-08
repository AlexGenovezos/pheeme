//! Sender rule commands: thin adapters over [`crate::sender_rules::SenderRuleService`].
//! Gmail calls run as user actions, ahead of sync.

use super::CommandError;
use crate::gmail::user_action;
use crate::sender_rules::{InboxThreadDto, SavedRulesDto, SenderRuleDto};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_sender_rules(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<SenderRuleDto>, CommandError> {
    Ok(user_action(state.sender_rules.list_rules(&account_id)).await?)
}

/// The senders a rule would be made for, one per conversation at most (local, no Gmail call).
#[tauri::command]
pub async fn rule_senders(
    state: State<'_, AppState>,
    account_id: String,
    thread_ids: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    Ok(state
        .sender_rules
        .rule_senders(&account_id, &thread_ids)
        .await?)
}

#[tauri::command]
pub async fn save_sender_rules(
    state: State<'_, AppState>,
    account_id: String,
    senders: Vec<String>,
    category: String,
) -> Result<SavedRulesDto, CommandError> {
    Ok(user_action(
        state
            .sender_rules
            .save_rules(&account_id, &senders, &category),
    )
    .await?)
}

#[tauri::command]
pub async fn undo_sender_rules(
    state: State<'_, AppState>,
    account_id: String,
    saved: SavedRulesDto,
) -> Result<(), CommandError> {
    Ok(user_action(state.sender_rules.undo_rules(&account_id, &saved)).await?)
}

#[tauri::command]
pub async fn delete_sender_rule(
    state: State<'_, AppState>,
    account_id: String,
    rule_id: String,
) -> Result<(), CommandError> {
    Ok(user_action(state.sender_rules.delete_rule(&account_id, &rule_id)).await?)
}

/// Cached inbox conversations from `senders` not yet in `category` (local, no Gmail call).
#[tauri::command]
pub async fn inbox_threads_from(
    state: State<'_, AppState>,
    account_id: String,
    senders: Vec<String>,
    category: String,
) -> Result<Vec<InboxThreadDto>, CommandError> {
    Ok(state
        .sender_rules
        .inbox_threads_from(&account_id, &senders, &category)
        .await?)
}
