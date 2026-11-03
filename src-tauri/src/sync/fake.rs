//! In-memory Gmail mailbox for sync tests: messages, labels, a history log that can
//! expire, scripted failures, and call counters.

use super::api::MailApi;
use crate::gmail::mime::{decode_base64url, encode_base64url};
use crate::gmail::types::{
    Header, HistoryLabelChange, HistoryListResponse, HistoryMessage, HistoryRecord, Label, Message,
    MessageListResponse, MessagePart, MessagePartBody, MessageRef, Thread, ThreadListResponse,
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

    fn to_message(&self, format: MessageFormat) -> Message {
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
    send_then_fail: Option<GmailError>,
    history_page: usize,
    /// Runs (once) at the start of the next `batch_get_messages`.
    before_batch_get: Option<Box<dyn FnOnce() + Send>>,
    /// While set, every `batch_get_messages` waits for a permit (see [`FakeGmail::hold_batch_gets`]).
    batch_gate: Option<std::sync::Arc<tokio::sync::Semaphore>>,
    list_page: Option<usize>,
    next_sent: u64,
    /// `(message id, attachment id)` → bytes.
    attachment_bytes: HashMap<(String, String), Vec<u8>>,
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

    pub fn history_id(&self) -> u64 {
        self.lock().history_id
    }

    pub fn set_history_page_size(&self, n: usize) {
        self.lock().history_page = n;
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

    fn message_id_of(raw: &str) -> Option<String> {
        let bytes = decode_base64url(raw).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("Message-ID")
                .then(|| value.trim().to_owned())
        })
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
        Ok(SYSTEM_LABELS
            .iter()
            .map(|id| Label {
                id: (*id).into(),
                name: (*id).into(),
                label_type: Some("system".into()),
                ..Default::default()
            })
            .collect())
    }

    async fn get_label(&self, id: &str) -> Result<Label, GmailError> {
        self.enter("get_label")?;
        let s = self.lock();
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
        Ok(Label {
            id: id.into(),
            name: id.into(),
            label_type: Some("system".into()),
            messages_total: Some(with.len() as u32),
            messages_unread: Some(unread_msgs.len() as u32),
            threads_total: Some(threads(&all)),
            threads_unread: Some(threads(&unread_msgs)),
            ..Default::default()
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

    async fn search_messages(&self, q: &str) -> Result<MessageListResponse, GmailError> {
        self.enter("search_messages")?;
        let mut terms = q.split_whitespace();
        let wanted = terms
            .next()
            .and_then(|t| t.strip_prefix("rfc822msgid:"))
            .expect("fake only searches rfc822msgid:");
        let sent_only = terms.any(|t| t == "in:sent");
        let s = self.lock();
        Ok(MessageListResponse {
            messages: s
                .messages
                .values()
                .filter(|m| m.message_id == wanted)
                .filter(|m| !sent_only || m.labels.iter().any(|l| l == "SENT"))
                .map(|m| MessageRef {
                    id: m.id.clone(),
                    thread_id: m.thread_id.clone(),
                })
                .collect(),
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

    async fn send_message(&self, raw: &str) -> Result<String, GmailError> {
        self.enter("send_message")?;
        let message_id = Self::message_id_of(raw).unwrap_or_default();
        let id = {
            let mut s = self.lock();
            s.sent.push(raw.to_owned());
            s.next_sent += 1;
            format!("sent-{}", s.next_sent)
        };
        let mut msg = FakeMsg::new(&id, &id, &["SENT"]);
        msg.message_id = message_id;
        self.add(msg);
        match self.lock().send_then_fail.take() {
            Some(e) => Err(e),
            None => Ok(id),
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
}
