//! What the sync engine tells the UI. The Tauri layer forwards each event with
//! `app.emit(event.name(), event)`; tests record them.

use serde::Serialize;

/// A newly delivered unread Primary message, emitted only by incremental history sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMail {
    pub thread_id: String,
    pub sender: String,
    pub subject: String,
    pub snippet: String,
}

impl NewMail {
    pub fn from_message(message: &crate::db::messages::DbMessage) -> Option<Self> {
        let labels = message.labels();
        let has = |label: &str| labels.iter().any(|l| l == label);
        if message.is_read != 0
            || !has("INBOX")
            || [
                "TRASH",
                "SPAM",
                "DRAFT",
                "SENT",
                "CATEGORY_SOCIAL",
                "CATEGORY_PROMOTIONS",
                "CATEGORY_UPDATES",
                "CATEGORY_FORUMS",
            ]
            .iter()
            .any(|l| has(l))
        {
            return None;
        }
        Some(Self {
            thread_id: message.thread_id.clone(),
            sender: message
                .from_name
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| message.from_address.clone())
                .unwrap_or_else(|| "New mail".into()),
            subject: message
                .subject
                .clone()
                .unwrap_or_else(|| "(No subject)".into()),
            snippet: message.snippet.clone().unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum SyncEvent {
    NewMail {
        account_id: String,
        messages: Vec<NewMail>,
    },
    Started {
        account_id: String,
    },
    /// Thread ids whose cached rows changed.
    MessagesUpdated {
        account_id: String,
        added: Vec<String>,
        removed: Vec<String>,
        modified: Vec<String>,
    },
    LabelsUpdated {
        account_id: String,
    },
    Completed {
        account_id: String,
    },
    Error {
        account_id: String,
        code: String,
        message: String,
    },
    /// Gmail definitively rejected a queued change; it was rolled back.
    OpRejected {
        account_id: String,
        op_id: String,
        kind: String,
        message: String,
    },
    /// A send moved to `sent`, `checking`, `unconfirmed` or `failed`.
    SendStatus {
        account_id: String,
        op_id: String,
        status: String,
    },
    /// Where fetching a thread the reader opened has got to: `queued`, `fetching`,
    /// `retrying` (with `attempt`, `retry_in_ms` and `reason`) or `done`.
    ThreadLoading {
        account_id: String,
        thread_id: String,
        stage: &'static str,
        attempt: Option<u32>,
        retry_in_ms: Option<u64>,
        /// `rate_limited`, `network` or `server`, while retrying.
        reason: Option<&'static str>,
        /// The account's first sync or backfill is running, competing for Gmail.
        sync_busy: bool,
    },
}

impl SyncEvent {
    pub fn name(&self) -> &'static str {
        match self {
            SyncEvent::NewMail { .. } => "sync:new_mail",
            SyncEvent::Started { .. } => "sync:started",
            SyncEvent::MessagesUpdated { .. } => "sync:messages_updated",
            SyncEvent::LabelsUpdated { .. } => "sync:labels_updated",
            SyncEvent::Completed { .. } => "sync:completed",
            SyncEvent::Error { .. } => "sync:error",
            SyncEvent::OpRejected { .. } => "outbox:rejected",
            SyncEvent::SendStatus { .. } => "outbox:send_status",
            SyncEvent::ThreadLoading { .. } => "mail:thread_loading",
        }
    }

    pub fn messages_updated(account_id: &str, r: crate::db::threads::RecomputeResult) -> Self {
        SyncEvent::MessagesUpdated {
            account_id: account_id.to_owned(),
            added: r.created,
            removed: r.removed,
            modified: r.updated,
        }
    }
}

pub trait SyncEvents: Send + Sync {
    fn emit(&self, event: SyncEvent);
}

pub struct NoopEvents;

impl SyncEvents for NoopEvents {
    fn emit(&self, _: SyncEvent) {}
}

#[cfg(test)]
#[derive(Default)]
pub struct RecordingEvents(std::sync::Mutex<Vec<SyncEvent>>);

#[cfg(test)]
impl RecordingEvents {
    pub fn take(&self) -> Vec<SyncEvent> {
        std::mem::take(&mut self.0.lock().unwrap())
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.take().iter().map(SyncEvent::name).collect()
    }
}

#[cfg(test)]
impl SyncEvents for RecordingEvents {
    fn emit(&self, event: SyncEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_and_camel_case_payload() {
        let e = SyncEvent::MessagesUpdated {
            account_id: "a".into(),
            added: vec!["t1".into()],
            removed: vec![],
            modified: vec!["t2".into()],
        };
        assert_eq!(e.name(), "sync:messages_updated");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"accountId": "a", "added": ["t1"], "removed": [], "modified": ["t2"]})
        );
        let e = SyncEvent::OpRejected {
            account_id: "a".into(),
            op_id: "o".into(),
            kind: "modify".into(),
            message: "no".into(),
        };
        assert_eq!(e.name(), "outbox:rejected");
        assert_eq!(serde_json::to_value(&e).unwrap()["opId"], "o");
        let e = SyncEvent::ThreadLoading {
            account_id: "a".into(),
            thread_id: "t".into(),
            stage: "retrying",
            attempt: Some(0),
            retry_in_ms: Some(8000),
            reason: Some("rate_limited"),
            sync_busy: true,
        };
        assert_eq!(e.name(), "mail:thread_loading");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"accountId": "a", "threadId": "t", "stage": "retrying",
                "attempt": 0, "retryInMs": 8000, "reason": "rate_limited", "syncBusy": true})
        );
    }
}
