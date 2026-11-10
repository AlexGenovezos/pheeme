//! What a Tasks write can fail with, as the command boundary reports it.

use crate::gmail::GmailError;

#[derive(Debug, thiserror::Error)]
pub enum TasksError {
    #[error("That task isn't available any more.")]
    TaskNotFound,
    #[error("That task list isn't available any more.")]
    ListNotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("You're offline; changes can't be saved.")]
    Offline,
    /// The request may have reached Google (timeout, dropped connection).
    #[error(
        "Pheeme couldn't confirm the change reached Google. Your tasks will show what Google has in a moment."
    )]
    Unconfirmed,
    #[error("Google Tasks refused the change: {}", google_message(.0))]
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

impl TasksError {
    pub fn code(&self) -> &str {
        match self {
            TasksError::TaskNotFound | TasksError::ListNotFound => "not_found",
            TasksError::Invalid(_) => "invalid_input",
            TasksError::Offline => "network",
            TasksError::Unconfirmed => "unconfirmed",
            TasksError::Google(e) if e.is_api_disabled() => "api_disabled",
            TasksError::Google(e) => e.code(),
            TasksError::Db(_) => "internal",
        }
    }
}

impl From<GmailError> for TasksError {
    fn from(e: GmailError) -> Self {
        match e {
            GmailError::Offline(_) => TasksError::Offline,
            GmailError::Network(_) => TasksError::Unconfirmed,
            e if e.is_not_found() => TasksError::TaskNotFound,
            e => TasksError::Google(e),
        }
    }
}

impl From<anyhow::Error> for TasksError {
    fn from(e: anyhow::Error) -> Self {
        TasksError::Db(e)
    }
}

impl From<sqlx::Error> for TasksError {
    fn from(e: sqlx::Error) -> Self {
        TasksError::Db(e.into())
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
    fn gmail_errors_map_to_tasks_codes() {
        let offline = TasksError::from(GmailError::Offline("x".into()));
        assert_eq!(offline.code(), "network");
        assert_eq!(
            offline.to_string(),
            "You're offline; changes can't be saved."
        );
        assert_eq!(
            TasksError::from(GmailError::Network("x".into())).code(),
            "unconfirmed"
        );
        assert_eq!(
            TasksError::from(api(404, None, "Not Found")).code(),
            "not_found"
        );
        let disabled = TasksError::from(api(
            403,
            Some("SERVICE_DISABLED"),
            "Google Tasks API has not been used in project 123 before or it is disabled.",
        ));
        assert_eq!(disabled.code(), "api_disabled");
        let scope = TasksError::from(api(
            403,
            Some("insufficientPermissions"),
            "Request had insufficient authentication scopes.",
        ));
        assert_eq!(scope.code(), "missing_scope");
        let other = TasksError::from(api(400, None, "Invalid task list ID"));
        assert_eq!(other.code(), "api");
        assert_eq!(
            other.to_string(),
            "Google Tasks refused the change: Invalid task list ID"
        );
    }
}
