pub mod accounts;
pub mod auth;
pub mod labels;
pub mod messages;
pub mod search;
pub mod settings;
pub mod threads;

use crate::accounts::AccountError;
use reqwest::Url;
use serde::Serialize;

/// What the frontend receives on failure: a stable `code` to branch on and a
/// plain-language `message` to show.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<AccountError> for CommandError {
    fn from(error: AccountError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

/// Hosts the app may open in the user's browser: Google sign-in, the Cloud
/// Console pages the setup guide links to, and the project's own pages.
const EXTERNAL_HOSTS: &[&str] = &[
    "accounts.google.com",
    "console.cloud.google.com",
    "myaccount.google.com",
    "support.google.com",
    "github.com",
    "pheeme.app",
];

pub fn is_allowed_external_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url
                .host_str()
                .is_some_and(|host| EXTERNAL_HOSTS.contains(&host))
    })
}

/// Opens an allow-listed https URL in the default browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), CommandError> {
    if !is_allowed_external_url(&url) {
        return Err(CommandError {
            code: "invalid_input".into(),
            message: "Pheeme only opens Google and Pheeme links.".into(),
        });
    }
    open::that_detached(&url).map_err(|error| CommandError {
        code: "open_failed".into(),
        message: format!("Couldn't open your browser ({error}). Copy the link instead."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_allow_list() {
        for ok in [
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
            "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
            "https://github.com/AlexGenovezos/pheeme",
        ] {
            assert!(is_allowed_external_url(ok), "{ok}");
        }
        for bad in [
            "http://accounts.google.com/",
            "https://accounts.google.com.evil.com/",
            "https://evil.com/?accounts.google.com",
            "https://user@accounts.google.com/",
            "https://accounts.google.com:8443/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(!is_allowed_external_url(bad), "{bad}");
        }
    }

    #[test]
    fn command_error_carries_code_and_plain_message() {
        let error = CommandError::from(AccountError::NotFound);
        assert_eq!(error.code, "not_found");
        assert_eq!(error.message, "That account isn't connected any more.");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code": "not_found", "message": "That account isn't connected any more."})
        );
    }
}
