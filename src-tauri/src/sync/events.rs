//! What the sync engine tells the UI. The Tauri layer forwards each event with
//! `app.emit(event.name(), event)`; tests record them.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum SyncEvent {
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
}

impl SyncEvent {
    pub fn name(&self) -> &'static str {
        match self {
            SyncEvent::Started { .. } => "sync:started",
            SyncEvent::MessagesUpdated { .. } => "sync:messages_updated",
            SyncEvent::LabelsUpdated { .. } => "sync:labels_updated",
            SyncEvent::Completed { .. } => "sync:completed",
            SyncEvent::Error { .. } => "sync:error",
            SyncEvent::OpRejected { .. } => "outbox:rejected",
            SyncEvent::SendStatus { .. } => "outbox:send_status",
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
    }
}
