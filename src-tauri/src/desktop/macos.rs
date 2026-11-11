//! Small C bridge to UserNotifications: real authorization and asynchronous click delivery.
use super::super::{activate, NotifyTarget};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;
use tauri::AppHandle;
use tokio::sync::oneshot;

static APP: OnceLock<AppHandle> = OnceLock::new();
extern "C" {
    fn pheeme_notifications_init(click: extern "C" fn(*const c_char));
    fn pheeme_notifications_permission(
        request: bool,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
    fn pheeme_notifications_show(
        title: *const c_char,
        body: *const c_char,
        target: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
}

extern "C" fn clicked(raw: *const c_char) {
    // The bridge passes a valid, NUL-terminated UTF-8 target for the duration of this call.
    let target = unsafe { CStr::from_ptr(raw) }
        .to_str()
        .ok()
        .and_then(|s| serde_json::from_str::<NotifyTarget>(s).ok());
    if let (Some(app), Some(target)) = (APP.get(), target) {
        activate(app, target);
    }
}

extern "C" fn completed(context: *mut c_void, result: i32) {
    // Exactly one native callback takes ownership of this sender, including error paths.
    let tx = unsafe { Box::from_raw(context.cast::<oneshot::Sender<i32>>()) };
    let _ = tx.send(result);
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    unsafe {
        pheeme_notifications_init(clicked);
    }
}

pub async fn permission(request: bool) -> anyhow::Result<String> {
    let (tx, rx) = oneshot::channel::<i32>();
    let context = Box::into_raw(Box::new(tx)).cast();
    unsafe {
        pheeme_notifications_permission(request, context, completed);
    }
    Ok(match rx.await? {
        0 => "notDetermined",
        1 => "denied",
        2 | 3 | 4 => "granted",
        _ => {
            anyhow::bail!("Couldn't read notification authorization. Use an installed Pheeme app.")
        }
    }
    .into())
}

pub async fn show(
    _: &AppHandle,
    target: NotifyTarget,
    title: String,
    body: String,
) -> anyhow::Result<()> {
    let title = CString::new(title)?;
    let body = CString::new(body)?;
    let target = CString::new(serde_json::to_string(&target)?)?;
    let (tx, rx) = oneshot::channel::<i32>();
    let context = Box::into_raw(Box::new(tx)).cast();
    // The bridge copies all three strings synchronously before returning.
    unsafe {
        pheeme_notifications_show(
            title.as_ptr(),
            body.as_ptr(),
            target.as_ptr(),
            context,
            completed,
        );
    }
    anyhow::ensure!(rx.await? == 0, "Notification delivery failed");
    Ok(())
}
