pub mod commands;
pub mod crypto;
pub mod db;
pub mod gmail;
pub mod identity;
pub mod sync;

use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::Manager;
use tracing::info;

pub struct AppState {
    pub db: Arc<SqlitePool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data dir");

            info!("App data directory: {}", data_dir.display());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let pool = db::init_db(&data_dir)
                    .await
                    .expect("failed to initialize database");

                app_handle.manage(AppState { db: Arc::new(pool) });

                info!("Database ready");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
