//! Error type for the Gmail client.

use std::time::Duration;

/// `reason` that `list_history` stamps on a 404, meaning the start history id is no longer valid.
pub(crate) const HISTORY_EXPIRED_REASON: &str = "historyIdExpired";

#[derive(Debug, thiserror::Error)]
pub enum GmailError {
    /// The token provider failed, or Gmail still answered 401 after a refresh.
    #[error("authentication failed: {0}")]
    Auth(String),
    /// Google no longer accepts the account's saved sign-in: only signing in again fixes it.
    #[error("{0}")]
    SignedOut(String),
    /// Timeout, connection failure or a broken response stream, after retries.
    /// The request may have reached Gmail (timeout, dropped connection): its effect is unknown.
    #[error("network error: {0}")]
    Network(String),
    /// The request never reached Gmail (connection refused, DNS, offline): safe to retry.
    #[error("can't reach Gmail: {0}")]
    Offline(String),
    /// HTTP 429 (or a 403 rate-limit reason) that outlasted the retry budget.
    #[error("rate limited by Gmail{}", retry_after_suffix(.retry_after))]
    RateLimit { retry_after: Option<Duration> },
    /// Any other non-success response from the Gmail API.
    #[error("Gmail API error {status}{}: {message}", reason_suffix(.reason))]
    Api {
        status: u16,
        reason: Option<String>,
        message: String,
    },
    /// A response or message that could not be parsed.
    #[error("could not decode Gmail data: {0}")]
    Decode(String),
}

fn retry_after_suffix(retry_after: &Option<Duration>) -> String {
    match retry_after {
        Some(d) => format!(" (retry after {}s)", d.as_secs()),
        None => String::new(),
    }
}

fn reason_suffix(reason: &Option<String>) -> String {
    match reason {
        Some(r) => format!(" ({r})"),
        None => String::new(),
    }
}

impl GmailError {
    /// Stable snake_case code for the command boundary.
    pub fn code(&self) -> &str {
        if self.is_history_expired() {
            return "history_expired";
        }
        if self.is_missing_scope() {
            return "missing_scope";
        }
        match self {
            GmailError::Auth(_) => "auth",
            GmailError::SignedOut(_) => "signed_out",
            GmailError::Network(_) | GmailError::Offline(_) => "network",
            GmailError::RateLimit { .. } => "rate_limit",
            GmailError::Api { status: 404, .. } => "not_found",
            GmailError::Api { .. } => "api",
            GmailError::Decode(_) => "decode",
        }
    }

    /// The API answered 404 (the message, thread, label or draft does not exist).
    pub fn is_not_found(&self) -> bool {
        matches!(self, GmailError::Api { status: 404, .. })
    }

    /// Gmail refused because the account didn't grant the scope this call needs (an account that
    /// signed in before Pheeme asked for it, or a user who unticked it on Google's consent screen).
    pub fn is_missing_scope(&self) -> bool {
        match self {
            GmailError::Api {
                status: 403,
                reason,
                message,
            } => {
                matches!(
                    reason.as_deref(),
                    Some("insufficientPermissions" | "ACCESS_TOKEN_SCOPE_INSUFFICIENT")
                ) || message
                    .to_ascii_lowercase()
                    .contains("insufficient authentication scopes")
            }
            _ => false,
        }
    }

    /// `history.list` rejected the start history id because Gmail no longer keeps that far back.
    /// The sync engine answers this with a full re-sync.
    pub fn is_history_expired(&self) -> bool {
        match self {
            GmailError::Api {
                status,
                reason,
                message,
            } => {
                reason.as_deref() == Some(HISTORY_EXPIRED_REASON)
                    || (matches!(*status, 400 | 404)
                        && (reason.as_deref() == Some("failedPrecondition")
                            || message.to_ascii_lowercase().contains("starthistoryid")))
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16, reason: Option<&str>, message: &str) -> GmailError {
        GmailError::Api {
            status,
            reason: reason.map(str::to_owned),
            message: message.to_owned(),
        }
    }

    #[test]
    fn history_expired_detection() {
        assert!(api(404, Some("failedPrecondition"), "x").is_history_expired());
        assert!(api(404, None, "Invalid startHistoryId: 123").is_history_expired());
        assert!(api(404, Some(HISTORY_EXPIRED_REASON), "x").is_history_expired());
        assert!(
            !api(404, Some("notFound"), "Requested entity was not found.").is_history_expired()
        );
        assert!(!api(500, None, "startHistoryId").is_history_expired());
        assert!(!GmailError::Network("x".into()).is_history_expired());
    }

    #[test]
    fn codes_are_stable() {
        assert_eq!(GmailError::Auth("x".into()).code(), "auth");
        assert_eq!(GmailError::SignedOut("x".into()).code(), "signed_out");
        assert_eq!(GmailError::Network("x".into()).code(), "network");
        assert_eq!(GmailError::Offline("x".into()).code(), "network");
        assert_eq!(
            GmailError::RateLimit { retry_after: None }.code(),
            "rate_limit"
        );
        assert_eq!(api(404, None, "x").code(), "not_found");
        assert_eq!(api(403, None, "x").code(), "api");
        assert_eq!(GmailError::Decode("x".into()).code(), "decode");
        assert_eq!(
            api(404, None, "Invalid startHistoryId").code(),
            "history_expired"
        );
        assert!(api(404, None, "x").is_not_found());
    }

    #[test]
    fn missing_scope_detection() {
        assert_eq!(
            api(
                403,
                Some("insufficientPermissions"),
                "Insufficient Permission"
            )
            .code(),
            "missing_scope"
        );
        assert!(
            api(403, None, "Request had insufficient authentication scopes.").is_missing_scope()
        );
        assert!(!api(403, Some("forbidden"), "x").is_missing_scope());
        assert!(!api(400, Some("insufficientPermissions"), "x").is_missing_scope());
    }
}
