use super::ThreadTarget;
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
pub async fn show(app: &AppHandle, target: ThreadTarget, title: String, body: String) {
    if native::show(app, target, title, body).await.is_err() {
        // OS errors may contain message text. Keep logs and UI to a stable, content-free error.
        super::report_error(
            app,
            "Couldn't display a desktop notification. Check your system notification settings.",
        );
    }
}
#[cfg(target_os = "linux")]
pub async fn tray_available() -> bool {
    native::tray_available().await
}
