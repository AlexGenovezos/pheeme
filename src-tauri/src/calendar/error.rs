//! What a Calendar write can fail with, as the command boundary reports it.

use crate::gmail::GmailError;

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    #[error("That event isn't available any more.")]
    NotFound,
    /// The calendar or event can't be changed by this account; the text says why.
    #[error("{0}")]
    ReadOnly(String),
    #[error("{0}")]
    Invalid(String),
    /// Google's etag no longer matched: the event changed elsewhere.
    #[error(
        "This event was changed somewhere else. Pheeme has loaded the latest version; make your change again."
    )]
    Conflict,
    #[error("You're offline; changes can't be saved.")]
    Offline,
    /// The request may have reached Google (timeout, dropped connection).
    #[error(
        "Pheeme couldn't confirm the change reached Google. Your calendar will show what Google has in a moment."
    )]
    Unconfirmed,
    /// Part of a change landed; the text names what is left.
    #[error("{0}")]
    Incomplete(String),
    #[error("Google Calendar refused the change: {}", google_message(.0))]
    Google(GmailError),
    #[error("Pheeme couldn't save that: {0}")]
    Db(anyhow::Error),
}

fn google_message(e: &GmailError) -> String {
    match e {
        GmailError::Api { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

impl CalendarError {
    pub fn code(&self) -> &str {
        match self {
            CalendarError::NotFound => "not_found",
            CalendarError::ReadOnly(_) => "read_only",
            CalendarError::Invalid(_) => "invalid_input",
            CalendarError::Conflict => "conflict",
            CalendarError::Offline => "network",
            CalendarError::Unconfirmed => "unconfirmed",
            CalendarError::Incomplete(_) => "incomplete",
            CalendarError::Google(e) => e.code(),
            CalendarError::Db(_) => "internal",
        }
    }
}

impl From<GmailError> for CalendarError {
    fn from(e: GmailError) -> Self {
        match e {
            GmailError::Offline(_) => CalendarError::Offline,
            GmailError::Network(_) => CalendarError::Unconfirmed,
            e if e.is_conflict() => CalendarError::Conflict,
            e if e.is_not_found() => CalendarError::NotFound,
            e => CalendarError::Google(e),
        }
    }
}

impl From<anyhow::Error> for CalendarError {
    fn from(e: anyhow::Error) -> Self {
        CalendarError::Db(e)
    }
}

impl From<sqlx::Error> for CalendarError {
    fn from(e: sqlx::Error) -> Self {
        CalendarError::Db(e.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16, message: &str) -> GmailError {
        GmailError::Api {
            status,
            reason: None,
            message: message.to_owned(),
        }
    }

    #[test]
    fn gmail_errors_map_to_calendar_codes() {
        let offline = CalendarError::from(GmailError::Offline("x".into()));
        assert!(matches!(offline, CalendarError::Offline));
        assert_eq!(offline.code(), "network");
        assert_eq!(
            offline.to_string(),
            "You're offline; changes can't be saved."
        );

        let net = CalendarError::from(GmailError::Network("x".into()));
        assert!(matches!(net, CalendarError::Unconfirmed));
        assert_eq!(net.code(), "unconfirmed");

        let conflict = CalendarError::from(api(412, "Precondition Failed"));
        assert!(matches!(conflict, CalendarError::Conflict));
        assert_eq!(conflict.code(), "conflict");

        let missing = CalendarError::from(api(404, "Not Found"));
        assert!(matches!(missing, CalendarError::NotFound));
        assert_eq!(missing.code(), "not_found");

        let other = CalendarError::from(api(500, "Backend Error"));
        assert_eq!(other.code(), "api");
        assert_eq!(
            other.to_string(),
            "Google Calendar refused the change: Backend Error"
        );
        let rate = CalendarError::from(GmailError::RateLimit { retry_after: None });
        assert_eq!(rate.code(), "rate_limit");
        assert!(rate
            .to_string()
            .starts_with("Google Calendar refused the change: rate limited"));
    }
}
