use super::super::{activate, NotifyTarget};
use tauri::AppHandle;
use winrt_notification::Toast;

pub fn init(_: &AppHandle) {}
pub async fn permission(_: bool) -> anyhow::Result<String> {
    Ok("system".into())
}
pub async fn show(
    app: &AppHandle,
    target: NotifyTarget,
    title: String,
    body: String,
) -> anyhow::Result<()> {
    let app = app.clone();
    // Use Pheeme's installer-created identity. No high-priority toast or DND bypass.
    Toast::new(crate::identity::APP_IDENTIFIER)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            activate(&app, target.clone());
            Ok(())
        })
        .show()?;
    Ok(())
}
