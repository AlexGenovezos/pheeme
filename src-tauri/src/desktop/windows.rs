use super::super::{activate, join_call, NotifyTarget};
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
    join: Option<String>,
) -> anyhow::Result<()> {
    let app = app.clone();
    // Use Pheeme's installer-created identity. No high-priority toast or DND bypass.
    let mut toast = Toast::new(crate::identity::APP_IDENTIFIER)
        .title(&title)
        .text1(&body);
    if join.is_some() {
        toast = toast.add_button("Join", "join");
    }
    toast
        .on_activated(move |action| {
            // The Join button's argument; a click on the toast itself has none.
            match (action.as_deref(), &join) {
                (Some("join"), Some(url)) => join_call(url),
                _ => activate(&app, target.clone()),
            }
            Ok(())
        })
        .show()?;
    Ok(())
}
