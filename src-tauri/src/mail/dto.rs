//! What mail reads hand to the UI: thread and message DTOs, labels and counts, and the
//! conversions from the database rows.

use crate::db::attachments::DbAttachment;
use crate::db::labels;
use crate::db::messages::{parse_labels, DbMessage};
use crate::db::threads::{self, DbThread, ThreadCursor};
use crate::gmail::mime::EmailAddress;
use crate::gmail::GmailError;
use crate::sync::engine::SyncError;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursorDto {
    pub last_message_date: i64,
    pub account_id: String,
    pub thread_id: String,
}

impl From<ThreadCursorDto> for ThreadCursor {
    fn from(c: ThreadCursorDto) -> Self {
        Self {
            last_message_date: c.last_message_date,
            account_id: c.account_id,
            thread_id: c.thread_id,
        }
    }
}

impl From<ThreadCursor> for ThreadCursorDto {
    fn from(c: ThreadCursor) -> Self {
        Self {
            last_message_date: c.last_message_date,
            account_id: c.account_id,
            thread_id: c.thread_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummaryDto {
    pub id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    /// Milliseconds since the epoch; 0 when unknown.
    pub date: i64,
    pub unread: bool,
    pub starred: bool,
    pub has_attachment: bool,
    pub message_count: i64,
    /// The thread's user labels (not system labels), sorted by label name.
    pub label_ids: Vec<String>,
    /// The thread's system labels (INBOX, CATEGORY_*, SPAM, TRASH, SENT…), sorted, so a row
    /// can say where the conversation sits.
    pub system_label_ids: Vec<String>,
}

impl From<DbThread> for ThreadSummaryDto {
    fn from(t: DbThread) -> Self {
        Self {
            id: t.id,
            account_id: t.account_id,
            subject: t.subject,
            snippet: t.snippet,
            from_name: t.from_name,
            from_address: t.from_address,
            date: t.last_message_date.unwrap_or(0),
            unread: t.unread_count > 0,
            starred: t.is_starred != 0,
            has_attachment: t.has_attachment != 0,
            message_count: t.message_count,
            label_ids: Vec::new(),
            system_label_ids: Vec::new(),
        }
    }
}

/// Summaries of `threads`, each with its user label ids, from one query for the whole page.
pub(super) async fn summaries(
    db: &SqlitePool,
    threads: Vec<DbThread>,
) -> anyhow::Result<Vec<ThreadSummaryDto>> {
    let keys: Vec<(String, String)> = threads
        .iter()
        .map(|t| (t.account_id.clone(), t.id.clone()))
        .collect();
    let mut by_thread = labels::user_label_ids_for(db, &keys).await?;
    let mut system = threads::system_label_ids_for(db, &keys).await?;
    Ok(threads
        .into_iter()
        .map(|t| {
            let key = (t.account_id.clone(), t.id.clone());
            let mut dto = ThreadSummaryDto::from(t);
            dto.label_ids = by_thread.remove(&key).unwrap_or_default();
            dto.system_label_ids = system.remove(&key).unwrap_or_default();
            dto
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPageDto {
    pub threads: Vec<ThreadSummaryDto>,
    pub next: Option<ThreadCursorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetailDto {
    pub id: String,
    pub thread_id: String,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
    /// Sanitized HTML fragment (see `render::sanitize_email_html`), never the raw body.
    pub body_html: Option<String>,
    pub has_remote_content: bool,
    pub declares_dark_mode: bool,
    pub body_text: Option<String>,
    /// False when only the message's metadata is cached (its body couldn't be fetched,
    /// e.g. offline): the UI offers to try again instead of showing an empty message.
    pub body_available: bool,
    pub unread: bool,
    pub starred: bool,
    pub label_ids: Vec<String>,
    pub has_attachment: bool,
    pub attachments: Vec<AttachmentDto>,
    /// How the message offers to unsubscribe, from its `List-Unsubscribe` headers:
    /// `one_click`, `link`, `email` or `none` (see [`crate::senders::UnsubscribeOptions`]).
    pub unsubscribe: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub id: String,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub is_inline: bool,
    pub content_id: Option<String>,
}

impl From<DbAttachment> for AttachmentDto {
    fn from(a: DbAttachment) -> Self {
        Self {
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            size: a.size,
            is_inline: a.is_inline != 0,
            content_id: a.content_id,
        }
    }
}

impl From<DbMessage> for MessageDetailDto {
    fn from(m: DbMessage) -> Self {
        let body_available = has_body(&m);
        let unsubscribe = crate::senders::options(&m.headers()).kind();
        Self {
            unsubscribe,
            body_available,
            to: m.to(),
            cc: m.cc(),
            label_ids: parse_labels(m.label_ids.as_deref()),
            id: m.id,
            thread_id: m.thread_id,
            from_name: m.from_name,
            from_address: m.from_address,
            subject: m.subject,
            snippet: m.snippet,
            date: m.date.unwrap_or(0),
            body_html: m.body_html,
            has_remote_content: false,
            declares_dark_mode: false,
            body_text: m.body_text,
            unread: m.is_read == 0,
            starred: m.is_starred != 0,
            has_attachment: m.has_attachment != 0,
            attachments: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailDto {
    pub thread: ThreadSummaryDto,
    pub messages: Vec<MessageDetailDto>,
    /// Set when some bodies weren't cached and fetching them failed.
    pub body_error: Option<BodyErrorDto>,
}

/// Why a thread's missing bodies couldn't be fetched: the error `code` (as commands report
/// it) and a plain message for the reader, free of URLs and request details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyErrorDto {
    pub code: String,
    pub message: String,
}

impl From<&SyncError> for BodyErrorDto {
    fn from(e: &SyncError) -> Self {
        let message = match e {
            SyncError::Gmail(GmailError::Network(_) | GmailError::Offline(_)) => {
                "Couldn't reach Gmail. You may be offline."
            }
            SyncError::Gmail(GmailError::RateLimit { .. }) => {
                "Gmail asked Pheeme to slow down. Try again in a minute."
            }
            SyncError::Gmail(GmailError::KeychainLocked(_)) => {
                "Pheeme can't read this account's sign-in from the keychain right now. Unlock your Mac and try again."
            }
            SyncError::Gmail(GmailError::Auth(_) | GmailError::SignedOut(_)) => {
                "Gmail didn't accept this account's sign-in. Sign in again from Settings."
            }
            SyncError::Gmail(GmailError::Api { status, .. }) if *status >= 500 => {
                "Gmail had a problem. Try again in a moment."
            }
            SyncError::Gmail(_) => "Gmail wouldn't return this message.",
            SyncError::Db(_) => "Pheeme couldn't save this message on this computer.",
        };
        Self {
            code: e.code().to_owned(),
            message: message.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelDto {
    pub id: String,
    pub account_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub label_type: String,
    pub messages_total: i64,
    pub messages_unread: i64,
    pub threads_total: i64,
    pub threads_unread: i64,
    pub color_background: Option<String>,
    pub color_text: Option<String>,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
}

impl From<labels::DbLabel> for LabelDto {
    fn from(l: labels::DbLabel) -> Self {
        Self {
            id: l.id,
            account_id: l.account_id,
            name: l.name,
            label_type: l.label_type,
            messages_total: l.messages_total,
            messages_unread: l.messages_unread,
            threads_total: l.threads_total,
            threads_unread: l.threads_unread,
            color_background: l.color_background,
            color_text: l.color_text,
            message_list_visibility: l.message_list_visibility,
            label_list_visibility: l.label_list_visibility,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountDto {
    pub label_id: String,
    pub unread: i64,
}

/// Unread and total conversations under one label of an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelCountDto {
    pub label_id: String,
    pub unread: i64,
    pub total: i64,
}

/// The message's body is cached: a full copy (possibly genuinely empty) or any body text.
pub(super) fn has_body(m: &DbMessage) -> bool {
    m.fully_fetched != 0 || m.body_html.is_some() || m.body_text.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(headers: Option<&str>) -> DbMessage {
        DbMessage {
            id: "m1".into(),
            account_id: "a1".into(),
            thread_id: "t1".into(),
            label_ids: Some(r#"["INBOX"]"#.into()),
            from_address: Some("news@example.com".into()),
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: Some("hi".into()),
            date: Some(1),
            size_estimate: None,
            has_attachment: 0,
            is_read: 1,
            is_starred: 0,
            raw_headers: headers.map(str::to_owned),
            fully_fetched: 1,
            rfc822_message_id: None,
        }
    }

    #[test]
    fn a_message_says_how_it_offers_to_unsubscribe() {
        let one_click = r#"[
            {"name":"List-Unsubscribe","value":"<https://example.com/u?x=1>, <mailto:u@example.com>"},
            {"name":"List-Unsubscribe-Post","value":"List-Unsubscribe=One-Click"}
        ]"#;
        let link = r#"[{"name":"List-Unsubscribe","value":"<https://example.com/u>"}]"#;
        let email = r#"[{"name":"List-Unsubscribe","value":"<mailto:u@example.com>"}]"#;
        let kind = |h| MessageDetailDto::from(message(h)).unsubscribe;
        assert_eq!(kind(Some(one_click)), "one_click");
        assert_eq!(kind(Some(link)), "link");
        assert_eq!(kind(Some(email)), "email");
        assert_eq!(kind(Some("[]")), "none");
        assert_eq!(kind(None), "none");
    }
}
