//! macOS app menu: the platform default plus "Check for Updates…" under "About Pheeme", and a
//! Quit that goes through `AppHandle::exit`.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, Runtime};
use tracing::warn;

/// Menu item id, and the event the frontend listens for to run a manual update check.
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

/// Menu item id of the app menu's Quit.
pub const QUIT: &str = "quit";

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
    if cfg!(target_os = "macos") {
        replace_quit(app, &menu)?;
    }
    Ok(menu)
}

/// The default app menu's Quit is predefined (`terminate:`), which ends the process without
/// raising `RunEvent::ExitRequested`, so Cmd+Q would skip the save-drafts-before-exit hook.
/// A custom item calling `AppHandle::exit` raises it. The default puts Quit last in the app menu.
fn replace_quit<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let Some(app_submenu) = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
    else {
        warn!("default menu has no app submenu; leaving its Quit as is");
        return Ok(());
    };
    match app_submenu.items()?.pop() {
        Some(last @ MenuItemKind::Predefined(_)) => app_submenu.remove(&last)?,
        _ => {
            warn!("the app menu doesn't end with Quit; leaving it as is");
            return Ok(());
        }
    }
    let quit = MenuItem::with_id(app, QUIT, "Quit Pheeme", true, Some("CmdOrCtrl+Q"))?;
    app_submenu.append(&quit)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == QUIT {
        app.exit(0);
        return;
    }
    if event.id() == CHECK_FOR_UPDATES {
        if let Err(err) = app.emit(CHECK_FOR_UPDATES, ()) {
            warn!("failed to request an update check: {err}");
        }
    }
}
