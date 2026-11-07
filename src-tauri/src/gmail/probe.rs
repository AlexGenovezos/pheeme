//! A request probe: lets the code that opens a thread for the reader see what its Gmail requests
//! wait on (request slots, quota, retries) without threading anything through the `MailApi`
//! trait. [`with_probe`] puts a probe in scope for a future (a tokio task-local, so it reaches
//! every request made by that future, `buffer_unordered` included, but not spawned tasks), and
//! [`GmailClient::execute`](super::client::GmailClient) reports to it. A probed request is the
//! reader's: it skips the background slots like an attachment download does.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

tokio::task_local! {
    static PROBE: Arc<RequestProbe>;
}

/// Why a request is being retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryReason {
    /// Gmail answered 429 or a rate-limit 403.
    RateLimited,
    /// The request failed before Gmail answered (connection, timeout).
    Network,
    /// Gmail answered 5xx.
    Server,
}

impl RetryReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RetryReason::RateLimited => "rate_limited",
            RetryReason::Network => "network",
            RetryReason::Server => "server",
        }
    }
}

/// Where a probed request has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeStage {
    /// Waiting for a request slot or the quota limiter.
    Queued,
    /// Sent to Gmail.
    Fetching,
    /// Attempt `attempt` (0-based) failed; the next one goes after `retry_in`.
    Retrying {
        attempt: u32,
        retry_in: Duration,
        reason: RetryReason,
    },
}

/// What the probed requests spent their time on. Waits are summed over requests, so with
/// several in flight they can add up to more than the wall-clock time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeStats {
    pub slot_wait_ms: u64,
    pub quota_wait_ms: u64,
    /// Time from sending a request to having read its response.
    pub gmail_ms: u64,
    /// Attempts sent, retries included.
    pub requests: u32,
    pub retries: u32,
    /// HTTP status of the last failed attempt.
    pub last_status: Option<u16>,
    /// Gmail's reason for the last failed attempt (`rateLimitExceeded`, ...), or `network`.
    pub last_reason: Option<String>,
}

pub struct RequestProbe {
    on_stage: Box<dyn Fn(ProbeStage) + Send + Sync>,
    state: Mutex<ProbeState>,
}

#[derive(Default)]
struct ProbeState {
    last_stage: Option<ProbeStage>,
    stats: ProbeStats,
}

fn ms(d: Duration) -> u64 {
    d.as_millis() as u64
}

impl RequestProbe {
    /// `on_stage` hears each change of stage (repeats of the same stage are dropped).
    pub fn new(on_stage: impl Fn(ProbeStage) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            on_stage: Box::new(on_stage),
            state: Mutex::new(ProbeState::default()),
        })
    }

    pub fn snapshot(&self) -> ProbeStats {
        self.state().stats.clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ProbeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn stage(&self, stage: ProbeStage) {
        let changed = self.state().last_stage.replace(stage) != Some(stage);
        if changed {
            (self.on_stage)(stage);
        }
    }

    pub(crate) fn slot_wait(&self, waited: Duration) {
        self.state().stats.slot_wait_ms += ms(waited);
    }

    pub(crate) fn quota_wait(&self, waited: Duration) {
        self.state().stats.quota_wait_ms += ms(waited);
    }

    /// One attempt went to Gmail and took `took` to answer (or fail).
    pub(crate) fn sent(&self, took: Duration) {
        let mut state = self.state();
        state.stats.requests += 1;
        state.stats.gmail_ms += ms(took);
    }

    pub(crate) fn failed(&self, status: Option<u16>, reason: Option<&str>) {
        let mut state = self.state();
        state.stats.last_status = status;
        state.stats.last_reason = reason.map(str::to_owned);
    }

    /// Report a retry: counts it and moves to [`ProbeStage::Retrying`].
    pub(crate) fn retrying(&self, attempt: u32, retry_in: Duration, reason: RetryReason) {
        self.state().stats.retries += 1;
        self.stage(ProbeStage::Retrying {
            attempt,
            retry_in,
            reason,
        });
    }
}

/// Run `f` with `probe` in scope for every Gmail request it makes.
pub async fn with_probe<F: Future>(probe: Arc<RequestProbe>, f: F) -> F::Output {
    PROBE.scope(probe, f).await
}

/// The probe in scope, if any.
pub(crate) fn current() -> Option<Arc<RequestProbe>> {
    PROBE.try_with(Arc::clone).ok()
}

/// Report `stage` to the probe in scope, if any (for API stand-ins that don't go through
/// [`GmailClient::execute`](super::client::GmailClient)).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn report(stage: ProbeStage) {
    if let Some(probe) = current() {
        probe.stage(stage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repeated_stages_are_reported_once_and_only_in_scope() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let probe = RequestProbe::new(move |s| log.lock().unwrap().push(s));
        report(ProbeStage::Queued); // no probe in scope: ignored
        with_probe(probe.clone(), async {
            report(ProbeStage::Queued);
            report(ProbeStage::Queued);
            report(ProbeStage::Fetching);
            assert!(current().is_some());
        })
        .await;
        assert!(current().is_none());
        assert_eq!(
            *seen.lock().unwrap(),
            [ProbeStage::Queued, ProbeStage::Fetching]
        );
    }
}
