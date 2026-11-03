//! The slice of Gmail the sync engine uses, as a trait so tests can run it against
//! an in-memory mailbox ([`super::fake::FakeGmail`]).

use crate::gmail::types::{
    HistoryListResponse, Label, Message, MessageListResponse, Thread, ThreadListResponse,
};
use crate::gmail::{GmailClient, GmailError, MessageFormat};

#[async_trait::async_trait]
pub trait MailApi: Send + Sync {
    async fn profile_history_id(&self) -> Result<String, GmailError>;
    async fn list_labels(&self) -> Result<Vec<Label>, GmailError>;
    async fn get_label(&self, id: &str) -> Result<Label, GmailError>;
    async fn list_threads(
        &self,
        label: &str,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<ThreadListResponse, GmailError>;
    async fn get_thread(&self, id: &str, format: MessageFormat) -> Result<Thread, GmailError>;
    /// Every message, spam and trash included, newest first.
    async fn list_messages(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError>;
    async fn search_messages(&self, q: &str) -> Result<MessageListResponse, GmailError>;
    /// Results in any order; match on the id.
    async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)>;
    async fn list_history(
        &self,
        start: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryListResponse, GmailError>;
    async fn batch_modify(
        &self,
        ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<(), GmailError>;
    async fn trash_message(&self, id: &str) -> Result<(), GmailError>;
    /// Send a base64url RFC 2822 message; returns the Gmail message id.
    async fn send_message(&self, raw: &str) -> Result<String, GmailError>;
}

#[async_trait::async_trait]
impl MailApi for GmailClient {
    async fn profile_history_id(&self) -> Result<String, GmailError> {
        Ok(self.get_profile().await?.history_id)
    }

    async fn list_labels(&self) -> Result<Vec<Label>, GmailError> {
        GmailClient::list_labels(self).await
    }

    async fn get_label(&self, id: &str) -> Result<Label, GmailError> {
        GmailClient::get_label(self, id).await
    }

    async fn list_threads(
        &self,
        label: &str,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<ThreadListResponse, GmailError> {
        GmailClient::list_threads(self, &[label], page_token, max).await
    }

    async fn get_thread(&self, id: &str, format: MessageFormat) -> Result<Thread, GmailError> {
        GmailClient::get_thread(self, id, format).await
    }

    async fn list_messages(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        self.list_all_messages(page_token, max).await
    }

    async fn search_messages(&self, q: &str) -> Result<MessageListResponse, GmailError> {
        GmailClient::search_messages(self, q, None, 10).await
    }

    async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        GmailClient::batch_get_messages(self, ids, format).await
    }

    async fn list_history(
        &self,
        start: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryListResponse, GmailError> {
        GmailClient::list_history(self, start, None, page_token).await
    }

    async fn batch_modify(
        &self,
        ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<(), GmailError> {
        self.batch_modify_messages(ids, add, remove).await
    }

    async fn trash_message(&self, id: &str) -> Result<(), GmailError> {
        GmailClient::trash_message(self, id).await.map(|_| ())
    }

    async fn send_message(&self, raw: &str) -> Result<String, GmailError> {
        Ok(GmailClient::send_message(self, raw).await?.id)
    }
}
