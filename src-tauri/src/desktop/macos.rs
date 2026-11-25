//! Small C bridge to UserNotifications: real authorization and asynchronous click delivery.
use super::super::{activate, join_call, NotifyTarget, ThreadTarget};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;
use tauri::AppHandle;
use tokio::sync::oneshot;

static APP: OnceLock<AppHandle> = OnceLock::new();
extern "C" {
    fn pheeme_notifications_init(
        click: extern "C" fn(*const c_char),
        join: extern "C" fn(*const c_char),
    );
    fn pheeme_notifications_permission(
        request: bool,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
    fn pheeme_notifications_show(
        title: *const c_char,
        body: *const c_char,
        target: *const c_char,
        identifier: *const c_char,
        join: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
    fn pheeme_notifications_remove(identifiers: *const *const c_char, count: usize);
    fn pheeme_notifications_delivered(
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_char),
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

extern "C" fn joined(raw: *const c_char) {
    // The bridge passes a valid, NUL-terminated UTF-8 link for the duration of this call.
    if let Ok(url) = unsafe { CStr::from_ptr(raw) }.to_str() {
        join_call(url);
    }
}

extern "C" fn completed(context: *mut c_void, result: i32) {
    // Exactly one native callback takes ownership of this sender, including error paths.
    let tx = unsafe { Box::from_raw(context.cast::<oneshot::Sender<i32>>()) };
    let _ = tx.send(result);
}

extern "C" fn listed(context: *mut c_void, raw: *const c_char) {
    // Called exactly once; the list (a valid, NUL-terminated string, or NULL) lives for the call.
    let tx = unsafe { Box::from_raw(context.cast::<oneshot::Sender<Option<String>>>()) };
    let list = (!raw.is_null())
        .then(|| {
            unsafe { CStr::from_ptr(raw) }
                .to_str()
                .ok()
                .map(str::to_owned)
        })
        .flatten();
    let _ = tx.send(list);
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    unsafe {
        pheeme_notifications_init(clicked, joined);
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
    join: Option<String>,
) -> anyhow::Result<()> {
    let title = CString::new(title)?;
    let join = join.map(CString::new).transpose()?;
    let body = CString::new(body)?;
    let identifier = match &target {
        NotifyTarget::Thread(mail) => Some(CString::new(super::notification_id(&mail.thread()))?),
        NotifyTarget::Event(_) => None,
    };
    let target = CString::new(serde_json::to_string(&target)?)?;
    let (tx, rx) = oneshot::channel::<i32>();
    let context = Box::into_raw(Box::new(tx)).cast();
    // The bridge copies all the strings synchronously before returning.
    unsafe {
        pheeme_notifications_show(
            title.as_ptr(),
            body.as_ptr(),
            target.as_ptr(),
            identifier.as_ref().map_or(std::ptr::null(), |i| i.as_ptr()),
            join.as_ref().map_or(std::ptr::null(), |j| j.as_ptr()),
            context,
            completed,
        );
    }
    anyhow::ensure!(rx.await? == 0, "Notification delivery failed");
    Ok(())
}

pub async fn dismiss(threads: &[ThreadTarget]) -> anyhow::Result<()> {
    let ids = threads
        .iter()
        .map(|t| CString::new(super::notification_id(t)))
        .collect::<Result<Vec<_>, _>>()?;
    let pointers: Vec<*const c_char> = ids.iter().map(|id| id.as_ptr()).collect();
    // The bridge copies the strings before returning.
    unsafe {
        pheeme_notifications_remove(pointers.as_ptr(), pointers.len());
    }
    Ok(())
}

pub async fn delivered() -> anyhow::Result<Vec<ThreadTarget>> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    let context = Box::into_raw(Box::new(tx)).cast();
    unsafe {
        pheeme_notifications_delivered(context, listed);
    }
    let json = rx
        .await?
        .ok_or_else(|| anyhow::anyhow!("Notification Center didn't list its notifications"))?;
    let ids: Vec<String> = serde_json::from_str(&json)?;
    Ok(ids.iter().filter_map(|id| super::thread_of(id)).collect())
}
