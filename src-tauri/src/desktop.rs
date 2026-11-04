//! Desktop integration. Sync produces arrivals; this layer handles OS presentation and navigation.
mod icon;
mod platform;

use crate::db::{self, desktop::AccountDesktop};
use crate::sync::SyncEvent;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const TRAY: &str = "pheeme-mail";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTarget {
    pub account_id: String,
    pub thread_id: String,
}

pub struct Desktop {
    refresh: Notify,
    pending: Mutex<Option<ThreadTarget>>,
    pub can_hide: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub accounts: Vec<AccountDesktop>,
    pub permission: String,
    pub tray_available: bool,
}

#[cfg(target_os = "linux")]
pub async fn has_tray_host(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY).is_some() && platform::tray_available().await
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn activate(app: &AppHandle, target: ThreadTarget) {
    if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
        *desktop.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(target);
        // The target stays queued until the mounted frontend claims it, including early startup.
        let _ = app.emit("desktop:open-thread", ());
    }
    show_window(app);
}

pub fn take_target(app: &AppHandle) -> Option<ThreadTarget> {
    app.state::<Arc<Desktop>>()
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

pub fn refresh(app: &AppHandle) {
    if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
        desktop.refresh.notify_one();
    }
}

pub fn sync_event(app: &AppHandle, event: &SyncEvent) {
    if matches!(
        event,
        SyncEvent::MessagesUpdated { .. }
            | SyncEvent::LabelsUpdated { .. }
            | SyncEvent::Completed { .. }
    ) {
        refresh(app);
    }
    if let SyncEvent::NewMail {
        account_id,
        messages,
    } = event
    {
        let app = app.clone();
        let account_id = account_id.clone();
        let messages = messages.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            match db::desktop::accounts(&state.db).await {
                Ok(accounts)
                    if accounts
                        .iter()
                        .any(|a| a.account_id == account_id && a.enabled) =>
                {
                    // One notification per conversation per sync, including replies to existing threads.
                    let by_thread: BTreeMap<_, _> = messages
                        .into_iter()
                        .map(|m| (m.thread_id.clone(), m))
                        .collect();
                    for (thread_id, mail) in by_thread {
                        let target = ThreadTarget {
                            account_id: account_id.clone(),
                            thread_id,
                        };
                        let body = format!(
                            "{}\n{}",
                            clean_text(&mail.subject, 160),
                            clean_text(&mail.snippet, 240)
                        );
                        platform::show(&app, target, clean_text(&mail.sender, 120), body).await;
                    }
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(%error, "Could not read notification preferences"),
            }
        });
    }
}

// Do not pass control characters, arbitrarily large text or desktop markup from mail to the OS.
fn clean_text(text: &str, limit: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

pub fn report_error(app: &AppHandle, message: &str) {
    tracing::warn!("{message}");
    let _ = app.emit("desktop:error", message);
}

pub async fn settings(app: &AppHandle) -> anyhow::Result<DesktopSettings> {
    let state = app.state::<AppState>();
    Ok(DesktopSettings {
        accounts: db::desktop::accounts(&state.db).await?,
        permission: platform::permission(false).await?,
        tray_available: app.state::<Arc<Desktop>>().can_hide.load(Ordering::Relaxed),
    })
}

pub async fn set_notifications(
    app: &AppHandle,
    account_id: &str,
    enabled: bool,
) -> anyhow::Result<DesktopSettings> {
    // Verify identity before prompting the OS.
    if db::accounts::get_account(&app.state::<AppState>().db, account_id)
        .await?
        .is_none()
    {
        anyhow::bail!("This account is no longer connected.");
    }
    if enabled {
        let permission = platform::permission(true).await?;
        if permission == "denied" {
            anyhow::bail!("Notifications are blocked. Allow Pheeme in your system notification settings, then try again.");
        }
    }
    db::desktop::set_enabled(&app.state::<AppState>().db, account_id, enabled).await?;
    settings(app).await
}

pub async fn mark_all_read(app: &AppHandle, account_id: &str) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    mark_account_read(&state.db, &state.mail, account_id).await
}

async fn mark_account_read(
    pool: &sqlx::SqlitePool,
    mail: &crate::mail::MailService,
    account_id: &str,
) -> anyhow::Result<()> {
    let ids = db::desktop::unread_threads(pool, account_id).await?;
    for chunk in ids.chunks(500) {
        mail.modify_threads(account_id, chunk, &[], &["UNREAD".into()])
            .await?;
    }
    Ok(())
}

fn menu(
    app: &AppHandle,
    accounts: &[AccountDesktop],
    unread: i64,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "desktop:open",
        "Open Pheeme",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::new(
        app,
        format!("{unread} unread inbox conversations"),
        false,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for account in accounts {
        menu.append(&MenuItem::with_id(
            app,
            format!("desktop:read:{}", account.account_id),
            format!("Mark all read — {}", account.email.replace('&', "&&")),
            true,
            None::<&str>,
        )?)?;
    }
    if !accounts.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "desktop:quit",
        "Quit Pheeme",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

pub fn install(app: &AppHandle) {
    let desktop = Arc::new(Desktop {
        refresh: Notify::new(),
        pending: Mutex::new(None),
        can_hide: AtomicBool::new(false),
    });
    app.manage(desktop.clone());
    platform::init(app);
    let tray = (|| -> tauri::Result<_> {
        let menu = menu(app, &[], 0)?;
        TrayIconBuilder::with_id(TRAY)
            .icon(icon::image(0))
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("Pheeme")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false)
                            && !window.is_minimized().unwrap_or(false)
                        {
                            let _ = window.hide();
                        } else {
                            show_window(app);
                        }
                    }
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "desktop:open" => show_window(app),
                "desktop:quit" => app.exit(0),
                id => {
                    if let Some(account) = id.strip_prefix("desktop:read:") {
                        let app = app.clone();
                        let account = account.to_owned();
                        tauri::async_runtime::spawn(async move {
                            if mark_all_read(&app, &account).await.is_err() {
                                report_error(
                                    &app,
                                    "Couldn't mark all mail read. Open Pheeme and try again.",
                                );
                            }
                        });
                    }
                }
            })
            .build(app)
    })();
    match tray {
        Ok(_) => desktop
            .can_hide
            .store(!cfg!(target_os = "linux"), Ordering::Relaxed),
        Err(error) => {
            tracing::warn!(%error, "Tray unavailable; closing the window will exit normally")
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Initial snapshot, then only existing sync/account events; no extra mail polling.
            let result = async {
                let state = app.state::<AppState>();
                let accounts = db::desktop::accounts(&state.db).await?;
                let ids = accounts
                    .iter()
                    .map(|a| a.account_id.clone())
                    .collect::<Vec<_>>();
                let counts = db::threads::unread_counts(&state.db, &ids).await?;
                let unread = counts
                    .iter()
                    .find(|(id, _)| id == "INBOX")
                    .map_or(0, |(_, n)| *n);
                if let Some(tray) = app.tray_by_id(TRAY) {
                    tray.set_tooltip(Some(format!(
                        "Pheeme — {unread} unread inbox conversations"
                    )))?;
                    // The macOS envelope is constant. Replacing it resets its template tint;
                    // only the title changes there as the unread count moves.
                    #[cfg(not(target_os = "macos"))]
                    tray.set_icon(Some(icon::image(unread)))?;
                    #[cfg(target_os = "macos")]
                    tray.set_title(Some(if unread > 0 {
                        unread.to_string()
                    } else {
                        String::new()
                    }))?;
                    tray.set_menu(Some(menu(&app, &accounts, unread)?))?;
                    #[cfg(target_os = "linux")]
                    desktop
                        .can_hide
                        .store(platform::tray_available().await, Ordering::Relaxed);
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                tracing::warn!(%error, "Could not update tray");
            }
            desktop.refresh.notified().await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_text_is_bounded_and_has_no_controls() {
        assert_eq!(clean_text("Subject\n\0\u{1b}hi", 9), "Subjecthi");
        assert_eq!(clean_text("éééé", 2), "éé");
    }
}

#[cfg(test)]
mod mail_tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::sync::fake::{FakeGmail, FakeMsg};
    use crate::sync::manager::SyncManager;
    use crate::sync::{MailApi, NoopEvents};

    #[tokio::test]
    async fn tray_mark_all_read_uses_outbox_and_preserves_other_account() {
        let db = TestDb::with_account("a").await;
        let mut other = db::accounts::get_account(&db.pool, "a")
            .await
            .unwrap()
            .unwrap();
        other.id = "b".into();
        other.email = "other@example.com".into();
        db::accounts::insert_account(&db.pool, &other)
            .await
            .unwrap();
        let first = Arc::new(FakeGmail::new());
        let second = Arc::new(FakeGmail::new());
        first.seed(FakeMsg::new("same-id", "same-thread", &["INBOX", "UNREAD"]));
        first.seed(FakeMsg::new("archived", "archived", &["UNREAD"]));
        second.seed(FakeMsg::new("same-id", "same-thread", &["INBOX", "UNREAD"]));
        let (a, b) = (first.clone(), second.clone());
        let sync = SyncManager::new(
            db.pool.clone(),
            Arc::new(move |id| {
                if id == "a" {
                    a.clone() as Arc<dyn MailApi>
                } else {
                    b.clone() as Arc<dyn MailApi>
                }
            }),
            Arc::new(NoopEvents),
        );
        for id in ["a", "b"] {
            sync.engine(id).run_initial_sync().await.unwrap();
        }
        while sync.engine("a").backfill_step().await.unwrap()
            != crate::sync::engine::BackfillProgress::Done
        {}
        let mail =
            crate::mail::MailService::new(db.pool.clone(), sync.clone(), db.dir().join("cache"));
        mark_account_read(&db.pool, &mail, "a").await.unwrap();
        assert!(db::desktop::unread_threads(&db.pool, "a")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db::desktop::unread_threads(&db.pool, "b").await.unwrap(),
            ["same-thread"]
        );
        // The same operation reaches Gmail, rather than changing just the badge locally.
        sync.sync_account("a").await.unwrap();
        for id in ["same-id", "archived"] {
            assert!(!first.message(id).unwrap().labels.contains(&"UNREAD".into()));
        }
        assert!(second
            .message("same-id")
            .unwrap()
            .labels
            .contains(&"UNREAD".into()));
        mark_account_read(&db.pool, &mail, "a").await.unwrap(); // no unread mail is a successful no-op
    }
}
