//! Gmail REST API request and response types (camelCase on the wire).
//!
//! Fields Gmail omits when empty are `#[serde(default)]` so the same struct serves every
//! `format` (minimal, metadata, full, raw) and history snapshots.

use serde::{Deserialize, Serialize};

/// The `format` query parameter of `messages.get` and `threads.get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageFormat {
    Minimal,
    Full,
    Raw,
    Metadata,
}

impl MessageFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageFormat::Minimal => "minimal",
            MessageFormat::Full => "full",
            MessageFormat::Raw => "raw",
            MessageFormat::Metadata => "metadata",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePartBody {
    pub attachment_id: Option<String>,
    #[serde(default)]
    pub size: u64,
    /// base64url-encoded content; absent for attachments and for `format=metadata`.
    pub data: Option<String>,
}

/// One node of Gmail's decoded MIME tree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePart {
    pub part_id: Option<String>,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub body: MessagePartBody,
    #[serde(default)]
    pub parts: Vec<MessagePart>,
}

impl MessagePart {
    /// First header with this name (case-insensitive), raw (RFC 2047 words not decoded).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub snippet: String,
    pub history_id: Option<String>,
    /// Milliseconds since the epoch, as a decimal string.
    pub internal_date: Option<String>,
    pub size_estimate: Option<u64>,
    /// base64url RFC 2822 message, present for `format=raw`.
    pub raw: Option<String>,
    pub payload: Option<MessagePart>,
}

impl Message {
    pub fn internal_date_ms(&self) -> Option<i64> {
        self.internal_date.as_deref()?.parse().ok()
    }
}

/// `id`/`threadId` pair returned by `messages.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRef {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListResponse {
    #[serde(default)]
    pub messages: Vec<MessageRef>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    #[serde(default)]
    pub snippet: String,
    pub history_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    #[serde(default)]
    pub threads: Vec<Thread>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelColor {
    pub text_color: String,
    pub background_color: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
    /// `system` or `user`.
    #[serde(rename = "type")]
    pub label_type: Option<String>,
    /// Counters are only present on `labels.get`, not on `labels.list`.
    pub messages_total: Option<u32>,
    pub messages_unread: Option<u32>,
    pub threads_total: Option<u32>,
    pub threads_unread: Option<u32>,
    pub color: Option<LabelColor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelListResponse {
    #[serde(default)]
    pub labels: Vec<Label>,
}

/// Partial update for `labels.patch`; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_list_visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_list_visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<LabelColor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub message: Option<Message>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftListResponse {
    #[serde(default)]
    pub drafts: Vec<Draft>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub message: Message,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLabelChange {
    pub message: Message,
    #[serde(default)]
    pub label_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub messages_added: Vec<HistoryMessage>,
    #[serde(default)]
    pub messages_deleted: Vec<HistoryMessage>,
    #[serde(default)]
    pub labels_added: Vec<HistoryLabelChange>,
    #[serde(default)]
    pub labels_removed: Vec<HistoryLabelChange>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResponse {
    /// Absent when nothing changed since `startHistoryId`.
    #[serde(default)]
    pub history: Vec<HistoryRecord>,
    pub next_page_token: Option<String>,
    /// The mailbox's current history id; store this, not the last record's id.
    pub history_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub email_address: String,
    #[serde(default)]
    pub messages_total: u64,
    #[serde(default)]
    pub threads_total: u64,
    pub history_id: String,
}

/// Body of `messages.attachments.get`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub(crate) struct AttachmentBody {
    pub data: String,
}

/// A Gmail filter (`users.settings.filters`). Fields Pheeme doesn't use are kept in `other`, so
/// a filter made elsewhere is never mistaken for a plain sender rule and survives a round trip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub criteria: FilterCriteria,
    #[serde(default)]
    pub action: FilterAction,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCriteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterAction {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_label_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_label_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forward: Option<String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterListResponse {
    #[serde(default)]
    pub filter: Vec<Filter>,
}

/// A send-as address (`users.settings.sendAs`): the account's own address, or an alias.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SendAs {
    pub send_as_email: String,
    pub display_name: Option<String>,
    /// HTML; empty when there's none.
    pub signature: Option<String>,
    pub is_primary: bool,
    pub is_default: bool,
    /// For aliases: `accepted` once Gmail will send from it (`pending` until verified).
    pub verification_status: Option<String>,
}

impl SendAs {
    /// Whether Gmail sends mail from this address: the account's own, or a verified alias.
    pub fn sendable(&self) -> bool {
        self.is_primary || self.verification_status.as_deref() == Some("accepted")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAsListResponse {
    #[serde(default)]
    pub send_as: Vec<SendAs>,
}
