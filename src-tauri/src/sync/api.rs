//! The slice of Gmail the sync engine uses, as a trait so tests can run it against
//! an in-memory mailbox ([`super::fake::FakeGmail`]).

use crate::gmail::types::{
    Draft, DraftListResponse, HistoryListResponse, Label, LabelColor, LabelUpdate, Message,
    MessageListResponse, Thread, ThreadListResponse, UserProfile,
};
use crate::gmail::{GmailClient, GmailError, MessageFormat};

#[async_trait::async_trait]
pub trait MailApi: Send + Sync {
    async fn profile(&self) -> Result<UserProfile, GmailError>;
    /// [`Self::profile`] for the backfill (see [`Self::backfill_list_messages`]).
    async fn backfill_profile(&self) -> Result<UserProfile, GmailError>;
    async fn list_labels(&self) -> Result<Vec<Label>, GmailError>;
    async fn get_label(&self, id: &str) -> Result<Label, GmailError>;
    async fn create_label(
        &self,
        name: &str,
        color: Option<LabelColor>,
    ) -> Result<Label, GmailError>;
    /// Patch: only the `Some` fields of `update` change.
    async fn update_label(&self, id: &str, update: LabelUpdate) -> Result<Label, GmailError>;
    /// PUT the whole label; a `None` colour removes the label's colour.
    async fn replace_label(&self, label: &Label) -> Result<Label, GmailError>;
    async fn delete_label(&self, id: &str) -> Result<(), GmailError>;
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
    /// One page of messages matching a Gmail search (`q`), newest first. Spam and Trash
    /// are only searched with `include_spam_trash`.
    async fn search_messages(
        &self,
        q: &str,
        include_spam_trash: bool,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError>;
    /// Results in any order; match on the id.
    async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)>;
    /// [`Self::list_messages`] for the backfill: bulk work that yields to everything else and
    /// returns Gmail's first rate limit instead of retrying it.
    async fn backfill_list_messages(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        self.list_messages(page_token, max).await
    }
    /// [`Self::batch_get_messages`] for the backfill (see [`Self::backfill_list_messages`]).
    async fn backfill_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        self.batch_get_messages(ids, format).await
    }
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
    /// Send an RFC 2822 message (in `thread_id` for a reply); returns the Gmail message id.
    async fn send_message(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError>;
    /// Download an attachment's bytes (`attachment_id` is Gmail's, not the row id).
    async fn get_attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError>;
    async fn list_drafts(&self, page_token: Option<&str>) -> Result<DraftListResponse, GmailError>;
    /// A draft with its message in `format=full`.
    async fn get_draft(&self, id: &str) -> Result<Draft, GmailError>;
    async fn create_draft(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError>;
    async fn update_draft(
        &self,
        id: &str,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError>;
    async fn delete_draft(&self, id: &str) -> Result<(), GmailError>;
    /// Send a draft as saved; returns the sent message id.
    async fn send_draft(&self, id: &str) -> Result<String, GmailError>;
}

#[async_trait::async_trait]
impl MailApi for GmailClient {
    async fn profile(&self) -> Result<UserProfile, GmailError> {
        self.get_profile().await
    }

    async fn backfill_profile(&self) -> Result<UserProfile, GmailError> {
        GmailClient::backfill_profile(self).await
    }

    async fn list_labels(&self) -> Result<Vec<Label>, GmailError> {
        GmailClient::list_labels(self).await
    }

    async fn get_label(&self, id: &str) -> Result<Label, GmailError> {
        GmailClient::get_label(self, id).await
    }

    async fn create_label(
        &self,
        name: &str,
        color: Option<LabelColor>,
    ) -> Result<Label, GmailError> {
        GmailClient::create_label(self, name, color).await
    }

    async fn update_label(&self, id: &str, update: LabelUpdate) -> Result<Label, GmailError> {
        GmailClient::update_label(self, id, update).await
    }

    async fn replace_label(&self, label: &Label) -> Result<Label, GmailError> {
        GmailClient::replace_label(self, label).await
    }

    async fn delete_label(&self, id: &str) -> Result<(), GmailError> {
        GmailClient::delete_label(self, id).await
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

    async fn search_messages(
        &self,
        q: &str,
        include_spam_trash: bool,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        GmailClient::search_messages(self, q, include_spam_trash, page_token, max).await
    }

    async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        GmailClient::batch_get_messages(self, ids, format).await
    }

    async fn backfill_list_messages(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        GmailClient::backfill_list_messages(self, page_token, max).await
    }

    async fn backfill_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        GmailClient::backfill_get_messages(self, ids, format).await
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

    async fn send_message(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError> {
        Ok(GmailClient::send_message(self, rfc822, thread_id).await?.id)
    }

    async fn get_attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError> {
        GmailClient::get_attachment(self, message_id, attachment_id).await
    }

    async fn list_drafts(&self, page_token: Option<&str>) -> Result<DraftListResponse, GmailError> {
        GmailClient::list_drafts(self, page_token, 500).await
    }

    async fn get_draft(&self, id: &str) -> Result<Draft, GmailError> {
        GmailClient::get_draft(self, id, MessageFormat::Full).await
    }

    async fn create_draft(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        GmailClient::create_draft(self, rfc822, thread_id).await
    }

    async fn update_draft(
        &self,
        id: &str,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        GmailClient::update_draft(self, id, rfc822, thread_id).await
    }

    async fn delete_draft(&self, id: &str) -> Result<(), GmailError> {
        GmailClient::delete_draft(self, id).await
    }

    async fn send_draft(&self, id: &str) -> Result<String, GmailError> {
        Ok(GmailClient::send_draft(self, id).await?.id)
    }
}
