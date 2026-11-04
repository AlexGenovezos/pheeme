use crate::{
    commands::CommandError,
    mods::{ModService, Prepared, Snapshot},
};
use serde_json::Value;
use std::{path::Path, sync::Arc};
use tauri::State;

fn error(message: String) -> CommandError {
    CommandError {
        code: "mod_error".into(),
        message,
    }
}

#[tauri::command]
pub async fn list_mods(service: State<'_, Arc<ModService>>) -> Result<Snapshot, CommandError> {
    Ok(service.snapshot())
}

#[tauri::command]
pub async fn prepare_mod_install(
    service: State<'_, Arc<ModService>>,
    path: String,
) -> Result<Prepared, CommandError> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.prepare(Path::new(&path)))
        .await
        .map_err(|_| error("Could not inspect mod folder".into()))?
        .map_err(error)
}

#[tauri::command]
pub async fn discard_mod_install(
    service: State<'_, Arc<ModService>>,
    ticket: String,
) -> Result<(), CommandError> {
    service.discard(&ticket).map_err(error)
}

#[tauri::command]
pub async fn install_mod(
    service: State<'_, Arc<ModService>>,
    ticket: String,
) -> Result<(), CommandError> {
    service.install(&ticket).await.map_err(error)
}

#[tauri::command]
pub async fn set_mod_enabled(
    service: State<'_, Arc<ModService>>,
    id: String,
    enabled: bool,
) -> Result<(), CommandError> {
    service.enable(&id, enabled).await.map_err(error)
}

#[tauri::command]
pub async fn remove_mod(
    service: State<'_, Arc<ModService>>,
    id: String,
    keep_preferences: bool,
) -> Result<(), CommandError> {
    service.remove(&id, keep_preferences).await.map_err(error)
}

#[tauri::command]
pub async fn mod_action(
    service: State<'_, Arc<ModService>>,
    id: String,
    action: String,
    value: Value,
) -> Result<(), CommandError> {
    service.action(&id, &action, value).map_err(error)
}

#[tauri::command]
pub async fn mod_connection_status(
    service: State<'_, Arc<ModService>>,
    id: String,
    connection: String,
) -> Result<bool, CommandError> {
    service.connection_status(&id, &connection).map_err(error)
}

#[tauri::command]
pub async fn connect_mod(
    service: State<'_, Arc<ModService>>,
    id: String,
    connection: String,
    client_id: String,
) -> Result<(), CommandError> {
    service
        .connect(&id, &connection, &client_id)
        .await
        .map_err(error)
}

#[tauri::command]
pub async fn disconnect_mod(
    service: State<'_, Arc<ModService>>,
    id: String,
    connection: String,
) -> Result<(), CommandError> {
    service.disconnect(&id, &connection).await.map_err(error)
}
