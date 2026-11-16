//! Update checks and installs run in the UI (the updater plugin's JS API); this writes
//! them to the diagnostics log, which the webview console can't reach in release builds,
//! and keeps the window hidden across an update's automatic restart from the tray.

use super::CommandError;
use crate::AppState;
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State};

/// How long a "start hidden" request waits for the restart it was made for.
const START_HIDDEN_FOR_MS: i64 = 5 * 60 * 1000;

/// Whether this launch is an update's restart from the tray, which keeps the window hidden.
/// Managed in `setup` once the database is open; absent when startup failed.
pub struct LaunchHidden(pub bool);

/// True when the window should stay hidden at launch (see [`LaunchHidden`]).
pub fn launch_is_hidden<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<LaunchHidden>()
        .is_some_and(|hidden| hidden.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateEvent {
    Available,
    UpToDate,
    CheckFailed,
    Downloaded,
    DownloadFailed,
    AutoRestart,
    Installing,
    Installed,
    InstallFailed,
    ListenerFailed,
}

impl UpdateEvent {
    fn is_failure(self) -> bool {
        matches!(
            self,
            Self::CheckFailed | Self::DownloadFailed | Self::InstallFailed | Self::ListenerFailed
        )
    }
}

/// The UI sends whatever the plugin returned; keep a runaway string out of the log.
fn clip(text: &str, max_chars: usize) -> &str {
    text.char_indices()
        .nth(max_chars)
        .map_or(text, |(end, _)| &text[..end])
}

/// Logs one updater step with the running version, e.g. `event=Installing current="0.14.0" version="0.15.0"`.
#[tauri::command]
pub fn log_update(event: UpdateEvent, version: Option<String>, error: Option<String>) {
    let current = env!("CARGO_PKG_VERSION");
    let version = version.as_deref().map(|v| clip(v, 32));
    let error = error.as_deref().map(|e| clip(e, 500));
    if event.is_failure() {
        tracing::warn!(?event, current, version, error, "update");
    } else {
        tracing::info!(?event, current, version, "update");
    }
}

/// Keep the window hidden on the next launch, if it comes within a few minutes: called just
/// before an update restarts Pheeme while it sits in the tray.
#[tauri::command]
pub async fn start_hidden_next_launch(state: State<'_, AppState>) -> Result<(), CommandError> {
    let until = crate::sync::engine::now_ms() + START_HIDDEN_FOR_MS;
    crate::db::settings::set_start_hidden_until(&state.db, until)
        .await
        .map_err(|error| CommandError {
            code: "start_hidden".into(),
            message: error.to_string(),
        })
}

/// Whether this launch keeps the window hidden: the UI then doesn't show it.
#[tauri::command]
pub fn launch_hidden(app: AppHandle) -> bool {
    launch_is_hidden(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_use_the_ui_names() {
        let parse = |s: &str| serde_json::from_value::<UpdateEvent>(serde_json::json!(s)).unwrap();
        // Must match `UpdateEvent` in src/lib/tauri.ts: a mismatch rejects the invoke silently.
        let names = [
            ("available", UpdateEvent::Available),
            ("up_to_date", UpdateEvent::UpToDate),
            ("check_failed", UpdateEvent::CheckFailed),
            ("downloaded", UpdateEvent::Downloaded),
            ("download_failed", UpdateEvent::DownloadFailed),
            ("auto_restart", UpdateEvent::AutoRestart),
            ("installing", UpdateEvent::Installing),
            ("installed", UpdateEvent::Installed),
            ("install_failed", UpdateEvent::InstallFailed),
            ("listener_failed", UpdateEvent::ListenerFailed),
        ];
        for (name, event) in names {
            assert_eq!(parse(name), event);
        }
        assert!(serde_json::from_value::<UpdateEvent>(serde_json::json!("other")).is_err());
    }

    #[test]
    fn clip_keeps_short_text_and_cuts_on_a_char_boundary() {
        assert_eq!(clip("0.15.0", 32), "0.15.0");
        assert_eq!(clip("ééé", 2), "éé");
    }
}
