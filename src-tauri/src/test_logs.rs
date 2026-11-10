//! Capturing this thread's log lines in tests, to check what the diagnostic log records.
//!
//! One global subscriber, installed on first use, hands each line to the capture of the thread
//! that logged it. A per-thread subscriber (`set_default`) isn't enough: tracing caches whether
//! a log line is wanted across threads, and other tests running without one turn lines off.

use std::cell::RefCell;
use std::io::Write;
use std::sync::{Arc, Mutex, Once};

/// What was logged on this thread while its guard lived.
#[derive(Clone, Default)]
pub(crate) struct Logs(Arc<Mutex<Vec<u8>>>);

impl Logs {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    /// The lines containing `needle`.
    pub fn lines(&self, needle: &str) -> Vec<String> {
        self.text()
            .lines()
            .filter(|l| l.contains(needle))
            .map(str::to_owned)
            .collect()
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Logs>> = const { RefCell::new(None) };
}

/// Writes to the logging thread's capture, if it has one.
struct ToThread;

impl Write for ToThread {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        CURRENT.with(|c| {
            if let Some(logs) = c.borrow().as_ref() {
                logs.0.lock().unwrap().extend_from_slice(buf);
            }
        });
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Stops capturing when dropped.
pub(crate) struct Capturing;

impl Drop for Capturing {
    fn drop(&mut self) {
        CURRENT.with(|c| c.borrow_mut().take());
    }
}

/// Records `info` and up logged on this thread (a `#[tokio::test]` runs on one) until the
/// guard drops.
pub(crate) fn capture() -> (Capturing, Logs) {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(|| ToThread)
            .finish();
        // Another test may have installed one already; then lines go there instead.
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
    let logs = Logs::default();
    CURRENT.with(|c| *c.borrow_mut() = Some(logs.clone()));
    (Capturing, logs)
}
