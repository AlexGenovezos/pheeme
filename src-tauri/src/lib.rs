pub mod accounts;
#[cfg(target_os = "macos")]
mod app_menu;
pub mod commands;
pub mod db;
pub mod gmail;
pub mod identity;
pub mod secrets;
pub mod sync;

use anyhow::Context;
use secrets::SecretStore;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tracing::info;

pub struct AppState {
    pub db: SqlitePool,
    pub accounts: accounts::AccountService,
}

/// Build application state: open the database in `data_dir` and apply migrations.
/// Tauri-independent so it can be tested without an app handle.
pub async fn build_state(
    data_dir: &Path,
    secrets: Arc<dyn SecretStore>,
) -> anyhow::Result<AppState> {
    let db = db::init_db(data_dir)
        .await
        .with_context(|| format!("failed to initialize database in {}", data_dir.display()))?;
    let accounts = accounts::AccountService::new(db.clone(), secrets);
    Ok(AppState { db, accounts })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu::build).on_menu_event(app_menu::on_event);

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let data_dir = app.path().app_data_dir()?;

            info!("App data directory: {}", data_dir.display());

            // Block until the database is ready so commands never run without state.
            let state = tauri::async_runtime::block_on(build_state(
                &data_dir,
                Arc::new(secrets::KeyringStore),
            ))?;
            app.manage(state);

            info!("Database ready");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_external,
            commands::auth::begin_oauth,
            commands::auth::complete_oauth,
            commands::auth::cancel_oauth,
            commands::auth::refresh_token,
            commands::accounts::list_accounts,
            commands::accounts::remove_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn build_state_creates_db_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(dir.path(), Arc::new(secrets::MemoryStore::new()))
            .await
            .unwrap();
        assert!(dir.path().join("db.sqlite").exists());
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n.0, 0);
    }
}
