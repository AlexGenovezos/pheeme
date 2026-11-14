//! Tauri-free Drive workflows. Tokens and attachment bytes stay in the native process.

use crate::accounts::{AccountService, AccountTokens};
use crate::gmail::drive::{DriveFile, DrivePage};
use crate::gmail::{GmailClient, GmailError};
use crate::mail::{safe_file_name, MailError, MailService};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum DriveError {
    #[error("Allow Google Drive access to browse files and save attachments.")]
    MissingScope,
    #[error("Turn on the Google Drive API in your Google Cloud project, then try again.")]
    ApiDisabled,
    #[error("The upload couldn't be confirmed. Check My Drive before saving again; the file may already be there.")]
    Unconfirmed,
    #[error(transparent)]
    Mail(#[from] MailError),
    #[error("Google Drive: {0}")]
    Api(GmailError),
}

impl DriveError {
    pub fn code(&self) -> &str {
        match self {
            Self::MissingScope => "missing_scope",
            Self::ApiDisabled => "api_disabled",
            Self::Unconfirmed => "upload_unconfirmed",
            Self::Mail(e) => e.code(),
            Self::Api(e) => e.code(),
        }
    }
}

impl From<GmailError> for DriveError {
    fn from(e: GmailError) -> Self {
        if e.is_api_disabled() {
            Self::ApiDisabled
        } else if e.is_missing_scope() {
            Self::MissingScope
        } else {
            Self::Api(e)
        }
    }
}

pub struct DriveService {
    accounts: Arc<AccountService>,
    mail: MailService,
}

impl DriveService {
    pub fn new(accounts: Arc<AccountService>, mail: MailService) -> Self {
        Self { accounts, mail }
    }

    fn client(&self, account_id: &str) -> GmailClient {
        GmailClient::drive(Arc::new(AccountTokens::new(
            self.accounts.clone(),
            account_id,
        )))
    }

    pub async fn files(
        &self,
        account_id: &str,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<DrivePage, DriveError> {
        if query.len() > 1000 || page_token.is_some_and(|t| t.len() > 4096) {
            return Err(MailError::Invalid("That Drive search is too long.".into()).into());
        }
        Ok(self
            .client(account_id)
            .drive_files(query, page_token)
            .await?)
    }

    pub async fn save_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<DriveFile, DriveError> {
        // Probe Drive first, so lack of permission doesn't trigger a Gmail download.
        self.files(account_id, "", None).await?;
        let att = self
            .mail
            .attachment(account_id, message_id, attachment_id)
            .await?;
        let name = safe_file_name(att.filename.as_deref());
        self.client(account_id)
            .upload_drive_file(&name, &att.mime_type, &att.bytes)
            .await
            .map_err(|e| {
                if matches!(
                    e,
                    GmailError::Network(_)
                        | GmailError::Decode(_)
                        | GmailError::Api {
                            status: 500..=599,
                            ..
                        }
                ) {
                    DriveError::Unconfirmed
                } else {
                    e.into()
                }
            })
    }
}
