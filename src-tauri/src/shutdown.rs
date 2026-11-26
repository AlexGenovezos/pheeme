//! Stops background work and waits for it to release its database access before closing the pool.

use std::future::Future;
use std::sync::LazyLock;
use tokio::sync::watch;

/// A stop signal whose receivers also track the work that needs to drain.
#[derive(Clone)]
pub struct Shutdown(watch::Sender<bool>);

impl Default for Shutdown {
    fn default() -> Self {
        Self(watch::Sender::new(false))
    }
}

impl Shutdown {
    /// Signal shutdown and wait for every registered task to drop its receiver.
    pub async fn drain(&self) {
        self.0.send_replace(true);
        self.0.closed().await;
    }

    /// Register before spawning so even a task that has yet to run is covered by the drain.
    pub fn track(&self) -> Option<Stop> {
        let stop = Stop(self.0.subscribe());
        (!stop.stopping()).then_some(stop)
    }

    /// Registers a task whose future can be dropped as soon as shutdown starts.
    pub fn until<F: Future<Output = ()>>(&self, task: F) -> impl Future<Output = ()> + use<F> {
        // Drop the task before its receiver even if the wrapper is never polled.
        let registered = (task, self.track());
        async move {
            let (task, stop) = registered;
            if let Some(stop) = stop {
                stop.until(task).await;
            }
        }
    }
}

/// Keeps the drain waiting while a task is still running. The task chooses where to stop.
pub struct Stop(watch::Receiver<bool>);

impl Stop {
    pub fn stopping(&self) -> bool {
        *self.0.borrow()
    }

    /// Cancel an interruptible part of the task. Prefer stopping even if work is also ready.
    pub async fn until<F: Future>(&self, task: F) -> Option<F::Output> {
        let mut signal = self.0.clone();
        tokio::select! {
            biased;
            _ = signal.wait_for(|stopping| *stopping) => None,
            output = task => Some(output),
        }
    }
}

/// The app's signal, begun on exit.
pub static APP: LazyLock<Shutdown> = LazyLock::new(Shutdown::default);

/// Runs `task` until it ends or Pheeme starts to exit.
pub fn until<F: Future<Output = ()>>(task: F) -> impl Future<Output = ()> + use<F> {
    APP.until(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn drain_waits_for_an_in_flight_future_to_be_dropped() {
        let shutdown = Shutdown::default();
        let (started, running) = oneshot::channel();
        let (until_dropped, mut dropped) = oneshot::channel::<()>();
        let looping = tokio::spawn(shutdown.until(async move {
            let _until_dropped = until_dropped;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        }));
        running.await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), shutdown.drain())
            .await
            .expect("the loop kept running after shutdown");
        assert_eq!(
            dropped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
        looping.await.unwrap();
    }

    #[tokio::test]
    async fn work_registered_before_shutdown_is_never_polled_after_the_signal() {
        let shutdown = Shutdown::default();
        let work = shutdown.until(async { panic!("work ran after shutdown") });
        let drain = shutdown.drain();
        tokio::pin!(drain);
        assert!(futures::poll!(&mut drain).is_pending());
        work.await;
        drain.await;
        shutdown
            .until(async { panic!("work registered after shutdown") })
            .await;
    }
}
