//! Whether this device can reach Google. A sync that can't connect at all marks the app
//! offline: scheduled syncs stop and queued changes wait, while a light check runs every
//! [`PROBE_INTERVAL`] until Google answers again. Then everything syncs at once.

use futures::future::BoxFuture;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// How often to check for the connection while offline.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(5);
/// A check that hasn't connected by then counts as still offline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// What the check asks for: any HTTP answer (even an error status) means Google is reachable.
const PROBE_URL: &str = "https://gmail.googleapis.com/";

/// Answers whether Google can be reached right now.
pub type Probe = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;

/// The production check: one request through the same proxy settings as the Gmail client.
pub fn http_probe() -> Probe {
    let client = crate::http::client_builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .expect("reqwest client builds with a timeout");
    Arc::new(move || {
        let client = client.clone();
        Box::pin(async move { client.head(PROBE_URL).send().await.is_ok() })
    })
}

pub struct Connectivity {
    online: AtomicBool,
    probe: Probe,
    interval: Duration,
    /// Skips the rest of the wait before the next check (the window gained focus, a manual sync).
    wake: Notify,
}

impl Connectivity {
    pub fn new(probe: Probe, interval: Duration) -> Self {
        Self {
            online: AtomicBool::new(true),
            probe,
            interval,
            wake: Notify::new(),
        }
    }

    pub fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    /// Record that Google couldn't be reached. True when this is the change from online, so the
    /// caller starts [`Connectivity::wait_until_online`] (only one waits at a time).
    pub fn went_offline(&self) -> bool {
        self.online.swap(false, Ordering::SeqCst)
    }

    /// Check now instead of at the end of the current wait.
    pub fn check_soon(&self) {
        self.wake.notify_one();
    }

    /// Check every interval (or sooner when woken) until Google answers, then mark online.
    pub async fn wait_until_online(&self) {
        loop {
            tokio::select! {
                () = tokio::time::sleep(self.interval) => {}
                () = self.wake.notified() => {}
            }
            if (self.probe)().await {
                self.online.store(true, Ordering::SeqCst);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the network, and none to fail: `cargo test -- --ignored probe_` online, then
    /// `unshare -rn cargo test -- --ignored probe_finds_no_network` with networking cut.
    #[tokio::test]
    #[ignore]
    async fn probe_reaches_google() {
        assert!(http_probe()().await);
    }

    #[tokio::test]
    #[ignore]
    async fn probe_finds_no_network() {
        assert!(!http_probe()().await);
        // And a Gmail request fails as a connect error, which the client reports as `Offline`.
        let error = crate::http::client()
            .get(PROBE_URL)
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect(), "{error:?}");
    }

    #[tokio::test]
    async fn waits_until_the_check_answers_then_is_online() {
        let answers = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = answers.clone();
        let probe: Probe = Arc::new(move || {
            let n = counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { n >= 2 })
        });
        let c = Connectivity::new(probe, Duration::from_millis(1));
        assert!(c.went_offline(), "the first change starts the wait");
        assert!(!c.went_offline(), "already offline: nobody else waits");
        c.wait_until_online().await;
        assert!(c.online());
        assert_eq!(answers.load(Ordering::SeqCst), 3);
    }
}
