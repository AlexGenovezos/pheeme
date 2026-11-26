//! Vacation responder commands: thin adapters over [`crate::vacation::VacationService`].
//! Every one calls Gmail, so they run as user actions, ahead of sync.

use super::CommandError;
use crate::gmail::user_action;
use crate::vacation::VacationDto;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_vacation_responder(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<VacationDto, CommandError> {
    Ok(user_action(state.vacation.get(&account_id)).await?)
}

#[tauri::command]
pub async fn set_vacation_responder(
    state: State<'_, AppState>,
    account_id: String,
    responder: VacationDto,
) -> Result<VacationDto, CommandError> {
    Ok(user_action(state.vacation.set(&account_id, &responder)).await?)
}

/// Gmail's End now: off, with the rest kept as Gmail has it.
#[tauri::command]
pub async fn end_vacation_responder(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<VacationDto, CommandError> {
    Ok(user_action(state.vacation.end(&account_id)).await?)
}
