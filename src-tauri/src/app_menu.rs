//! macOS app menu: the platform default plus "Check for Updates…" under "About Pheeme".

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Emitter, Runtime};
use tracing::warn;

/// Menu item id, and the event the frontend listens for to run a manual update check.
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let check = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    // On macOS the first default submenu is the app menu, opening with "About Pheeme".
    match menu.items()?.first().and_then(|item| item.as_submenu()) {
        Some(app_submenu) => app_submenu.insert(&check, 1)?,
        None => warn!("default menu has no app submenu; skipping Check for Updates"),
    }
    Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == CHECK_FOR_UPDATES {
        if let Err(err) = app.emit(CHECK_FOR_UPDATES, ()) {
            warn!("failed to request an update check: {err}");
        }
    }
}
