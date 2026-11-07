//! Update checks and installs run in the UI (the updater plugin's JS API); this writes
//! them to the diagnostics log, which the webview console can't reach in release builds.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateEvent {
    Available,
    UpToDate,
    CheckFailed,
    Installing,
    Installed,
    InstallFailed,
    ListenerFailed,
}

impl UpdateEvent {
    fn is_failure(self) -> bool {
        matches!(
            self,
            Self::CheckFailed | Self::InstallFailed | Self::ListenerFailed
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
