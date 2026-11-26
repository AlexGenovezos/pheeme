//! Stops background loops when Pheeme exits, before the database closes, so they end at
//! their next wait instead of sending queries to a pool that's shutting down.

use std::future::Future;
use std::sync::LazyLock;
use tokio::sync::watch;

/// A stop signal for background tasks: once begun, every task run through
/// [`Shutdown::until`] ends at its next `.await`.
pub struct Shutdown(watch::Sender<bool>);

impl Default for Shutdown {
    fn default() -> Self {
        Self(watch::Sender::new(false))
    }
}

impl Shutdown {
    /// Tell every task run through [`Self::until`] to stop.
    pub fn begin(&self) {
        self.0.send_replace(true);
    }

    /// Runs `task` until it ends or [`Self::begin`] is called, whichever comes first.
    pub fn until<F: Future<Output = ()>>(&self, task: F) -> impl Future<Output = ()> + use<F> {
        let mut stop = self.0.subscribe();
        async move {
            tokio::select! {
                () = task => {}
                Ok(_) = stop.wait_for(|stopping| *stopping) => {}
            }
        }
    }
}

/// The app's signal, begun on exit.
static APP: LazyLock<Shutdown> = LazyLock::new(Shutdown::default);

/// Stop the app's background tasks (Pheeme is exiting).
pub fn begin() {
    APP.begin();
}

/// Runs `task` until it ends or Pheeme starts to exit.
pub fn until<F: Future<Output = ()>>(task: F) -> impl Future<Output = ()> + use<F> {
    APP.until(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn a_loop_stops_when_shutdown_begins_and_a_finished_task_is_untouched() {
        let shutdown = Shutdown::default();
        let ticks = Arc::new(AtomicUsize::new(0));
        let counted = ticks.clone();
        let looping = tokio::spawn(shutdown.until(async move {
            loop {
                counted.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }));
        shutdown.until(async {}).await;
        while ticks.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        shutdown.begin();
        tokio::time::timeout(Duration::from_secs(1), looping)
            .await
            .expect("the loop kept running after shutdown")
            .unwrap();
        // Stopped, not just detached: it ticks no more.
        let stopped = ticks.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(ticks.load(Ordering::SeqCst), stopped);
    }
}
