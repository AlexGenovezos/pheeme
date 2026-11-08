pub mod accounts;
pub mod attachments;
pub mod auth;
pub mod compose;
pub mod labels;
pub mod mods;
pub mod search;
pub mod sender_rules;
pub mod settings;
pub mod support;
pub mod sync;
pub mod threads;
pub mod transfer;
pub mod updater;

use crate::accounts::AccountError;
use crate::mail::MailError;
use crate::support::SupportError;
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

impl From<MailError> for CommandError {
    fn from(error: MailError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

impl From<SupportError> for CommandError {
    fn from(error: SupportError) -> Self {
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

/// Links in an email may open in the default app: web pages and mail composers only.
pub fn is_allowed_mail_link(url: &str) -> bool {
    parse_mail_link(url).is_some()
}

fn parse_mail_link(url: &str) -> Option<Url> {
    Url::parse(url)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
}

/// Opens a link from an email body in the default browser or mail app.
#[tauri::command]
pub fn open_mail_link(url: String) -> Result<(), CommandError> {
    let Some(url) = parse_mail_link(&url) else {
        return Err(CommandError {
            code: "invalid_input".into(),
            message: "Pheeme only opens web and email links.".into(),
        });
    };
    open_in_default_app(&url)
}

fn open_in_default_app(url: &Url) -> Result<(), CommandError> {
    open::that_detached(url.as_str()).map_err(|error| CommandError {
        code: "open_failed".into(),
        message: format!("Couldn't open that link ({error}). Copy it instead."),
    })
}

/// A navigation that leaves the app: a web or email link anywhere but the app's own pages (`tauri.localhost`
/// on Windows, the dev server on `localhost:1420`). Other `localhost` addresses count as external, so an
/// email can't load a local service inside the app.
///
/// WebKit (macOS, Linux) never runs the email frame's click handler: the frame is sandboxed without
/// scripts, and WebKit skips event listeners in a script-less document even when the parent added them.
/// A clicked link arrives as a navigation instead, so the webview cancels these and opens them here.
pub fn is_external_navigation(url: &Url) -> bool {
    parse_mail_link(url.as_str()).is_some()
        && !matches!(
            (url.scheme(), url.host_str(), url.port()),
            (_, Some("tauri.localhost"), None) | ("http", Some("localhost"), Some(1420))
        )
}

/// The webview's navigation hook: keeps external links out of the app and opens them in the default app.
/// Returns whether the navigation may go ahead.
pub fn allow_navigation(url: &Url) -> bool {
    if !is_external_navigation(url) {
        return true;
    }
    if let Err(error) = open_in_default_app(url) {
        tracing::warn!("couldn't open a link from the app: {}", error.message);
    }
    false
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
    fn mail_link_allow_list() {
        for ok in [
            "https://x",
            "http://x",
            "mailto:a@b",
            "HTTPS://Example.com/a?b=c",
        ] {
            assert!(is_allowed_mail_link(ok), "{ok}");
        }
        for bad in [
            "javascript:x",
            "file:///etc/passwd",
            "pheeme-att://x",
            "data:text/html,hi",
            "tel:123",
            "not a url",
            "",
        ] {
            assert!(!is_allowed_mail_link(bad), "{bad}");
        }
    }

    #[test]
    fn external_navigations_leave_the_app() {
        for external in [
            "https://search.app/1fX35K7LMcx7WJH86",
            "http://example.com/a?b=c",
            "mailto:a@b",
            "http://evil.localhost/",
            "http://localhost:8080/",
            "http://localhost/",
            "http://tauri.localhost:8080/",
            "https://localhost:1420/",
        ] {
            assert!(
                is_external_navigation(&Url::parse(external).unwrap()),
                "{external}"
            );
        }
        for internal in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://localhost:1420/",
            "about:srcdoc",
            "about:blank",
        ] {
            assert!(
                !is_external_navigation(&Url::parse(internal).unwrap()),
                "{internal}"
            );
        }
    }

    /// A clicked email link reaches `allow_navigation` only as a navigation of the email frame. WebKit
    /// checks that navigation against the app's `frame-src` first, and without `https:`/`http:` there
    /// it refuses the link before the hook is asked, so the click does nothing.
    #[test]
    fn csp_lets_email_links_reach_the_navigation_hook() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        for policy in ["csp", "devCsp"] {
            let frame_src = conf["app"]["security"][policy]["frame-src"]
                .as_str()
                .unwrap_or_default();
            for source in ["https:", "http:", "mailto:"] {
                assert!(
                    frame_src.split_whitespace().any(|s| s == source),
                    "{policy} frame-src lacks {source}"
                );
            }
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
