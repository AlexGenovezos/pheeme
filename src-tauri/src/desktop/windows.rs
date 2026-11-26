//! Toasts through the WinRT notification API. A conversation's toast carries its thread id as
//! tag and its account as group, so a new message replaces it and reading it takes it away. An
//! event's reminders share a tag in the event group, so each replaces the one before.
use super::super::{activate, join_call, NotifyTarget, ThreadTarget};
use tauri::AppHandle;
use windows::core::{Interface, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};

pub fn init(_: &AppHandle) {}
pub async fn permission(_: bool) -> anyhow::Result<String> {
    Ok("system".into())
}

fn app_id() -> HSTRING {
    // Pheeme's installer-created identity.
    HSTRING::from(crate::identity::APP_IDENTIFIER)
}

pub async fn show(
    app: &AppHandle,
    target: NotifyTarget,
    title: String,
    body: String,
    join: Option<String>,
) -> anyhow::Result<()> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(super::toast_xml(
        &title,
        &body,
        join.is_some(),
    )))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    match &target {
        NotifyTarget::Thread(thread) => {
            toast.SetTag(&HSTRING::from(&thread.thread_id))?;
            toast.SetGroup(&HSTRING::from(&thread.account_id))?;
        }
        NotifyTarget::Event(event) => {
            toast.SetTag(&HSTRING::from(super::event_tag(event)))?;
            toast.SetGroup(&HSTRING::from(super::EVENT_GROUP))?;
        }
    }
    let app = app.clone();
    toast.Activated(&TypedEventHandler::new(
        move |_, args: windows::core::Ref<'_, windows::core::IInspectable>| {
            // The Join button's argument; a click on the toast itself has none.
            let action = args
                .ok()
                .ok()
                .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|args| args.Arguments().ok())
                .map(|arguments| arguments.to_string_lossy());
            match (action.as_deref(), &join) {
                (Some("join"), Some(url)) => join_call(url),
                _ => activate(&app, target.clone()),
            }
            Ok(())
        },
    ))?;
    // No high-priority toast or DND bypass.
    ToastNotificationManager::CreateToastNotifierWithId(&app_id())?.Show(&toast)?;
    Ok(())
}

pub async fn dismiss(threads: &[ThreadTarget]) -> anyhow::Result<()> {
    let history = ToastNotificationManager::History()?;
    for thread in threads {
        history.RemoveGroupedTagWithId(
            &HSTRING::from(&thread.thread_id),
            &HSTRING::from(&thread.account_id),
            &app_id(),
        )?;
    }
    Ok(())
}

pub async fn delivered() -> anyhow::Result<Vec<ThreadTarget>> {
    let toasts = ToastNotificationManager::History()?.GetHistoryWithId(&app_id())?;
    let mut threads = Vec::new();
    for i in 0..toasts.Size()? {
        let toast = toasts.GetAt(i)?;
        let (tag, group) = (toast.Tag()?, toast.Group()?);
        // Event reminders carry the event group (older ones no tag).
        if !tag.is_empty() && !group.is_empty() && group.to_string_lossy() != super::EVENT_GROUP {
            threads.push(ThreadTarget {
                account_id: group.to_string_lossy(),
                thread_id: tag.to_string_lossy(),
            });
        }
    }
    Ok(threads)
}
