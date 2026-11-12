use super::NotifyTarget;
use tauri::AppHandle;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod native;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod native;

pub fn init(app: &AppHandle) {
    native::init(app);
}
pub async fn permission(request: bool) -> anyhow::Result<String> {
    native::permission(request).await
}
/// Returns whether the OS accepted the notification. `join`: a video call link, offered as a
/// Join button (a click on the notification itself still opens `target`).
pub async fn show(
    app: &AppHandle,
    target: NotifyTarget,
    title: String,
    body: String,
    join: Option<String>,
) -> bool {
    let shown = native::show(app, target, title, body, join).await.is_ok();
    if !shown {
        // OS errors may contain message text. Keep logs and UI to a stable, content-free error.
        super::report_error(
            app,
            "Couldn't display a desktop notification. Check your system notification settings.",
        );
    }
    shown
}
#[cfg(target_os = "linux")]
pub async fn tray_available() -> bool {
    native::tray_available().await
}
