//! In-memory Gmail mailbox for sync tests: messages, labels, a history log that can
//! expire, scripted failures, and call counters.

use super::api::MailApi;
use crate::gmail::mime::encode_base64url;
use crate::gmail::types::{
    Draft, DraftListResponse, Header, HistoryLabelChange, HistoryListResponse, HistoryMessage,
    HistoryRecord, Label, LabelColor, LabelUpdate, Message, MessageListResponse, MessagePart,
    MessagePartBody, MessageRef, Thread, ThreadListResponse,
};
use crate::gmail::{GmailError, MessageFormat};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone)]
pub struct FakeMsg {
    pub id: String,
    pub thread_id: String,
    pub labels: Vec<String>,
    pub from: String,
    pub subject: String,
    pub body: String,
    pub date_ms: i64,
    pub message_id: String,
    pub history_id: u64,
    pub attachments: Vec<FakeAttachment>,
    /// The whole RFC 2822 message (sent mail and drafts); served as `raw` in place of the
    /// generated parts above.
    pub raw: Option<Vec<u8>>,
}

/// A file attached to a [`FakeMsg`]; its bytes are registered with
/// [`FakeGmail::seed_attachment`].
#[derive(Debug, Clone)]
pub struct FakeAttachment {
    pub filename: String,
    pub mime_type: String,
    pub attachment_id: String,
    pub content_id: Option<String>,
    pub size: u64,
    /// Bytes carried in the message itself (`body.data`, no `attachmentId`).
    pub embedded: Option<Vec<u8>>,
}

impl FakeMsg {
    pub fn new(id: &str, thread_id: &str, labels: &[&str]) -> Self {
        Self {
            id: id.into(),
            thread_id: thread_id.into(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
            from: format!("Sender {id} <{id}@example.com>"),
            subject: format!("Subject {thread_id}"),
            body: format!("Body of {id}"),
            date_ms: now_ms(),
            message_id: format!("<{id}@example.com>"),
            history_id: 0,
            attachments: Vec::new(),
            raw: None,
        }
    }

    /// Attach a file (a full-format copy becomes multipart/mixed).
    pub fn with_attachment(mut self, filename: &str, mime_type: &str, attachment_id: &str) -> Self {
        self.attachments.push(FakeAttachment {
            filename: filename.into(),
            mime_type: mime_type.into(),
            attachment_id: attachment_id.into(),
            content_id: None,
            size: 1,
            embedded: None,
        });
        self
    }

    /// Attach a small part whose bytes travel inside the message (no `attachmentId`).
    pub fn with_embedded(
        mut self,
        filename: &str,
        mime_type: &str,
        content_id: Option<&str>,
        bytes: &[u8],
    ) -> Self {
        self.attachments.push(FakeAttachment {
            filename: filename.into(),
            mime_type: mime_type.into(),
            attachment_id: String::new(),
            content_id: content_id.map(Into::into),
            size: bytes.len() as u64,
            embedded: Some(bytes.to_vec()),
        });
        self
    }

    /// Attach an inline image referenced as `cid:{content_id}`.
    pub fn with_inline(
        mut self,
        filename: &str,
        mime_type: &str,
        attachment_id: &str,
        content_id: &str,
    ) -> Self {
        self.attachments.push(FakeAttachment {
            filename: filename.into(),
            mime_type: mime_type.into(),
            attachment_id: attachment_id.into(),
            content_id: Some(content_id.into()),
            size: 1,
            embedded: None,
        });
        self
    }

    pub fn at(mut self, date_ms: i64) -> Self {
        self.date_ms = date_ms;
        self
    }

    pub fn days_ago(self, days: i64) -> Self {
        self.at(now_ms() - days * DAY_MS)
    }

    /// A message Gmail stored from this RFC 2822 source (subject and Message-ID from it).
    pub fn from_raw(id: &str, thread_id: &str, labels: &[&str], rfc822: &[u8]) -> Self {
        let mut msg = Self::new(id, thread_id, labels);
        if let Ok(parsed) = mailparse::parse_mail(rfc822) {
            use mailparse::MailHeaderMap;
            let h = &parsed.headers;
            msg.subject = h.get_first_value("Subject").unwrap_or_default();
            msg.message_id = crate::gmail::mime::rfc822_message_id(rfc822).unwrap_or_default();
            msg.from = h.get_first_value("From").unwrap_or_default();
        }
        msg.raw = Some(rfc822.to_vec());
        msg
    }

    fn to_message(&self, format: MessageFormat) -> Message {
        if let (Some(raw), false) = (&self.raw, format == MessageFormat::Minimal) {
            return Message {
                raw: Some(encode_base64url(raw)),
                ..self.to_message(MessageFormat::Minimal)
            };
        }
        let headers = vec![
            Header {
                name: "From".into(),
                value: self.from.clone(),
            },
            Header {
                name: "Subject".into(),
                value: self.subject.clone(),
            },
            Header {
                name: "Message-ID".into(),
                value: self.message_id.clone(),
            },
        ];
        let payload = match format {
            MessageFormat::Minimal => None,
            MessageFormat::Metadata => Some(MessagePart {
                mime_type: "text/plain".into(),
                headers,
                ..Default::default()
            }),
            MessageFormat::Full | MessageFormat::Raw => {
                let text = MessagePart {
                    mime_type: "text/plain".into(),
                    body: MessagePartBody {
                        data: Some(encode_base64url(self.body.as_bytes())),
                        size: self.body.len() as u64,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                if self.attachments.is_empty() {
                    Some(MessagePart { headers, ..text })
                } else {
                    let mut parts = vec![text];
                    parts.extend(self.attachments.iter().map(|a| {
                        MessagePart {
                            mime_type: a.mime_type.clone(),
                            filename: a.filename.clone(),
                            headers: a
                                .content_id
                                .iter()
                                .map(|cid| Header {
                                    name: "Content-ID".into(),
                                    value: format!("<{cid}>"),
                                })
                                .collect(),
                            body: match &a.embedded {
                                Some(bytes) => MessagePartBody {
                                    data: Some(encode_base64url(bytes)),
                                    size: a.size,
                                    ..Default::default()
                                },
                                None => MessagePartBody {
                                    attachment_id: Some(a.attachment_id.clone()),
                                    size: a.size,
                                    ..Default::default()
                                },
                            },
                            ..Default::default()
                        }
                    }));
                    Some(MessagePart {
                        mime_type: "multipart/mixed".into(),
                        headers,
                        parts,
                        ..Default::default()
                    })
                }
            }
        };
        Message {
            id: self.id.clone(),
            thread_id: self.thread_id.clone(),
            label_ids: self.labels.clone(),
            snippet: self.body.clone(),
            history_id: Some(self.history_id.to_string()),
            internal_date: Some(self.date_ms.to_string()),
            payload,
            ..Default::default()
        }
    }

    fn envelope(&self) -> Message {
        Message {
            id: self.id.clone(),
            thread_id: self.thread_id.clone(),
            label_ids: self.labels.clone(),
            ..Default::default()
        }
    }
}

#[derive(Default)]
struct State {
    history_id: u64,
    /// History before this id is gone (`list_history` answers 404).
    oldest_history: u64,
    messages: BTreeMap<String, FakeMsg>,
    history: Vec<HistoryRecord>,
    failures: HashMap<&'static str, VecDeque<GmailError>>,
    /// `(successful calls still to allow, then this error)`.
    delayed_failures: HashMap<&'static str, (usize, GmailError)>,
    calls: HashMap<&'static str, usize>,
    sent: Vec<String>,
    /// `threadId` passed with each send, in order.
    sent_threads: Vec<Option<String>>,
    /// Draft id → its current message id.
    drafts: BTreeMap<String, String>,
    next_draft: u64,
    send_then_fail: Option<GmailError>,
    history_page: usize,
    /// Runs (once) at the start of the next `batch_get_messages`.
    before_batch_get: Option<Box<dyn FnOnce() + Send>>,
    /// While set, every `batch_get_messages` waits for a permit (see [`FakeGmail::hold_batch_gets`]).
    batch_gate: Option<std::sync::Arc<tokio::sync::Semaphore>>,
    draft_delete_gate: Option<std::sync::Arc<tokio::sync::Semaphore>>,
    list_page: Option<usize>,
    next_sent: u64,
    /// `(message id, attachment id)` → bytes.
    attachment_bytes: HashMap<(String, String), Vec<u8>>,
    /// User labels by id (system labels are fixed).
    user_labels: BTreeMap<String, Label>,
    next_label: u64,
    list_omits_color: bool,
}

pub struct FakeGmail {
    state: Mutex<State>,
}

impl Default for FakeGmail {
    fn default() -> Self {
        Self::new()
    }
}

const SYSTEM_LABELS: &[&str] = &[
    "INBOX",
    "SENT",
    "DRAFT",
    "TRASH",
    "SPAM",
    "UNREAD",
    "STARRED",
    "IMPORTANT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];

fn api_error(status: u16, reason: &str, message: &str) -> GmailError {
    GmailError::Api {
        status,
        reason: Some(reason.into()),
        message: message.into(),
    }
}

fn check_color(color: &LabelColor) -> Result<(), GmailError> {
    let ok = crate::gmail::palette::is_allowed(&color.background_color)
        && crate::gmail::palette::is_allowed(&color.text_color);
    if ok {
        Ok(())
    } else {
        Err(api_error(400, "invalidArgument", "Invalid label color."))
    }
}

fn name_taken(s: &State, name: &str, except: Option<&str>) -> bool {
    SYSTEM_LABELS.iter().any(|n| n.eq_ignore_ascii_case(name))
        || s.user_labels
            .values()
            .any(|l| Some(l.id.as_str()) != except && l.name.eq_ignore_ascii_case(name))
}

fn not_found() -> GmailError {
    GmailError::Api {
        status: 404,
        reason: Some("notFound".into()),
        message: "Requested entity was not found.".into(),
    }
}

impl FakeGmail {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                history_id: 100,
                history_page: 100,
                ..Default::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    /// Calls of `method` so far (method names as in [`MailApi`]).
    pub fn calls(&self, method: &str) -> usize {
        self.lock().calls.get(method).copied().unwrap_or(0)
    }

    /// The next call of `method` fails with `error` (queued, in order).
    pub fn fail_next(&self, method: &'static str, error: GmailError) {
        self.lock()
            .failures
            .entry(method)
            .or_default()
            .push_back(error);
    }

    /// Let `successes` calls of `method` through, then fail the next one with `error`.
    pub fn fail_after(&self, method: &'static str, successes: usize, error: GmailError) {
        self.lock()
            .delayed_failures
            .insert(method, (successes, error));
    }

    /// Run `hook` at the start of the next `batch_get_messages` call.
    pub fn before_next_batch_get(&self, hook: impl FnOnce() + Send + 'static) {
        self.lock().before_batch_get = Some(Box::new(hook));
    }

    /// Make every later `batch_get_messages` wait until the returned semaphore gets a
    /// permit (an unreachable Gmail that never answers).
    pub fn hold_batch_gets(&self) -> std::sync::Arc<tokio::sync::Semaphore> {
        let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        self.lock().batch_gate = Some(gate.clone());
        gate
    }

    /// Stall draft cleanup after a send, independently of Gmail accepting the message.
    pub fn hold_draft_deletes(&self) -> std::sync::Arc<tokio::sync::Semaphore> {
        let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        self.lock().draft_delete_gate = Some(gate.clone());
        gate
    }

    /// The next send is delivered, then answered with `error` (an ambiguous failure).
    pub fn deliver_then_fail(&self, error: GmailError) {
        self.lock().send_then_fail = Some(error);
    }

    /// Register the bytes `get_attachment` serves for this attachment.
    pub fn seed_attachment(&self, message_id: &str, attachment_id: &str, bytes: &[u8]) {
        self.lock().attachment_bytes.insert(
            (message_id.to_owned(), attachment_id.to_owned()),
            bytes.to_vec(),
        );
    }

    /// `get_attachment` calls so far.
    pub fn attachment_fetches(&self) -> usize {
        self.calls("get_attachment")
    }

    pub fn sent(&self) -> Vec<String> {
        self.lock().sent.clone()
    }

    pub fn sent_threads(&self) -> Vec<Option<String>> {
        self.lock().sent_threads.clone()
    }

    /// Draft id → message id.
    pub fn drafts(&self) -> BTreeMap<String, String> {
        self.lock().drafts.clone()
    }

    fn store_draft(&self, draft_id: &str, rfc822: &[u8], thread_id: Option<&str>) -> Draft {
        let message_id = {
            let mut s = self.lock();
            s.next_draft += 1;
            format!("draft-msg-{}", s.next_draft)
        };
        let thread = thread_id.unwrap_or(&message_id).to_owned();
        let msg = FakeMsg::from_raw(&message_id, &thread, &["DRAFT"], rfc822);
        let envelope = msg.envelope();
        self.add(msg);
        self.lock()
            .drafts
            .insert(draft_id.to_owned(), message_id.clone());
        Draft {
            id: draft_id.to_owned(),
            message: Some(envelope),
        }
    }

    fn draft_message(&self, draft_id: &str) -> Result<String, GmailError> {
        self.lock()
            .drafts
            .get(draft_id)
            .cloned()
            .ok_or_else(not_found)
    }

    pub fn history_id(&self) -> u64 {
        self.lock().history_id
    }

    pub fn set_history_page_size(&self, n: usize) {
        self.lock().history_page = n;
    }

    /// Seed a user label as if it already existed in the mailbox.
    pub fn add_user_label(&self, id: &str, name: &str, color: Option<(&str, &str)>) {
        self.lock().user_labels.insert(
            id.into(),
            Label {
                id: id.into(),
                name: name.into(),
                label_type: Some("user".into()),
                label_list_visibility: Some("labelShow".into()),
                message_list_visibility: Some("show".into()),
                color: color.map(|(text, background)| LabelColor {
                    text_color: text.into(),
                    background_color: background.into(),
                }),
                ..Default::default()
            },
        );
    }

    /// While set, `list_labels` leaves user labels' colour out (as Gmail's list can);
    /// `get_label` still returns it.
    pub fn set_list_omits_color(&self, omit: bool) {
        self.lock().list_omits_color = omit;
    }

    pub fn set_list_page_size(&self, n: usize) {
        self.lock().list_page = Some(n);
    }

    /// Drop all history recorded so far, as if the app had been closed for weeks.
    pub fn expire_history(&self) {
        let mut s = self.lock();
        s.history_id += 1;
        s.oldest_history = s.history_id;
        s.history.clear();
    }

    /// Drop history up to and including `history_id`, once it's been synced, so a long run
    /// doesn't grow the fake's own log.
    pub fn forget_history_through(&self, history_id: u64) {
        let mut s = self.lock();
        s.history
            .retain(|r| r.id.parse::<u64>().unwrap() > history_id);
        s.oldest_history = s.oldest_history.max(history_id);
    }

    pub fn message(&self, id: &str) -> Option<FakeMsg> {
        self.lock().messages.get(id).cloned()
    }

    /// Add a message (recorded as `messagesAdded`).
    pub fn add(&self, mut msg: FakeMsg) {
        let mut s = self.lock();
        s.history_id += 1;
        msg.history_id = s.history_id;
        let record = HistoryRecord {
            id: s.history_id.to_string(),
            messages_added: vec![HistoryMessage {
                message: msg.envelope(),
            }],
            ..Default::default()
        };
        s.history.push(record);
        s.messages.insert(msg.id.clone(), msg);
    }

    /// Add without a history record (mail that existed before the app connected).
    pub fn seed(&self, mut msg: FakeMsg) {
        let mut s = self.lock();
        msg.history_id = s.history_id;
        s.messages.insert(msg.id.clone(), msg);
    }

    /// Change labels as another device would (recorded in history).
    pub fn relabel(&self, id: &str, add: &[&str], remove: &[&str]) {
        let add: Vec<String> = add.iter().map(|s| s.to_string()).collect();
        let remove: Vec<String> = remove.iter().map(|s| s.to_string()).collect();
        Self::apply_labels(&mut self.lock(), id, &add, &remove);
    }

    fn apply_labels(s: &mut State, id: &str, add: &[String], remove: &[String]) {
        let Some(msg) = s.messages.get_mut(id) else {
            return;
        };
        let added: Vec<String> = add
            .iter()
            .filter(|l| !msg.labels.contains(l))
            .cloned()
            .collect();
        let removed: Vec<String> = remove
            .iter()
            .filter(|l| msg.labels.contains(l))
            .cloned()
            .collect();
        msg.labels.extend(added.iter().cloned());
        msg.labels.retain(|l| !removed.contains(l));
        s.history_id += 1;
        msg.history_id = s.history_id;
        let envelope = msg.envelope();
        let mut record = HistoryRecord {
            id: s.history_id.to_string(),
            ..Default::default()
        };
        if !added.is_empty() {
            record.labels_added.push(HistoryLabelChange {
                message: envelope.clone(),
                label_ids: added,
            });
        }
        if !removed.is_empty() {
            record.labels_removed.push(HistoryLabelChange {
                message: envelope,
                label_ids: removed,
            });
        }
        s.history.push(record);
    }

    /// Delete permanently (recorded as `messagesDeleted`).
    pub fn delete(&self, id: &str) {
        let mut s = self.lock();
        if let Some(msg) = s.messages.remove(id) {
            s.history_id += 1;
            let record = HistoryRecord {
                id: s.history_id.to_string(),
                messages_deleted: vec![HistoryMessage {
                    message: msg.envelope(),
                }],
                ..Default::default()
            };
            s.history.push(record);
        }
    }

    /// Count the call and pop a scripted failure for it.
    fn enter(&self, method: &'static str) -> Result<(), GmailError> {
        let mut s = self.lock();
        *s.calls.entry(method).or_default() += 1;
        if let Some((left, _)) = s.delayed_failures.get_mut(method) {
            if *left == 0 {
                let (_, e) = s.delayed_failures.remove(method).unwrap();
                return Err(e);
            }
            *left -= 1;
        }
        match s.failures.get_mut(method).and_then(VecDeque::pop_front) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn page<T: Clone>(items: &[T], token: Option<&str>, size: usize) -> (Vec<T>, Option<String>) {
        let start: usize = token.and_then(|t| t.parse().ok()).unwrap_or(0);
        let end = (start + size).min(items.len());
        let next = (end < items.len()).then(|| end.to_string());
        (items[start.min(end)..end].to_vec(), next)
    }
}

#[async_trait::async_trait]
impl MailApi for FakeGmail {
    async fn profile_history_id(&self) -> Result<String, GmailError> {
        self.enter("profile_history_id")?;
        Ok(self.lock().history_id.to_string())
    }

    async fn list_labels(&self) -> Result<Vec<Label>, GmailError> {
        self.enter("list_labels")?;
        let s = self.lock();
        let system = SYSTEM_LABELS.iter().map(|id| Label {
            id: (*id).into(),
            name: (*id).into(),
            label_type: Some("system".into()),
            ..Default::default()
        });
        let user = s.user_labels.values().cloned().map(|mut l| {
            if s.list_omits_color {
                l.color = None;
            }
            l
        });
        Ok(system.chain(user).collect())
    }

    async fn create_label(
        &self,
        name: &str,
        color: Option<LabelColor>,
    ) -> Result<Label, GmailError> {
        self.enter("create_label")?;
        let mut s = self.lock();
        if name_taken(&s, name, None) {
            return Err(api_error(
                409,
                "conflict",
                "Label name exists or conflicts.",
            ));
        }
        if let Some(c) = &color {
            check_color(c)?;
        }
        s.next_label += 1;
        let id = format!("Label_{}", s.next_label);
        let label = Label {
            id: id.clone(),
            name: name.into(),
            label_type: Some("user".into()),
            label_list_visibility: Some("labelShow".into()),
            message_list_visibility: Some("show".into()),
            color,
            ..Default::default()
        };
        s.user_labels.insert(id, label.clone());
        Ok(label)
    }

    async fn update_label(&self, id: &str, update: LabelUpdate) -> Result<Label, GmailError> {
        self.enter("update_label")?;
        let mut s = self.lock();
        if !s.user_labels.contains_key(id) {
            return Err(not_found());
        }
        if let Some(name) = &update.name {
            if name_taken(&s, name, Some(id)) {
                return Err(api_error(
                    409,
                    "conflict",
                    "Label name exists or conflicts.",
                ));
            }
        }
        if let Some(c) = &update.color {
            check_color(c)?;
        }
        let label = s.user_labels.get_mut(id).unwrap();
        if let Some(name) = update.name {
            label.name = name;
        }
        if update.message_list_visibility.is_some() {
            label.message_list_visibility = update.message_list_visibility;
        }
        if update.label_list_visibility.is_some() {
            label.label_list_visibility = update.label_list_visibility;
        }
        if update.color.is_some() {
            label.color = update.color;
        }
        Ok(label.clone())
    }

    async fn replace_label(&self, new: &Label) -> Result<Label, GmailError> {
        self.enter("replace_label")?;
        let mut s = self.lock();
        if !s.user_labels.contains_key(&new.id) {
            return Err(not_found());
        }
        if name_taken(&s, &new.name, Some(&new.id)) {
            return Err(api_error(
                409,
                "conflict",
                "Label name exists or conflicts.",
            ));
        }
        if let Some(c) = &new.color {
            check_color(c)?;
        }
        let label = s.user_labels.get_mut(&new.id).unwrap();
        label.name = new.name.clone();
        label.label_list_visibility = new.label_list_visibility.clone();
        label.message_list_visibility = new.message_list_visibility.clone();
        label.color = new.color.clone();
        Ok(label.clone())
    }

    async fn delete_label(&self, id: &str) -> Result<(), GmailError> {
        self.enter("delete_label")?;
        let mut s = self.lock();
        if s.user_labels.remove(id).is_none() {
            return Err(not_found());
        }
        for msg in s.messages.values_mut() {
            msg.labels.retain(|l| l != id);
        }
        Ok(())
    }

    async fn get_label(&self, id: &str) -> Result<Label, GmailError> {
        self.enter("get_label")?;
        let s = self.lock();
        let user = s.user_labels.get(id).cloned();
        let with: Vec<&FakeMsg> = s
            .messages
            .values()
            .filter(|m| m.labels.iter().any(|l| l == id))
            .collect();
        let unread = |m: &&&FakeMsg| m.labels.iter().any(|l| l == "UNREAD");
        let threads = |ms: &[&&FakeMsg]| {
            let mut t: Vec<&str> = ms.iter().map(|m| m.thread_id.as_str()).collect();
            t.sort();
            t.dedup();
            t.len() as u32
        };
        let unread_msgs: Vec<&&FakeMsg> = with.iter().filter(unread).collect();
        let all: Vec<&&FakeMsg> = with.iter().collect();
        let base = user.unwrap_or_else(|| Label {
            id: id.into(),
            name: id.into(),
            label_type: Some("system".into()),
            ..Default::default()
        });
        Ok(Label {
            messages_total: Some(with.len() as u32),
            messages_unread: Some(unread_msgs.len() as u32),
            threads_total: Some(threads(&all)),
            threads_unread: Some(threads(&unread_msgs)),
            ..base
        })
    }

    async fn list_threads(
        &self,
        label: &str,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<ThreadListResponse, GmailError> {
        self.enter("list_threads")?;
        let s = self.lock();
        let mut latest: HashMap<&str, i64> = HashMap::new();
        for m in s
            .messages
            .values()
            .filter(|m| m.labels.iter().any(|l| l == label))
        {
            let e = latest.entry(m.thread_id.as_str()).or_insert(i64::MIN);
            *e = (*e).max(m.date_ms);
        }
        let mut ids: Vec<(&str, i64)> = latest.into_iter().collect();
        ids.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(a.0)));
        let ids: Vec<String> = ids.into_iter().map(|(id, _)| id.to_owned()).collect();
        let (page, next) = Self::page(&ids, page_token, max as usize);
        Ok(ThreadListResponse {
            threads: page
                .into_iter()
                .map(|id| Thread {
                    id,
                    ..Default::default()
                })
                .collect(),
            next_page_token: next,
            result_size_estimate: None,
        })
    }

    async fn get_thread(&self, id: &str, format: MessageFormat) -> Result<Thread, GmailError> {
        self.enter("get_thread")?;
        let s = self.lock();
        let mut msgs: Vec<&FakeMsg> = s.messages.values().filter(|m| m.thread_id == id).collect();
        if msgs.is_empty() {
            return Err(not_found());
        }
        msgs.sort_by_key(|m| m.date_ms);
        Ok(Thread {
            id: id.into(),
            messages: msgs.into_iter().map(|m| m.to_message(format)).collect(),
            ..Default::default()
        })
    }

    async fn list_messages(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        self.enter("list_messages")?;
        let s = self.lock();
        let mut msgs: Vec<&FakeMsg> = s.messages.values().collect();
        msgs.sort_by(|a, b| b.date_ms.cmp(&a.date_ms).then(b.id.cmp(&a.id)));
        let refs: Vec<MessageRef> = msgs
            .into_iter()
            .map(|m| MessageRef {
                id: m.id.clone(),
                thread_id: m.thread_id.clone(),
            })
            .collect();
        let size = s.list_page.unwrap_or(max as usize);
        let (page, next) = Self::page(&refs, page_token, size);
        Ok(MessageListResponse {
            messages: page,
            next_page_token: next,
            result_size_estimate: None,
        })
    }

    /// `rfc822msgid:<id> [in:sent]`, or plain words that must all appear in the subject or
    /// body (case-insensitive; operators are ignored, and Spam/Trash only count with
    /// `include_spam_trash`). Newest first, paged by `max`.
    async fn search_messages(
        &self,
        q: &str,
        include_spam_trash: bool,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<MessageListResponse, GmailError> {
        self.enter("search_messages")?;
        let s = self.lock();
        let mut hits: Vec<&FakeMsg> = match q.strip_prefix("rfc822msgid:") {
            Some(rest) => {
                let mut terms = rest.split_whitespace();
                let wanted = terms.next().unwrap_or_default();
                let sent_only = terms.any(|t| t == "in:sent");
                s.messages
                    .values()
                    .filter(|m| m.message_id == wanted)
                    .filter(|m| !sent_only || m.labels.iter().any(|l| l == "SENT"))
                    .collect()
            }
            None => {
                let words: Vec<String> = q
                    .split_whitespace()
                    .filter(|w| !w.contains(':'))
                    .map(str::to_lowercase)
                    .collect();
                s.messages
                    .values()
                    .filter(|m| {
                        include_spam_trash || !m.labels.iter().any(|l| l == "TRASH" || l == "SPAM")
                    })
                    .filter(|m| {
                        let text = format!("{} {}", m.subject, m.body).to_lowercase();
                        words.iter().all(|w| text.contains(w.as_str()))
                    })
                    .collect()
            }
        };
        hits.sort_by_key(|m| std::cmp::Reverse(m.date_ms));
        let refs: Vec<MessageRef> = hits
            .into_iter()
            .map(|m| MessageRef {
                id: m.id.clone(),
                thread_id: m.thread_id.clone(),
            })
            .collect();
        let (messages, next_page_token) = Self::page(&refs, page_token, max as usize);
        Ok(MessageListResponse {
            messages,
            next_page_token,
            ..Default::default()
        })
    }

    async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        let gate = self.lock().batch_gate.clone();
        if let Some(gate) = gate {
            let _permit = gate.acquire().await.expect("gate open");
        }
        let hook = self.lock().before_batch_get.take();
        if let Some(hook) = hook {
            hook();
        }
        let mut out = Vec::new();
        for id in ids {
            let result = self.enter("get_message").and_then(|()| {
                self.lock()
                    .messages
                    .get(id)
                    .map(|m| m.to_message(format))
                    .ok_or_else(not_found)
            });
            out.push((id.clone(), result));
        }
        out
    }

    async fn list_history(
        &self,
        start: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryListResponse, GmailError> {
        self.enter("list_history")?;
        let s = self.lock();
        let start: u64 = start.parse().expect("numeric history id");
        if start < s.oldest_history {
            return Err(GmailError::Api {
                status: 404,
                reason: Some(crate::gmail::error::HISTORY_EXPIRED_REASON.into()),
                message: format!("Invalid startHistoryId: {start}"),
            });
        }
        let records: Vec<HistoryRecord> = s
            .history
            .iter()
            .filter(|r| r.id.parse::<u64>().unwrap() > start)
            .cloned()
            .collect();
        let (page, next) = Self::page(&records, page_token, s.history_page);
        Ok(HistoryListResponse {
            history: page,
            next_page_token: next,
            history_id: Some(s.history_id.to_string()),
        })
    }

    async fn batch_modify(
        &self,
        ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<(), GmailError> {
        self.enter("batch_modify")?;
        let mut s = self.lock();
        for id in ids {
            Self::apply_labels(&mut s, id, add, remove);
        }
        Ok(())
    }

    async fn trash_message(&self, id: &str) -> Result<(), GmailError> {
        self.enter("trash_message")?;
        let mut s = self.lock();
        if !s.messages.contains_key(id) {
            return Err(not_found());
        }
        Self::apply_labels(&mut s, id, &["TRASH".into()], &[]);
        Ok(())
    }

    async fn send_message(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError> {
        self.enter("send_message")?;
        let id = {
            let mut s = self.lock();
            s.sent.push(encode_base64url(rfc822));
            s.sent_threads.push(thread_id.map(str::to_owned));
            s.next_sent += 1;
            format!("sent-{}", s.next_sent)
        };
        self.add(FakeMsg::from_raw(
            &id,
            thread_id.unwrap_or(&id),
            &["SENT"],
            rfc822,
        ));
        match self.lock().send_then_fail.take() {
            Some(e) => Err(e),
            None => Ok(id),
        }
    }

    async fn list_drafts(&self, page_token: Option<&str>) -> Result<DraftListResponse, GmailError> {
        self.enter("list_drafts")?;
        let s = self.lock();
        let all: Vec<Draft> = s
            .drafts
            .iter()
            .filter_map(|(id, msg)| {
                Some(Draft {
                    id: id.clone(),
                    message: Some(s.messages.get(msg)?.envelope()),
                })
            })
            .collect();
        let (drafts, next_page_token) = Self::page(&all, page_token, 2);
        Ok(DraftListResponse {
            drafts,
            next_page_token,
            result_size_estimate: Some(all.len() as u32),
        })
    }

    async fn get_draft(&self, id: &str) -> Result<Draft, GmailError> {
        self.enter("get_draft")?;
        let message_id = self.draft_message(id)?;
        let msg = self.message(&message_id).ok_or_else(not_found)?;
        Ok(Draft {
            id: id.to_owned(),
            message: Some(msg.to_message(MessageFormat::Full)),
        })
    }

    async fn create_draft(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        self.enter("create_draft")?;
        let id = format!("r-{}", self.lock().next_draft + 1);
        Ok(self.store_draft(&id, rfc822, thread_id))
    }

    async fn update_draft(
        &self,
        id: &str,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        self.enter("update_draft")?;
        let old = self.draft_message(id)?;
        self.delete(&old);
        Ok(self.store_draft(id, rfc822, thread_id))
    }

    async fn delete_draft(&self, id: &str) -> Result<(), GmailError> {
        self.enter("delete_draft")?;
        let gate = self.lock().draft_delete_gate.clone();
        if let Some(gate) = gate {
            let _permit = gate.acquire().await.expect("gate open");
        }
        let message_id = self.draft_message(id)?;
        self.lock().drafts.remove(id);
        self.delete(&message_id);
        Ok(())
    }

    async fn send_draft(&self, id: &str) -> Result<String, GmailError> {
        self.enter("send_draft")?;
        let message_id = self.draft_message(id)?;
        let raw = self
            .message(&message_id)
            .and_then(|m| m.raw)
            .unwrap_or_default();
        {
            let mut s = self.lock();
            s.drafts.remove(id);
            s.sent.push(encode_base64url(&raw));
        }
        self.relabel(&message_id, &["SENT"], &["DRAFT"]);
        match self.lock().send_then_fail.take() {
            Some(e) => Err(e),
            None => Ok(message_id),
        }
    }

    async fn get_attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError> {
        self.enter("get_attachment")?;
        self.lock()
            .attachment_bytes
            .get(&(message_id.to_owned(), attachment_id.to_owned()))
            .cloned()
            .ok_or_else(not_found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_history_records_label_changes() {
        let fake = FakeGmail::new();
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        let start = fake.history_id().to_string();
        fake.relabel("m1", &["STARRED"], &["INBOX"]);
        let page = fake.list_history(&start, None).await.unwrap();
        assert_eq!(page.history.len(), 1);
        assert_eq!(page.history[0].labels_added[0].label_ids, ["STARRED"]);
        assert_eq!(page.history[0].labels_removed[0].label_ids, ["INBOX"]);
        assert_eq!(page.history_id, Some(fake.history_id().to_string()));

        fake.expire_history();
        let err = fake.list_history(&start, None).await.unwrap_err();
        assert!(err.is_history_expired());
    }

    #[tokio::test]
    async fn fake_serves_seeded_attachment_bytes_and_counts_fetches() {
        let fake = FakeGmail::new();
        fake.seed_attachment("m1", "g1", b"pdf");
        assert_eq!(fake.get_attachment("m1", "g1").await.unwrap(), b"pdf");
        assert!(fake.get_attachment("m1", "other").await.is_err());
        assert_eq!(fake.attachment_fetches(), 2);
    }

    #[tokio::test]
    async fn fake_label_crud() {
        let fake = FakeGmail::new();
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        let color = |bg: &str| LabelColor {
            text_color: "#000000".into(),
            background_color: bg.into(),
        };
        let work = fake
            .create_label("Work", Some(color("#16a766")))
            .await
            .unwrap();
        let listed = fake.list_labels().await.unwrap();
        let found = listed.iter().find(|l| l.id == work.id).unwrap();
        assert_eq!(found.label_type.as_deref(), Some("user"));
        assert_eq!(found.color, Some(color("#16a766")));

        let dup = fake.create_label("work", None).await.unwrap_err();
        assert!(matches!(dup, GmailError::Api { status: 409, .. }));
        let bad = fake
            .create_label("Other", Some(color("#123456")))
            .await
            .unwrap_err();
        assert!(matches!(bad, GmailError::Api { status: 400, .. }));
        let missing = fake.delete_label("nope").await.unwrap_err();
        assert!(missing.is_not_found());

        let update = LabelUpdate {
            name: Some("Job".into()),
            ..Default::default()
        };
        fake.update_label(&work.id, update).await.unwrap();
        let listed = fake.list_labels().await.unwrap();
        assert_eq!(listed.iter().find(|l| l.id == work.id).unwrap().name, "Job");

        let mut plain = listed.iter().find(|l| l.id == work.id).unwrap().clone();
        plain.color = None;
        fake.replace_label(&plain).await.unwrap();
        let listed = fake.list_labels().await.unwrap();
        assert_eq!(listed.iter().find(|l| l.id == work.id).unwrap().color, None);

        fake.relabel("m1", &[&work.id], &[]);
        let history_id = fake.history_id();
        fake.delete_label(&work.id).await.unwrap();
        assert!(fake
            .list_labels()
            .await
            .unwrap()
            .iter()
            .all(|l| l.id != work.id));
        let msg = fake
            .get_thread("t1", MessageFormat::Metadata)
            .await
            .unwrap();
        assert!(!msg.messages[0].label_ids.contains(&work.id));
        assert_eq!(fake.history_id(), history_id);
    }

    #[tokio::test]
    async fn fake_list_can_omit_colour() {
        let fake = FakeGmail::new();
        fake.add_user_label("Label_1", "Work", Some(("#000000", "#16a766")));
        fake.set_list_omits_color(true);
        let listed = fake.list_labels().await.unwrap();
        assert_eq!(
            listed.iter().find(|l| l.id == "Label_1").unwrap().color,
            None
        );
        assert!(fake.get_label("Label_1").await.unwrap().color.is_some());
    }
}
