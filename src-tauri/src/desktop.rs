//! Desktop integration. Sync produces arrivals; this layer handles OS presentation and navigation.
mod icon;
mod platform;
mod schedule;

use crate::calendar::reminders::{Alert, EventTarget, ReminderAlerts, ReminderService};
use crate::db::{self, desktop::AccountDesktop};
use crate::sync::SyncEvent;
use crate::AppState;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

pub use schedule::{NotifySchedule, ScheduleMode};

const TRAY: &str = "pheeme-mail";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTarget {
    pub account_id: String,
    pub thread_id: String,
}

/// What clicking a notification opens: a conversation, or an event (a reminder).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotifyTarget {
    Thread(ThreadTarget),
    Event(EventTarget),
}

pub struct Desktop {
    refresh: Notify,
    pending: Mutex<Option<NotifyTarget>>,
    pub can_hide: AtomicBool,
    reminders: Arc<ReminderService>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub accounts: Vec<AccountDesktop>,
    pub permission: String,
    /// Closing the window keeps Pheeme running in the tray.
    pub tray_available: bool,
    /// The user wants the menu bar / notification area icon.
    pub tray_enabled: bool,
    /// When alerts may appear, for every account.
    pub schedule: NotifySchedule,
    /// Event reminders pop up as notifications.
    pub calendar_reminders: bool,
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

pub fn activate(app: &AppHandle, target: NotifyTarget) {
    if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
        *desktop.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(target);
        // The target stays queued until the mounted frontend claims it, including early startup.
        let _ = app.emit("desktop:open-thread", ());
    }
    show_window(app);
}

/// A reminder's Join button: opens the call in the default browser (web links only).
pub fn join_call(url: &str) {
    let Some(url) = crate::calendar::meeting::joinable(url) else {
        tracing::warn!("notification join link is not a web link");
        return;
    };
    if let Err(error) = open::that_detached(url.as_str()) {
        tracing::warn!(%error, "Could not open a video call from a notification");
    }
}

pub fn take_target(app: &AppHandle) -> Option<NotifyTarget> {
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
        SyncEvent::CalendarUpdated { .. } | SyncEvent::CalendarAccess { .. }
    ) {
        if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
            desktop.reminders.replan();
        }
    }
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
            let schedule = db::settings::notify_schedule(&state.db)
                .await
                .unwrap_or_default();
            match db::desktop::accounts(&state.db).await {
                Ok(accounts)
                    if accounts
                        .iter()
                        .any(|a| a.account_id == account_id && a.enabled) =>
                {
                    // Dropped, not saved for later.
                    if !schedule.allows(Local::now().naive_local()) {
                        tracing::info!(
                            %account_id,
                            alerts = messages.len(),
                            "new mail not alerted: outside the notification schedule"
                        );
                        return;
                    }
                    // One notification per conversation per sync, including replies to existing threads.
                    let by_thread: BTreeMap<_, _> = messages
                        .into_iter()
                        .map(|m| (m.thread_id.clone(), m))
                        .collect();
                    let (mut shown, mut failed) = (0usize, 0usize);
                    for (thread_id, mail) in by_thread {
                        let target = NotifyTarget::Thread(ThreadTarget {
                            account_id: account_id.clone(),
                            thread_id,
                        });
                        let body = format!(
                            "{}\n{}",
                            clean_text(&mail.subject, 160),
                            clean_text(&mail.snippet, 240)
                        );
                        if platform::show(&app, target, clean_text(&mail.sender, 120), body, None)
                            .await
                        {
                            shown += 1;
                        } else {
                            failed += 1;
                        }
                    }
                    // Counts only: never the sender, subject or snippet.
                    tracing::info!(%account_id, alerts = shown + failed, shown, failed, "desktop alerts delivered");
                }
                Ok(_) => tracing::info!(
                    %account_id,
                    alerts = messages.len(),
                    "new mail not alerted: notifications are off for this account"
                ),
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
        tray_enabled: db::settings::tray_icon(&state.db).await?,
        schedule: db::settings::notify_schedule(&state.db).await?,
        calendar_reminders: db::settings::calendar_reminders(&state.db).await?,
    })
}

/// Turn event reminders on or off. Turning them on may ask for notification permission.
pub async fn set_calendar_reminders(
    app: &AppHandle,
    enabled: bool,
) -> anyhow::Result<DesktopSettings> {
    let pool = &app.state::<AppState>().db;
    if enabled && platform::permission(true).await? == "denied" {
        db::settings::set_calendar_reminders(pool, false).await?;
        anyhow::bail!("Notifications are blocked. Allow Pheeme in your system notification settings, then try again.");
    }
    db::settings::set_calendar_reminders(pool, enabled).await?;
    settings(app).await
}

/// Reminders shown through the OS notification system; clicking one opens the event.
struct DesktopAlerts(AppHandle);

#[async_trait::async_trait]
impl ReminderAlerts for DesktopAlerts {
    async fn permitted(&self) -> bool {
        // "notDetermined" too: a reminder never prompts. Turning reminders or mail
        // notifications on in Settings asks.
        matches!(
            platform::permission(false).await.as_deref(),
            Ok("granted" | "system")
        )
    }

    async fn show(&self, alert: Alert) -> bool {
        platform::show(
            &self.0,
            NotifyTarget::Event(alert.target),
            clean_text(&alert.title, 160),
            clean_text(&alert.body, 240),
            alert.join_url,
        )
        .await
    }
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
            // Still counts as answered, so the first-run prompt doesn't come back.
            db::desktop::set_enabled(&app.state::<AppState>().db, account_id, false).await?;
            anyhow::bail!("Notifications are blocked. Allow Pheeme in your system notification settings, then try again.");
        }
    }
    db::desktop::set_enabled(&app.state::<AppState>().db, account_id, enabled).await?;
    settings(app).await
}

/// Save when alerts may appear. Hours are 0 to 23.
pub async fn set_schedule(
    app: &AppHandle,
    schedule: NotifySchedule,
) -> anyhow::Result<DesktopSettings> {
    if !schedule.valid() {
        anyhow::bail!("Pick hours between 0 and 23.");
    }
    db::settings::set_notify_schedule(&app.state::<AppState>().db, &schedule).await?;
    settings(app).await
}

/// Answer the first-run prompt for every account that hasn't been asked yet.
pub async fn answer_prompt(app: &AppHandle, enable: bool) -> anyhow::Result<DesktopSettings> {
    let pool = &app.state::<AppState>().db;
    if enable && platform::permission(true).await? == "denied" {
        // Don't ask again; Settings explains how to allow them later.
        db::desktop::answer_unasked(pool, false).await?;
        anyhow::bail!("Notifications are blocked. Allow Pheeme in your system notification settings, then turn them on in Settings.");
    }
    db::desktop::answer_unasked(pool, enable).await?;
    settings(app).await
}

/// Show or hide the menu bar / notification area icon. Without it, closing the window quits.
pub async fn set_tray_icon(app: &AppHandle, shown: bool) -> anyhow::Result<DesktopSettings> {
    db::settings::set_tray_icon(&app.state::<AppState>().db, shown).await?;
    let desktop = app.state::<Arc<Desktop>>();
    if shown {
        if app.tray_by_id(TRAY).is_none() {
            build_tray(app)?;
            // The refresh loop fills in the count and, on Linux, checks for a tray host.
            desktop
                .can_hide
                .store(!cfg!(target_os = "linux"), Ordering::Relaxed);
            refresh(app);
        }
    } else {
        desktop.can_hide.store(false, Ordering::Relaxed);
        if let Some(tray) = app.remove_tray_by_id(TRAY) {
            let _ = tray.set_visible(false);
        }
    }
    settings(app).await
}

fn menu(app: &AppHandle, unread: i64) -> tauri::Result<Menu<tauri::Wry>> {
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
    menu.append(&MenuItem::with_id(
        app,
        "desktop:quit",
        "Quit Pheeme",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app, 0)?;
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
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn install(app: &AppHandle) {
    let reminders = ReminderService::new(
        app.state::<AppState>().db.clone(),
        Arc::new(DesktopAlerts(app.clone())),
    );
    let desktop = Arc::new(Desktop {
        refresh: Notify::new(),
        pending: Mutex::new(None),
        can_hide: AtomicBool::new(false),
        reminders: reminders.clone(),
    });
    app.manage(desktop.clone());
    platform::init(app);
    tauri::async_runtime::spawn(reminders.run());
    let shown =
        tauri::async_runtime::block_on(db::settings::tray_icon(&app.state::<AppState>().db))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Could not read the tray setting; showing the icon");
                true
            });
    if shown {
        match build_tray(app) {
            Ok(()) => desktop
                .can_hide
                .store(!cfg!(target_os = "linux"), Ordering::Relaxed),
            Err(error) => {
                tracing::warn!(%error, "Tray unavailable; closing the window will exit normally")
            }
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match platform::permission(false).await {
            Ok(permission) => tracing::info!(%permission, "notification permission at startup"),
            Err(error) => tracing::warn!(%error, "Could not read notification permission"),
        }
    });
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
                let start = std::time::Instant::now();
                let pool = crate::diagnostics::PoolLoad::of(&state.db);
                // Only the Inbox count is read, and inbox tabs don't change it.
                let counts =
                    db::threads::unread_counts(&state.db, &ids, &Default::default()).await?;
                if start.elapsed() >= crate::diagnostics::SLOW_READ {
                    tracing::info!(
                        elapsed_ms = crate::diagnostics::ms_since(start),
                        accounts = ids.len(),
                        %pool,
                        "slow tray unread count"
                    );
                }
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
                    tray.set_menu(Some(menu(&app, unread)?))?;
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
