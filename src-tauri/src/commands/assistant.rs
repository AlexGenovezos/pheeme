//! Settings › MCP: thin adapters over [`crate::local_api::LocalApi`] and the MCP
//! server that serves it.

use super::CommandError;
use crate::local_api::{ActivityDto, ClientDto, NewClientDto, ACTIVITY_SHOWN};
use crate::mcp::ServerStatus;
use crate::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatusDto {
    pub enabled: bool,
    pub server: ServerStatus,
    pub clients: Vec<ClientDto>,
}

async fn status(state: &AppState) -> Result<AssistantStatusDto, CommandError> {
    let api = state.assistants.api();
    Ok(AssistantStatusDto {
        enabled: api.enabled().await?,
        server: state.assistants.status().await,
        clients: api.clients().await?,
    })
}

#[tauri::command]
pub async fn assistant_status(
    state: State<'_, AppState>,
) -> Result<AssistantStatusDto, CommandError> {
    status(&state).await
}

/// Allow or stop AI assistants; starts or stops the server to match.
#[tauri::command]
pub async fn set_assistant_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AssistantStatusDto, CommandError> {
    state.assistants.api().set_enabled(enabled).await?;
    state.assistants.apply_setting().await;
    status(&state).await
}

#[tauri::command]
pub async fn connect_assistant(
    state: State<'_, AppState>,
    name: String,
) -> Result<NewClientDto, CommandError> {
    Ok(state.assistants.api().connect_client(&name).await?)
}

#[tauri::command]
pub async fn remove_assistant(
    state: State<'_, AppState>,
    client_id: String,
) -> Result<(), CommandError> {
    Ok(state.assistants.api().remove_client(&client_id).await?)
}

#[tauri::command]
pub async fn assistant_activity(
    state: State<'_, AppState>,
) -> Result<Vec<ActivityDto>, CommandError> {
    Ok(state.assistants.api().activity(ACTIVITY_SHOWN).await?)
}

#[tauri::command]
pub async fn clear_assistant_activity(state: State<'_, AppState>) -> Result<(), CommandError> {
    Ok(state.assistants.api().clear_activity().await?)
}
