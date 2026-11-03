pub mod accounts;
#[cfg(target_os = "macos")]
mod app_menu;
pub mod commands;
pub mod compose;
pub mod db;
pub mod gmail;
pub mod identity;
pub mod mail;
pub mod render;
pub mod secrets;
pub mod sync;

use anyhow::Context;
use secrets::SecretStore;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use sync::manager::SyncManager;
use sync::{SyncEvent, SyncEvents};
use tauri::Manager;
use tracing::info;

pub struct AppState {
    pub db: SqlitePool,
    pub accounts: Arc<accounts::AccountService>,
    pub mail: mail::MailService,
    pub compose: compose::ComposeService,
    pub sync: Arc<SyncManager>,
}

/// Build application state: open the database in `data_dir` (attachment bytes are cached
/// under `cache_dir`), apply migrations, and set up
/// sync (not started). Tauri-independent so it can be tested without an app handle; must
/// run inside a tokio runtime.
pub async fn build_state(
    data_dir: &Path,
    cache_dir: &Path,
    secrets: Arc<dyn SecretStore>,
    events: Arc<dyn SyncEvents>,
) -> anyhow::Result<AppState> {
    let db = db::init_db(data_dir)
        .await
        .with_context(|| format!("failed to initialize database in {}", data_dir.display()))?;
    let accounts = Arc::new(accounts::AccountService::new(db.clone(), secrets));
    let tokens = accounts.clone();
    let api_for: sync::manager::ApiFactory = Arc::new(move |account_id: &str| {
        let provider = Arc::new(accounts::AccountTokens::new(tokens.clone(), account_id));
        Arc::new(gmail::GmailClient::new(provider)) as Arc<dyn sync::MailApi>
    });
    let sync = SyncManager::new(db.clone(), api_for, events);
    let mail = mail::MailService::new(db.clone(), sync.clone(), cache_dir.to_path_buf());
    let compose = compose::ComposeService::new(db.clone(), sync.clone(), mail.clone(), cache_dir);
    compose.sweep_staging().await;
    Ok(AppState {
        db,
        accounts,
        mail,
        compose,
        sync,
    })
}

/// Forwards sync events to the webview.
struct TauriEvents(tauri::AppHandle);

impl SyncEvents for TauriEvents {
    fn emit(&self, event: SyncEvent) {
        use tauri::Emitter;
        if let Err(e) = self.0.emit(event.name(), &event) {
            tracing::warn!(error = %e, "couldn't emit {}", event.name());
        }
    }
}

/// Adapts a protocol answer to an HTTP response. Images are immutable per signed URL, and
/// the response carries its own lockdown in case it is ever navigated to directly. If a
/// header can't be built the answer is a bare 404, never a panic.
fn attachment_response(served: mail::InlineResponse) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        let mut response = tauri::http::Response::new(Vec::new());
        *response.status_mut() = tauri::http::StatusCode::NOT_FOUND;
        response
    };
    let mut response = tauri::http::Response::builder().status(served.status);
    if let Some(content_type) = served.content_type {
        response = response
            .header("Content-Type", content_type)
            .header("Cache-Control", "private, max-age=31536000, immutable")
            .header("X-Content-Type-Options", "nosniff")
            .header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            );
    }
    response.body(served.body).unwrap_or_else(|_| not_found())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The main window starts hidden and the frontend shows it after its first paint. If that never happens (a script
/// error, a stuck first command), show it anyway so the app is never invisible.
fn reveal_window_fallback(app: tauri::AppHandle) {
    const AFTER: std::time::Duration = std::time::Duration::from_secs(3);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AFTER).await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            tracing::warn!("frontend didn't show the window within {AFTER:?}; showing it");
            if let Err(err) = window.show() {
                tracing::warn!("couldn't show the main window: {err}");
            }
        }
    });
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_event);

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol(
            render::ATTACHMENT_SCHEME,
            |ctx, request, responder| {
                let uri = request.uri().to_string();
                let mail = ctx
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|state| state.mail.clone());
                tauri::async_runtime::spawn(async move {
                    let served = match mail {
                        Some(mail) => mail.serve_inline_image(&uri).await,
                        None => mail::InlineResponse::not_found(),
                    };
                    responder.respond(attachment_response(served));
                });
            },
        )
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;

            info!("App data directory: {}", data_dir.display());

            // Block until the database is ready so commands never run without state.
            let events = Arc::new(TauriEvents(app.handle().clone()));
            let state = tauri::async_runtime::block_on(build_state(
                &data_dir,
                &cache_dir,
                Arc::new(secrets::KeyringStore::new()),
                events,
            ))?;
            state.sync.start();
            app.manage(state);

            info!("Database ready; sync started");

            reveal_window_fallback(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.sync.trigger_focus();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_external,
            commands::open_mail_link,
            commands::attachments::save_attachment,
            commands::attachments::reveal_download,
            commands::auth::begin_oauth,
            commands::auth::complete_oauth,
            commands::auth::cancel_oauth,
            commands::auth::refresh_token,
            commands::accounts::list_accounts,
            commands::accounts::remove_account,
            commands::threads::list_threads,
            commands::threads::get_thread,
            commands::threads::modify_threads,
            commands::threads::trash_threads,
            commands::labels::list_labels,
            commands::labels::mailbox_counts,
            commands::labels::label_counts,
            commands::sync::sync_now,
            commands::compose::compose_template,
            commands::compose::stage_attachment,
            commands::compose::discard_attachments,
            commands::compose::save_draft,
            commands::compose::get_drafts,
            commands::compose::open_draft,
            commands::compose::delete_draft,
            commands::compose::send_email,
            commands::compose::cancel_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_response_never_panics_on_a_bad_content_type() {
        let ok = attachment_response(mail::InlineResponse {
            status: 200,
            content_type: Some("image/png".into()),
            body: vec![1],
        });
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers()["content-type"], "image/png");
        assert_eq!(ok.body(), &[1]);

        for bad in ["image/png\nX-Evil: 1", "image/png\0"] {
            let response = attachment_response(mail::InlineResponse {
                status: 200,
                content_type: Some(bad.into()),
                body: vec![1],
            });
            assert_eq!(response.status(), 404, "{bad:?}");
            assert!(response.body().is_empty());
        }
        assert_eq!(
            attachment_response(mail::InlineResponse::not_found()).status(),
            404
        );
    }

    #[tokio::test]
    async fn build_state_creates_db_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let state = build_state(
            dir.path(),
            &dir.path().join("cache"),
            Arc::new(secrets::MemoryStore::new()),
            Arc::new(sync::NoopEvents),
        )
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
