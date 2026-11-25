use super::{NotifyTarget, ThreadTarget};
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
/// Take away the new-mail notifications of these conversations, wherever they still show.
pub async fn dismiss(threads: &[ThreadTarget]) {
    if let Err(error) = native::dismiss(threads).await {
        tracing::warn!(%error, "Could not dismiss mail notifications");
    }
}
/// Conversations with a new-mail notification the OS still shows from an earlier launch. Linux
/// notification servers number notifications per connection, so they give none.
pub async fn delivered() -> Vec<ThreadTarget> {
    native::delivered().await.unwrap_or_else(|error| {
        tracing::warn!(%error, "Could not list delivered notifications");
        Vec::new()
    })
}
#[cfg(target_os = "linux")]
pub async fn tray_available() -> bool {
    native::tray_available().await
}

/// The identifier a conversation's notification carries on macOS, the same for every message in
/// it, so a new one replaces the last and reading the conversation can take it away.
#[cfg(any(target_os = "macos", test))]
pub(super) fn notification_id(thread: &ThreadTarget) -> String {
    format!("mail:{}:{}", thread.account_id, thread.thread_id)
}
/// The conversation of a [`notification_id`]; `None` for an event reminder's.
#[cfg(any(target_os = "macos", test))]
pub(super) fn thread_of(id: &str) -> Option<ThreadTarget> {
    // Gmail thread ids are hex, so the last colon ends the account id.
    let (account_id, thread_id) = id.strip_prefix("mail:")?.rsplit_once(':')?;
    (!account_id.is_empty() && !thread_id.is_empty()).then(|| ThreadTarget {
        account_id: account_id.into(),
        thread_id: thread_id.into(),
    })
}

/// A toast's XML: the title, the text, and a Join button for a call. Mail text is escaped.
#[cfg(any(target_os = "windows", test))]
pub(super) fn toast_xml(title: &str, body: &str, join: bool) -> String {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    };
    let actions = if join {
        r#"<actions><action content="Join" arguments="join"/></actions>"#
    } else {
        ""
    };
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text id="1">{}</text><text id="2">{}</text></binding></visual>{actions}</toast>"#,
        escape(title),
        escape(body)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_conversation_keeps_one_notification_id() {
        let thread = ThreadTarget {
            account_id: "0b6f2c1e-uuid:odd".into(),
            thread_id: "18c2f0a9d1e4b7a3".into(),
        };
        let id = notification_id(&thread);
        assert_eq!(thread_of(&id), Some(thread));
        assert_eq!(thread_of("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), None);
        assert_eq!(thread_of("mail:a:"), None);
    }

    #[test]
    fn mail_cannot_inject_toast_markup() {
        assert_eq!(
            toast_xml("A & B", "<b>\"hi\"</b> it's", false),
            r#"<toast><visual><binding template="ToastGeneric"><text id="1">A &amp; B</text><text id="2">&lt;b&gt;&quot;hi&quot;&lt;/b&gt; it&apos;s</text></binding></visual></toast>"#
        );
        assert!(toast_xml("Standup", "10:00", true)
            .ends_with(r#"<actions><action content="Join" arguments="join"/></actions></toast>"#));
    }
}
