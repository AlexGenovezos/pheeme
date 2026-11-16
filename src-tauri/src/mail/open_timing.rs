//! Timing and progress of opening a thread: the `mail:thread_loading` events while its
//! bodies are fetched, and the timing kept (and logged) for each open.

use super::{MailError, MailService, ThreadDetailDto};
use crate::diagnostics::{ms_since, OpenTiming};
use crate::gmail::probe::{ProbeStage, ProbeStats, RequestProbe};
use crate::sync::engine::now_ms;
use crate::sync::manager::SyncManager;
use crate::sync::SyncEvent;
use std::sync::Arc;
use std::time::Instant;

impl MailService {
    /// A probe that reports an opened thread's fetch as `mail:thread_loading` events.
    pub(super) fn loading_probe(&self, account_id: &str, thread_id: &str) -> Arc<RequestProbe> {
        let sync = self.sync.clone();
        let (account_id, thread_id) = (account_id.to_owned(), thread_id.to_owned());
        RequestProbe::new(move |stage| emit_loading(&sync, &account_id, &thread_id, Some(stage)))
    }

    /// Keep the open's timing and log it: at `info` when it went to Gmail or was slow.
    pub(super) fn record_open(
        &self,
        account_id: &str,
        start: Instant,
        fetch: Option<BodyFetch>,
        result: &Result<ThreadDetailDto, MailError>,
    ) {
        let outcome = match result {
            Ok(detail) => detail.body_error.as_ref().map_or("ok", |e| e.code.as_str()),
            Err(e) => e.code(),
        };
        let stats = fetch.as_ref().map(|f| f.stats.clone()).unwrap_or_default();
        let timing = OpenTiming {
            at_ms: now_ms(),
            source: if fetch.is_some() { "gmail" } else { "cache" },
            total_ms: ms_since(start),
            slot_wait_ms: stats.slot_wait_ms,
            quota_wait_ms: stats.quota_wait_ms,
            gmail_ms: stats.gmail_ms,
            retries: stats.retries,
            last_status: stats.last_status,
            last_reason: stats.last_reason,
            messages_fetched: fetch.as_ref().map_or(0, |f| f.fetched),
            sync_busy: fetch.map_or_else(|| self.sync.sync_busy(account_id), |f| f.sync_busy),
            outcome: outcome.to_owned(),
        };
        macro_rules! log_open {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    source = timing.source,
                    total_ms = timing.total_ms,
                    slot_wait_ms = timing.slot_wait_ms,
                    quota_wait_ms = timing.quota_wait_ms,
                    gmail_ms = timing.gmail_ms,
                    retries = timing.retries,
                    last_status = ?timing.last_status,
                    last_reason = ?timing.last_reason,
                    messages_fetched = timing.messages_fetched,
                    sync_busy = timing.sync_busy,
                    outcome = %timing.outcome,
                    "thread opened"
                )
            };
        }
        if timing.source == "gmail" || timing.total_ms > 1000 {
            log_open!(tracing::Level::INFO);
        } else {
            log_open!(tracing::Level::DEBUG);
        }
        self.opens.record(timing);
    }
}

/// What fetching an opened thread's missing bodies took.
pub(super) struct BodyFetch {
    pub(super) stats: ProbeStats,
    /// Bodies it stored.
    pub(super) fetched: usize,
    pub(super) sync_busy: bool,
}

/// Emit `mail:thread_loading` for an opened thread; `None` is `done`.
pub(super) fn emit_loading(
    sync: &SyncManager,
    account_id: &str,
    thread_id: &str,
    stage: Option<ProbeStage>,
) {
    let (stage, attempt, retry_in_ms, reason) = match stage {
        Some(ProbeStage::Queued) => ("queued", None, None, None),
        Some(ProbeStage::Fetching) => ("fetching", None, None, None),
        Some(ProbeStage::Retrying {
            attempt,
            retry_in,
            reason,
        }) => (
            "retrying",
            Some(attempt),
            Some(retry_in.as_millis() as u64),
            Some(reason.as_str()),
        ),
        None => ("done", None, None, None),
    };
    sync.emit(SyncEvent::ThreadLoading {
        account_id: account_id.to_owned(),
        thread_id: thread_id.to_owned(),
        stage,
        attempt,
        retry_in_ms,
        reason,
        sync_busy: sync.sync_busy(account_id),
    });
}
