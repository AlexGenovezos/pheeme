//! Attachment commands: previewing, prefetching, opening in the default app, saving to
//! Downloads and revealing the result.

use super::CommandError;
use crate::AppState;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

fn downloads_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path().download_dir().map_err(|_| CommandError {
        code: "internal".into(),
        message: "Couldn't find your Downloads folder.".into(),
    })
}

/// Saves an attachment into the Downloads folder and returns the file's absolute path.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<String, CommandError> {
    let dir = downloads_dir(&app)?;
    let path = state
        .mail
        .save_attachment(&account_id, &message_id, &attachment_id, &dir)
        .await?;
    Ok(path.to_string_lossy().into_owned())
}

/// An attachment's bytes for the preview panel, sent as a raw binary response (an
/// `ArrayBuffer` in the webview) rather than a JSON array of numbers.
#[tauri::command]
pub async fn read_attachment(
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, CommandError> {
    let att = state
        .mail
        .attachment(&account_id, &message_id, &attachment_id)
        .await?;
    Ok(tauri::ipc::Response::new(att.bytes))
}

/// Starts downloading the previewable attachments of an opened thread's messages into the
/// cache and returns at once; see [`crate::mail::MailService::prefetch_attachments`].
#[tauri::command]
pub fn prefetch_attachments(
    state: State<'_, AppState>,
    account_id: String,
    message_ids: Vec<String>,
) {
    let mail = state.mail.clone();
    tauri::async_runtime::spawn(async move {
        let fetched = mail.prefetch_attachments(&account_id, &message_ids).await;
        if fetched > 0 {
            tracing::debug!(fetched, "prefetched attachments");
        }
    });
}

/// Opens an attachment in the user's default app for its type, from a private copy in the
/// app's cache folder (documents and media only).
#[tauri::command]
pub async fn open_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<(), CommandError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| CommandError {
            code: "internal".into(),
            message: "Couldn't find Pheeme's cache folder.".into(),
        })?
        .join("opened");
    let path = state
        .mail
        .open_copy(&account_id, &message_id, &attachment_id, &dir)
        .await?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| CommandError {
        code: "open_failed".into(),
        message: format!("Couldn't open the file ({error})."),
    })
}

/// `path` canonicalized, if it names an existing file strictly inside `dir`.
pub fn path_inside(path: &Path, dir: &Path) -> Option<std::path::PathBuf> {
    let path = std::fs::canonicalize(path).ok()?;
    let dir = std::fs::canonicalize(dir).ok()?;
    (path != dir && path.starts_with(&dir)).then_some(path)
}

/// Shows a file saved by [`save_attachment`] in the system file manager. Only files inside
/// Downloads qualify, so the webview can't use this to probe or reveal other paths.
#[tauri::command]
pub fn reveal_download(app: AppHandle, path: String) -> Result<(), CommandError> {
    let dir = downloads_dir(&app)?;
    let Some(path) = path_inside(Path::new(&path), &dir) else {
        return Err(CommandError {
            code: "invalid_input".into(),
            message: "That file isn't in your Downloads folder.".into(),
        });
    };
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| CommandError {
        code: "open_failed".into(),
        message: format!("Couldn't show the file ({error})."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_is_limited_to_files_inside_the_downloads_dir() {
        let root = tempfile::tempdir().unwrap();
        let downloads = root.path().join("Downloads");
        std::fs::create_dir(&downloads).unwrap();
        std::fs::write(downloads.join("a.pdf"), "").unwrap();
        std::fs::write(root.path().join("secret.txt"), "").unwrap();

        assert!(path_inside(&downloads.join("a.pdf"), &downloads).is_some());
        assert!(path_inside(&downloads.join("../secret.txt"), &downloads).is_none());
        assert!(path_inside(&root.path().join("secret.txt"), &downloads).is_none());
        assert!(path_inside(&downloads, &downloads).is_none());
        assert!(path_inside(&downloads.join("missing.pdf"), &downloads).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("secret.txt"), downloads.join("link"))
                .unwrap();
            assert!(path_inside(&downloads.join("link"), &downloads).is_none());
        }
    }
}
