//! Send diagnostics: thin adapters over [`crate::support`].

use super::CommandError;
use crate::diagnostics::{PreviewReport, ShownTiming, WindowProblem};
use crate::support::email::EmailRequest;
use crate::support::{self, screenshot, Sources, SupportError};
use crate::AppState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use tauri::State;

/// Base64 from the window, decoded; anything that isn't base64 is refused.
fn decode(data: &str) -> Result<Vec<u8>, SupportError> {
    BASE64
        .decode(data)
        .map_err(|_| SupportError::Invalid("That image couldn't be read.".into()))
}

fn decode_all(screenshots: Option<Vec<String>>) -> Result<Vec<Vec<u8>>, SupportError> {
    screenshots
        .unwrap_or_default()
        .iter()
        .map(|s| decode(s))
        .collect()
}

async fn prepare(
    state: &AppState,
    note: &str,
    reply_to: Option<&str>,
    email: Option<EmailRequest>,
    screenshots: Option<Vec<String>>,
) -> Result<(support::upload::UploadMeta, Vec<u8>), CommandError> {
    let accounts = state.accounts.list_accounts().await?;
    let sources = Sources {
        db: &state.db,
        accounts: &accounts,
        quota_per_minute: state.gmail_quota.get(),
        opens: state.mail.recent_opens(),
        shown: state.mail.recent_shown(),
        log_dir: state.log_dir.clone(),
        email,
        screenshots: decode_all(screenshots)?,
    };
    Ok(support::prepare(sources, note, reply_to).await?)
}

/// Uploads a scrubbed diagnostics bundle to the developer, with the email on screen if asked.
#[tauri::command]
pub async fn send_diagnostics(
    state: State<'_, AppState>,
    note: String,
    reply_to: Option<String>,
    email: Option<EmailRequest>,
    screenshots: Option<Vec<String>>,
) -> Result<(), CommandError> {
    let (meta, zip) = prepare(&state, &note, reply_to.as_deref(), email, screenshots).await?;
    support::upload::send(&support::diagnostics_url(), &meta, zip).await?;
    tracing::info!("diagnostics sent");
    Ok(())
}

/// Writes the same bundle to `path` (chosen in the save dialog).
#[tauri::command]
pub async fn save_diagnostics(
    state: State<'_, AppState>,
    note: String,
    reply_to: Option<String>,
    path: String,
    email: Option<EmailRequest>,
    screenshots: Option<Vec<String>>,
) -> Result<(), CommandError> {
    let path = support::save_path(&path)?;
    let (_, zip) = prepare(&state, &note, reply_to.as_deref(), email, screenshots).await?;
    tokio::fs::write(&path, zip)
        .await
        .map_err(support::SupportError::from)?;
    Ok(())
}

/// A screenshot ready to send: the PNG written from the file's pixels, as base64.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotDto {
    pub png: String,
    pub width: u32,
    pub height: u32,
}

/// Checks a screenshot the user picked or pasted (base64 `data`) or dropped on the window (its
/// `path`; Tauri gives drops only as paths) and returns it cleaned ([`screenshot::clean`]): a PNG
/// or JPEG comes back as a fresh PNG, anything else is refused, so a path never reads out more
/// than the pixels of an image.
#[tauri::command]
pub async fn prepare_screenshot(
    data: Option<String>,
    path: Option<String>,
) -> Result<ScreenshotDto, CommandError> {
    let dropped = path.is_some();
    let bytes = match (data, path) {
        (Some(data), None) => decode(&data)?,
        (None, Some(path)) => read_dropped(&path).await?,
        _ => return Err(SupportError::Invalid("Add one screenshot at a time.".into()).into()),
    };
    let shot = match tokio::task::spawn_blocking(move || screenshot::clean(&bytes))
        .await
        .map_err(|e| SupportError::Internal(e.to_string()))?
    {
        // A path could name any file: it is refused in the same words whatever it holds.
        Err(SupportError::Invalid(_)) if dropped => Err(drop_refused()),
        shot => shot,
    }?;
    Ok(ScreenshotDto {
        png: BASE64.encode(&shot.png),
        width: shot.width,
        height: shot.height,
    })
}

/// The one answer to a dropped file that isn't a screenshot, whether it is missing, unreadable,
/// too big or not an image, so a drop can't tell what else is on the disk.
fn drop_refused() -> SupportError {
    SupportError::Invalid("That isn't a screenshot. Add a PNG or JPEG image under 25 MB.".into())
}

/// The file's bytes, if its name is a PNG's or JPEG's and it is a file small enough to clean.
async fn read_dropped(path: &str) -> Result<Vec<u8>, SupportError> {
    let image_name = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            ["png", "jpg", "jpeg"]
                .iter()
                .any(|x| e.eq_ignore_ascii_case(x))
        });
    if !image_name {
        return Err(drop_refused());
    }
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|_| drop_refused())?;
    if !meta.is_file() || meta.len() > screenshot::MAX_INPUT_BYTES as u64 {
        return Err(drop_refused());
    }
    tokio::fs::read(path).await.map_err(|_| drop_refused())
}

/// How long a picked conversation took to show in the window (`src/mail/openTiming.ts`).
#[tauri::command]
pub fn log_thread_shown(state: State<'_, AppState>, timing: ShownTiming) {
    state.mail.record_shown(timing);
}

/// How an attachment preview went (`src/mail/preview/trace.ts`).
#[tauri::command]
pub fn log_preview(report: PreviewReport) {
    report.log();
}

/// An uncaught error or a frozen window (`src/lib/windowProblems.ts`).
#[tauri::command]
pub fn log_window_problem(problem: WindowProblem) {
    problem.log();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(30, 20))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[tokio::test]
    async fn prepare_screenshot_takes_bytes_or_a_dropped_path() {
        let pasted = prepare_screenshot(Some(BASE64.encode(png())), None)
            .await
            .unwrap();
        assert_eq!((pasted.width, pasted.height), (30, 20));
        assert!(BASE64.decode(&pasted.png).unwrap().starts_with(b"\x89PNG"));

        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("shot.png");
        std::fs::write(&shot, png()).unwrap();
        let dropped = prepare_screenshot(None, Some(shot.to_string_lossy().into_owned()))
            .await
            .unwrap();
        assert_eq!(dropped.png, pasted.png);
    }

    #[tokio::test]
    async fn prepare_screenshot_refuses_what_isnt_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("shot.png");
        std::fs::write(&script, "#!/bin/sh\nrm -rf ~\n").unwrap();
        let path = |p: &std::path::Path| Some(p.to_string_lossy().into_owned());
        for (data, path) in [
            (Some(BASE64.encode("#!/bin/sh")), None),
            (Some("not base64!".to_owned()), None),
            (None, path(&script)),
            (None, path(dir.path())),
            (None, path(&dir.path().join("missing.png"))),
            (None, None),
            (Some(BASE64.encode(png())), path(&script)),
        ] {
            let e = prepare_screenshot(data, path).await.unwrap_err();
            assert_eq!(e.code, "invalid_input", "{}", e.message);
        }
    }

    #[tokio::test]
    async fn a_dropped_path_is_refused_in_the_same_words_whatever_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "secret").unwrap();
        let fake = dir.path().join("shot.png");
        std::fs::write(&fake, "not an image").unwrap();
        let big = dir.path().join("big.jpg");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(screenshot::MAX_INPUT_BYTES as u64 + 1)
            .unwrap();
        let mut messages = Vec::new();
        for path in [
            text,
            dir.path().join("missing.txt"),
            dir.path().join("missing.png"),
            fake,
            big,
            dir.path().to_path_buf(),
        ] {
            let path = Some(path.to_string_lossy().into_owned());
            messages.push(prepare_screenshot(None, path).await.unwrap_err().message);
        }
        assert!(messages.iter().all(|m| *m == messages[0]), "{messages:?}");
    }
}
