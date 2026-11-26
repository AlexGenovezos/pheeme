pub mod accounts;
#[cfg(target_os = "macos")]
mod app_menu;
pub mod attachment_cache;
pub mod attachment_kind;
pub mod body_retention;
mod cadence;
pub mod calendar;
pub mod commands;
pub mod compose;
pub mod contacts;
pub mod db;
pub mod desktop;
mod diagnostics;
pub mod drive;
pub mod filters;
pub mod gmail;
pub mod google_access;
pub mod http;
pub mod identity;
pub mod labels;
pub mod local_api;
mod lock;
pub mod mail;
pub mod mcp;
pub mod mods;
mod presence;
pub mod print;
mod relaunch;
pub mod render;
pub mod search;
pub mod secrets;
pub mod sender_rules;
pub mod senders;
mod shutdown;
mod spelling;
pub mod stats;
pub mod storage;
pub mod support;
pub mod sync;
pub mod tasks;
pub mod telemetry;
#[cfg(test)]
mod test_logs;
mod text;
pub mod transfer;
pub mod weather;

use anyhow::Context;
use secrets::SecretStore;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use sync::manager::SyncManager;
use sync::{SyncEvent, SyncEvents};
use tauri::Manager;
use tracing::info;

/// How long quitting waits for queries in flight before the database closes.
const DB_CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

pub struct AppState {
    pub db: SqlitePool,
    pub accounts: Arc<accounts::AccountService>,
    pub mail: mail::MailService,
    pub labels: labels::LabelService,
    pub sender_rules: sender_rules::SenderRuleService,
    pub filters: filters::FilterService,
    pub compose: compose::ComposeService,
    pub contacts: Arc<contacts::ContactService>,
    pub drive: drive::DriveService,
    pub calendar: Arc<calendar::service::CalendarService>,
    pub tasks: Arc<tasks::service::TasksService>,
    pub sync: Arc<SyncManager>,
    pub transfers: transfer::TransferService,
    /// The MCP server AI assistants connect to, over [`local_api::LocalApi`]; runs only while
    /// Settings › MCP allows it.
    pub assistants: Arc<mcp::McpServer>,
    /// The Gmail per-user limit every account's client paces itself by (Settings › Accounts).
    pub gmail_quota: gmail::QuotaSetting,
    /// What each account's Gmail client spent in the last hour, by source (Settings › Accounts).
    pub gmail_usage: gmail::QuotaUsage,
    /// Where the logs are written (for Send diagnostics); `None` when there is no log dir.
    pub log_dir: Option<PathBuf>,
    google_clients: GoogleClientCaches,
    storage_guard: Option<storage::UnlockedStorage>,
    cache_dir: PathBuf,
}

#[derive(Default)]
struct GoogleClients {
    people: Option<Arc<dyn contacts::PeopleApi>>,
    calendar: Option<Arc<dyn calendar::CalendarApi>>,
    tasks: Option<Arc<dyn tasks::TasksApi>>,
}

#[derive(Clone, Default)]
struct GoogleClientCaches(Arc<Mutex<HashMap<String, GoogleClients>>>);

impl GoogleClientCaches {
    fn register(&self, account_id: &str) {
        lock::lock(&self.0)
            .entry(account_id.to_owned())
            .or_default();
    }

    fn forget(&self, account_id: &str) {
        lock::lock(&self.0).remove(account_id);
    }

    fn factory<T: ?Sized + Send + Sync + 'static>(
        &self,
        accounts: &Arc<accounts::AccountService>,
        slot: fn(&mut GoogleClients) -> &mut Option<Arc<T>>,
        create: impl Fn(Arc<dyn gmail::TokenProvider>) -> Arc<T> + Send + Sync + 'static,
    ) -> impl Fn(&str) -> Arc<T> + 'static {
        let cache = self.clone();
        let accounts = accounts.clone();
        move |account_id| {
            let create = || {
                let tokens = Arc::new(accounts::AccountTokens::new(accounts.clone(), account_id));
                create(tokens)
            };
            if let Some(clients) = lock::lock(&cache.0).get_mut(account_id) {
                return slot(clients).get_or_insert_with(create).clone();
            }
            // An in-flight poll can still ask after removal. Only registered accounts are cached.
            create()
        }
    }
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
    key: storage::StorageKey,
) -> anyhow::Result<AppState> {
    let db = db::init_db(data_dir, &key)
        .await
        .with_context(|| format!("failed to initialize database in {}", data_dir.display()))?;
    storage::migrate_files(cache_dir, &key).await?;
    let accounts = Arc::new(accounts::AccountService::new(db.clone(), secrets));
    let gmail_quota = match db::settings::gmail_quota(&db).await? {
        Some(per_minute) => gmail::QuotaSetting::new(per_minute),
        None => gmail::QuotaSetting::default(),
    };
    let tokens = accounts.clone();
    let quota = gmail_quota.clone();
    let gmail_usage = gmail::QuotaUsage::default();
    let usage = gmail_usage.clone();
    let api_for: sync::manager::ApiFactory = Arc::new(move |account_id: &str| {
        let provider = Arc::new(accounts::AccountTokens::new(tokens.clone(), account_id));
        Arc::new(
            gmail::GmailClient::new(provider)
                .with_quota_setting(&quota)
                .with_usage(usage.account(account_id)),
        ) as Arc<dyn sync::MailApi>
    });
    let sync = SyncManager::new(db.clone(), api_for, events.clone());
    let google_clients = GoogleClientCaches::default();
    for account in accounts.list_accounts().await? {
        google_clients.register(&account.id);
    }
    let people_for = Arc::new(google_clients.factory(
        &accounts,
        |clients| &mut clients.people,
        |tokens| Arc::new(gmail::GmailClient::people(tokens)),
    ));
    let contacts = contacts::ContactService::new(db.clone(), people_for);
    let calendar_for = Arc::new(google_clients.factory(
        &accounts,
        |clients| &mut clients.calendar,
        |tokens| Arc::new(gmail::GmailClient::calendar(tokens)),
    ));
    let calendar =
        calendar::service::CalendarService::new(db.clone(), calendar_for, events.clone());
    let tasks_for = Arc::new(google_clients.factory(
        &accounts,
        |clients| &mut clients.tasks,
        |tokens| Arc::new(gmail::GmailClient::tasks(tokens)),
    ));
    let tasks = tasks::service::TasksService::new(db.clone(), tasks_for, events);
    let mail = mail::MailService::new(
        db.clone(),
        sync.clone(),
        cache_dir.to_path_buf(),
        key.clone(),
    );
    let labels = labels::LabelService::new(db.clone(), sync.clone());
    let sender_rules = sender_rules::SenderRuleService::new(db.clone(), sync.clone());
    let filters = filters::FilterService::new(db.clone(), sync.clone());
    let compose =
        compose::ComposeService::new(db.clone(), sync.clone(), mail.clone(), cache_dir, key);
    let drive = drive::DriveService::new(accounts.clone(), mail.clone());
    let local_api = local_api::LocalApi::new(
        db.clone(),
        accounts.clone(),
        mail.clone(),
        compose.clone(),
        sync.clone(),
        calendar.clone(),
        tasks.clone(),
    );
    let assistants = Arc::new(mcp::McpServer::new(Arc::new(local_api), mcp::DEFAULT_PORT));
    compose.sweep_staging().await;
    tokio::spawn({
        let mail = mail.clone();
        shutdown::until(async move { mail.sweep_attachment_cache().await })
    });
    tokio::spawn(shutdown::until(body_retention::run(db.clone())));
    tokio::spawn(shutdown::until(contacts.clone().run()));
    tokio::spawn(shutdown::until(calendar.clone().run()));
    tokio::spawn(shutdown::until(tasks.clone().run()));
    Ok(AppState {
        db,
        accounts,
        mail,
        labels,
        sender_rules,
        filters,
        compose,
        contacts,
        drive,
        calendar,
        tasks,
        sync,
        transfers: transfer::TransferService::default(),
        assistants,
        gmail_quota,
        gmail_usage,
        log_dir: None,
        google_clients,
        storage_guard: None,
        cache_dir: cache_dir.to_path_buf(),
    })
}

/// Forwards sync events to the webview.
struct TauriEvents(tauri::AppHandle);

impl SyncEvents for TauriEvents {
    fn emit(&self, event: SyncEvent) {
        use tauri::Emitter;
        desktop::sync_event(&self.0, &event);
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

/// Without its data Pheeme can't run, so say why in a native dialog (the main window never
/// shows) rather than quitting silently. A lost key can start again from Gmail.
fn startup_failed(
    app: &tauri::AppHandle,
    error: &anyhow::Error,
    data_dir: std::path::PathBuf,
    cache_dir: std::path::PathBuf,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    tracing::error!("Pheeme couldn't start: {error:#}");
    // The frontend shows the window once it loads; keep it from loading without its state.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate("about:blank".parse().expect("valid URL"));
    }
    let lost = error.downcast_ref::<storage::KeyLost>().is_some();
    let mut message = format!("{error:#}");
    if lost {
        message.push_str(
            "\n\nOr start again: Pheeme moves the unreadable data into \"unreadable\" folders \
             beside it, makes a new key and downloads your mail again from Gmail. You'll sign \
             in to your accounts again, and changes not yet sent to Gmail stay in those folders.",
        );
    }
    let dialog = app
        .dialog()
        .message(message)
        .title("Pheeme couldn't start")
        .kind(MessageDialogKind::Error);
    let app = app.clone();
    if !lost {
        dialog
            .buttons(MessageDialogButtons::OkCustom("Quit".into()))
            .show(move |_| app.exit(1));
        return;
    }
    dialog
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Start again".into(),
            "Quit".into(),
        ))
        .show(move |start_again| {
            if !start_again {
                return app.exit(1);
            }
            match storage::set_aside(&data_dir, &cache_dir, &secrets::OsKeychain) {
                Ok(aside) => {
                    info!(
                        "Unreadable local data moved to {}",
                        support::scrub::display_path(&aside)
                    );
                    app.restart();
                }
                Err(error) => {
                    tracing::error!("Couldn't set the unreadable data aside: {error:#}");
                    app.exit(1);
                }
            }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The main window starts hidden and the frontend shows it after its first paint. If that never happens (a script
/// error, a stuck first command), show it anyway so the app is never invisible.
fn reveal_window_fallback(app: tauri::AppHandle) {
    const AFTER: std::time::Duration = std::time::Duration::from_secs(3);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AFTER).await;
        if commands::updater::launch_is_hidden(&app) {
            return;
        }
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
    #[cfg(target_os = "macos")]
    spelling::enable_before_webviews();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_event);

    builder
        // First, so a second launch hands over to the running Pheeme before doing anything else:
        // it brings that window forward and exits, instead of failing on the locked data folder.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Not after a failed start: that window is blank behind the error dialog.
            if app.try_state::<AppState>().is_some() {
                info!("Pheeme was opened again; showing the running window");
                desktop::show_window(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("external-links")
                .on_navigation(|_webview, url| commands::allow_navigation(url))
                .build(),
        )
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
        .register_uri_scheme_protocol(print::PRINT_SCHEME, |ctx, request| {
            ctx.app_handle()
                .state::<Arc<print::PrintPages>>()
                .serve(&request.uri().to_string())
        })
        .manage(Arc::new(print::PrintPages::default()))
        .setup(|app| {
            let log_dir = app.path().app_log_dir();
            let log_path = log_dir.as_ref().ok().cloned();
            app.manage(diagnostics::init(log_dir));
            app.manage(weather::WeatherService::new());
            diagnostics::watch_runtime_stalls();
            // Sleep, wake, sleeping displays and whether the window can be seen, for the log.
            presence::watch();
            info!(
                version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                directory = ?log_path.as_deref().map(support::scrub::display_path),
                "Pheeme starting"
            );
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                spelling::enable_in(&window);
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;

            info!(
                "App data directory: {}",
                support::scrub::display_path(&data_dir)
            );

            // Block until the database is ready so commands never run without state.
            let events = Arc::new(TauriEvents(app.handle().clone()));
            let storage_dir = data_dir.clone();
            let started = tauri::async_runtime::block_on(async {
                let storage_guard = tokio::task::spawn_blocking(move || {
                    storage::unlock(&storage_dir, &secrets::OsKeychain)
                })
                .await??;
                let state = build_state(
                    &data_dir,
                    &cache_dir,
                    Arc::new(secrets::KeyringStore::new()),
                    events,
                    storage_guard.key.clone(),
                )
                .await?;
                anyhow::Ok((storage_guard, state))
            });
            let (storage_guard, mut state) = match started {
                Ok(started) => started,
                Err(error) => {
                    startup_failed(app.handle(), &error, data_dir, cache_dir);
                    return Ok(());
                }
            };
            state.storage_guard = Some(storage_guard);
            state.log_dir = log_path;
            let sync = state.sync.clone();
            let assistants = state.assistants.clone();
            let activity_events = app.handle().clone();
            assistants.api().on_activity(Arc::new(move || {
                use tauri::Emitter;
                let _ = activity_events.emit("assistant:activity", ());
            }));
            tauri::async_runtime::spawn(async move {
                assistants.apply_setting().await;
            });
            if telemetry::active_in_this_build() {
                tauri::async_runtime::spawn(shutdown::until(telemetry::run(state.db.clone())));
            }
            let hidden = tauri::async_runtime::block_on(db::settings::take_start_hidden(
                &state.db,
                sync::engine::now_ms(),
            ))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "couldn't read whether to start hidden");
                false
            });
            if hidden {
                info!("restarted by an update while hidden; keeping the window hidden");
            }
            app.manage(commands::updater::LaunchHidden(hidden));
            app.manage(state);
            desktop::install(app.handle());
            sync.start();
            let mod_events = app.handle().clone();
            let safe_mode = std::env::args().any(|arg| arg == "--disable-mods")
                || std::env::var("PHEEME_DISABLE_MODS").is_ok_and(|value| value == "1");
            match tauri::async_runtime::block_on(mods::ModService::open(
                data_dir.join("mods"),
                Arc::new(secrets::OsKeychain),
                safe_mode,
                Arc::new(move || {
                    use tauri::Emitter;
                    let _ = mod_events.emit("mods:changed", ());
                }),
                Arc::new(|url| {
                    open::that_detached(url).map_err(|_| "Could not open the login browser".into())
                }),
            )) {
                Ok(mods) => {
                    app.manage(mods);
                }
                Err(error) => {
                    tracing::error!(%error, "Could not load mods; mail remains available")
                }
            }

            info!("Database ready; sync started");

            reveal_window_fallback(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // A print window just closes (`print.rs`): hiding to the tray, quitting and the
            // rest below are the main window's.
            if window.label().starts_with(print::WINDOW_PREFIX) {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "linux")]
                {
                    // Re-check the host at close time: a tray extension may have been disabled
                    // since the last sync. Query D-Bus off the UI thread before hiding the window.
                    api.prevent_close();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        if desktop::has_tray_host(window.app_handle()).await {
                            let _ = window.hide();
                        } else {
                            // No tray to live in: closing quits, through the exit request
                            // that saves open drafts first.
                            window.app_handle().exit(0);
                        }
                    });
                }
                #[cfg(not(target_os = "linux"))]
                // Unmanaged when startup failed (`startup_failed`): let the window close.
                if let Some(desktop) = window.try_state::<Arc<desktop::Desktop>>() {
                    if desktop.can_hide.load(std::sync::atomic::Ordering::Relaxed)
                        && window.hide().is_ok()
                    {
                        api.prevent_close();
                    } else if window.label() == "main" {
                        // Closing quits: go through the exit request, which saves open
                        // drafts while the window is still there.
                        api.prevent_close();
                        window.app_handle().exit(0);
                    }
                }
            }
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    presence::set_focused(*focused);
                }
                if *focused {
                    if let Some(state) = window.try_state::<AppState>() {
                        state.sync.trigger_focus();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::desktop_settings,
            commands::themes::list_theme_folder,
            commands::themes::open_theme_folder,
            commands::settings::set_account_notifications,
            commands::settings::answer_notification_prompt,
            commands::settings::set_tray_icon,
            commands::settings::set_notification_schedule,
            commands::settings::telemetry_enabled,
            commands::settings::set_telemetry,
            commands::settings::record_usage,
            commands::settings::take_notification_target,
            commands::settings::set_calendar_reminders,
            commands::settings::gmail_quota,
            commands::settings::set_gmail_quota,
            commands::settings::gmail_quota_usage,
            commands::mods::list_mods,
            commands::mods::prepare_mod_install,
            commands::mods::discard_mod_install,
            commands::mods::install_mod,
            commands::mods::set_mod_enabled,
            commands::mods::remove_mod,
            commands::mods::mod_action,
            commands::mods::mod_connection_status,
            commands::mods::connect_mod,
            commands::mods::disconnect_mod,
            commands::open_external,
            commands::open_mail_link,
            commands::attachments::save_attachment,
            commands::attachments::reveal_download,
            commands::attachments::read_attachment,
            commands::attachments::prefetch_attachments,
            commands::attachments::open_attachment,
            commands::attachments::clear_downloaded_mail,
            commands::auth::begin_oauth,
            commands::auth::complete_oauth,
            commands::auth::cancel_oauth,
            commands::transfer::transfer_interfaces,
            commands::transfer::local_network_access,
            commands::transfer::open_local_network_settings,
            commands::transfer::offer_client_transfer,
            commands::transfer::client_transfer_status,
            commands::transfer::approve_client_transfer,
            commands::transfer::cancel_client_transfer,
            commands::transfer::receive_client_transfer,
            commands::accounts::list_accounts,
            commands::accounts::remove_account,
            commands::accounts::set_account_color,
            commands::accounts::reorder_accounts,
            commands::threads::list_threads,
            commands::threads::get_thread,
            commands::threads::modify_threads,
            commands::threads::mark_inbox_tab_read,
            commands::threads::mark_search_read,
            commands::threads::trash_threads,
            commands::threads::inbox_tabs,
            commands::threads::set_inbox_tabs,
            commands::labels::list_labels,
            commands::labels::mailbox_counts,
            commands::labels::label_counts,
            commands::labels::create_label,
            commands::labels::update_label,
            commands::labels::delete_label,
            commands::labels::delete_label_preview,
            commands::assistant::assistant_status,
            commands::assistant::set_assistant_enabled,
            commands::assistant::set_assistant_permission,
            commands::assistant::connect_assistant,
            commands::assistant::remove_assistant,
            commands::assistant::assistant_activity,
            commands::assistant::clear_assistant_activity,
            commands::sender_rules::list_sender_rules,
            commands::sender_rules::rule_senders,
            commands::sender_rules::save_sender_rules,
            commands::sender_rules::undo_sender_rules,
            commands::sender_rules::delete_sender_rule,
            commands::sender_rules::inbox_threads_from,
            commands::filters::list_filters,
            commands::filters::create_filter,
            commands::filters::replace_filter,
            commands::filters::delete_filter,
            commands::filters::filter_matches,
            commands::filters::forwarding_addresses,
            commands::stats::mail_stats,
            commands::stats::unsubscribe_sender,
            commands::search::search_messages,
            commands::search::search_gmail,
            commands::search::recent_searches,
            commands::search::add_recent_search,
            commands::search::remove_recent_search,
            commands::sync::sync_now,
            commands::sync::network_online,
            commands::sync::get_sync_progress,
            commands::contacts::suggest_contacts,
            commands::contacts::google_contacts_status,
            commands::contacts::refresh_google_contacts,
            commands::contacts::person_profile,
            commands::contacts::save_person_contact,
            commands::drive::drive_files,
            commands::drive::save_attachment_to_drive,
            commands::calendar::calendar_accounts,
            commands::calendar::calendar_events,
            commands::calendar::calendar_availability,
            commands::calendar::search_calendar_events,
            commands::calendar::set_calendar_hidden,
            commands::calendar::set_calendar_color,
            commands::calendar::calendar_sync_now,
            commands::calendar::open_meeting_link,
            commands::calendar::set_calendar_foreground,
            commands::calendar::calendar_event_detail,
            commands::calendar::create_calendar_event,
            commands::calendar::update_calendar_event,
            commands::calendar::delete_calendar_event,
            commands::calendar::move_calendar_event,
            commands::calendar::copy_calendar_event,
            commands::calendar::respond_to_calendar_event,
            commands::calendar::respond_to_calendar_invite,
            commands::calendar::message_invite,
            commands::calendar::calendar_file,
            commands::calendar::add_calendar_file_events,
            commands::calendar::log_calendar_write,
            commands::calendar::event_templates,
            commands::calendar::save_event_template,
            commands::calendar::rename_event_template,
            commands::calendar::delete_event_template,
            commands::weather::weather_search_places,
            commands::weather::weather_forecast,
            commands::weather::weather_for_location,
            commands::tasks::tasks_accounts,
            commands::tasks::tasks_in_list,
            commands::tasks::dated_tasks,
            commands::tasks::tasks_due_through,
            commands::tasks::set_task_list_hidden,
            commands::tasks::tasks_sync_now,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::set_task_completed,
            commands::tasks::delete_task,
            commands::tasks::move_task,
            commands::tasks::move_task_to_list,
            commands::tasks::create_task_list,
            commands::tasks::rename_task_list,
            commands::tasks::delete_task_list,
            commands::compose::compose_template,
            commands::compose::gmail_signature,
            commands::compose::signature_settings,
            commands::compose::set_signature_settings,
            commands::compose::send_as_addresses,
            commands::compose::stage_attachment,
            commands::compose::stage_pasted_attachment,
            commands::compose::read_staged_attachment,
            commands::print::print_email,
            commands::compose::discard_attachments,
            commands::compose::save_draft,
            commands::compose::get_drafts,
            commands::compose::open_draft,
            commands::compose::delete_draft,
            commands::compose::send_email,
            commands::compose::cancel_send,
            commands::compose::failed_sends,
            commands::compose::reopen_failed_send,
            commands::support::send_diagnostics,
            commands::support::prepare_screenshot,
            commands::support::save_diagnostics,
            commands::updater::log_update,
            commands::updater::start_hidden_next_launch,
            commands::updater::launch_hidden,
            commands::support::log_thread_shown,
            commands::support::log_preview,
            commands::support::log_window_problem,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                // Not after a failed start: that window is blank behind the error dialog.
                if app.try_state::<AppState>().is_some() {
                    desktop::show_window(app);
                }
            }
            // Quit or restart: open compose panels are saved to Drafts first.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                relaunch::note_exit_requested(*code);
                commands::quit::save_drafts_before_exit(app, *code, api);
            }
            if let tauri::RunEvent::Exit = event {
                info!("Pheeme exiting");
                let mut db_closed = true;
                shutdown::begin();
                if let Some(state) = app.try_state::<AppState>() {
                    if let Err(error) = storage::clear_opened(&state.cache_dir) {
                        tracing::warn!(%error, "couldn't remove opened attachment copies");
                    }
                    // SQLCipher (4.7 and later) frees its locks and memory in an exit hook; a
                    // connection still working on its own thread then crashes the process. So
                    // close them all first, letting a query in flight finish for a moment.
                    let db = state.db.clone();
                    db_closed = tauri::async_runtime::block_on(async move {
                        tokio::time::timeout(DB_CLOSE_WAIT, db.close())
                            .await
                            .is_ok()
                    });
                    if !db_closed {
                        tracing::warn!("database still busy at exit: leaving without exit hooks");
                    }
                }
                if let Some(logs) = app.try_state::<diagnostics::LogGuard>() {
                    logs.shutdown();
                }
                // Still busy: end here, before Tauri's exit runs SQLCipher's hook under it.
                if !db_closed {
                    relaunch::exit_without_exit_hooks(app);
                }
                // On macOS, restart without `open -n`'s second Dock icon.
                relaunch::take_over_restart(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn google_api_factory_reuses_each_accounts_client_until_forgotten() {
        let db = db::test_support::TestDb::new().await;
        let accounts = Arc::new(accounts::AccountService::new(
            db.pool.clone(),
            Arc::new(secrets::MemoryStore::new()),
        ));
        let caches = GoogleClientCaches::default();
        caches.register("a1");
        caches.register("a2");
        let calendar_for = caches.factory(
            &accounts,
            |clients| &mut clients.calendar,
            |tokens| Arc::new(gmail::GmailClient::calendar(tokens)),
        );
        let first = calendar_for("a1");
        let other = calendar_for("a2");
        assert!(Arc::ptr_eq(&first, &calendar_for("a1")));
        assert!(!Arc::ptr_eq(&first, &other));
        caches.forget("a1");
        let uncached = calendar_for("a1");
        assert!(!Arc::ptr_eq(&first, &uncached));
        assert!(!Arc::ptr_eq(&uncached, &calendar_for("a1")));
        assert!(Arc::ptr_eq(&other, &calendar_for("a2")));
    }

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
            storage::test_key(),
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
