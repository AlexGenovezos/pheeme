use super::schema::MAX_JSON;
use rquickjs::{Context, Function, Runtime};
use serde::Deserialize;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub id: u64,
    pub method: String,
    pub args: Value,
}

pub enum Event {
    Call(Call),
    Failed,
}

pub struct Worker {
    pub sender: mpsc::SyncSender<Value>,
    pub stopped: Arc<AtomicBool>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

impl Worker {
    pub fn start(
        source: String,
        events: tokio::sync::mpsc::Sender<Event>,
    ) -> Result<(Self, tokio::sync::oneshot::Receiver<bool>), String> {
        let (sender, receiver) = mpsc::sync_channel::<Value>(64);
        let stopped = Arc::new(AtomicBool::new(false));
        let cancel = stopped.clone();
        let (ready, result) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("pheeme-mod".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let outcome = run(source, receiver, events.clone(), cancel.clone(), ready);
                cancel.store(true, Ordering::SeqCst);
                if outcome.is_err() {
                    let _ = events.try_send(Event::Failed);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok((Self { sender, stopped }, result))
    }
}

fn run(
    source: String,
    receiver: mpsc::Receiver<Value>,
    events: tokio::sync::mpsc::Sender<Event>,
    stopped: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<bool>,
) -> Result<(), ()> {
    let runtime = Runtime::new().map_err(|_| ())?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let rejections = Arc::new(AtomicUsize::new(0));
    let rejected = rejections.clone();
    runtime.set_host_promise_rejection_tracker(Some(Box::new(move |_, _, _, handled| {
        if handled {
            rejected.fetch_sub(1, Ordering::SeqCst);
        } else {
            rejected.fetch_add(1, Ordering::SeqCst);
        }
    })));
    let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_millis(250)));
    let limit = deadline.clone();
    let cancel = stopped.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        cancel.load(Ordering::SeqCst) || Instant::now() > *limit.lock().unwrap()
    })));
    let context = Context::full(&runtime).map_err(|_| ())?;
    let event_sink = events.clone();
    let pending = Arc::new(AtomicUsize::new(0));
    let outgoing = pending.clone();
    let overflow = stopped.clone();
    context
        .with(|ctx| -> rquickjs::Result<()> {
            ctx.globals().set(
                "__host",
                Function::new(ctx.clone(), move |json: String| {
                    if json.len() > MAX_JSON {
                        overflow.store(true, Ordering::SeqCst);
                        return;
                    }
                    let sent = serde_json::from_str::<Call>(&json)
                        .ok()
                        .is_some_and(|call| {
                            if call.id != 0 {
                                outgoing.fetch_add(1, Ordering::SeqCst);
                            }
                            event_sink.try_send(Event::Call(call)).is_ok()
                        });
                    if !sent {
                        overflow.store(true, Ordering::SeqCst);
                    }
                })?,
            )?;
            ctx.eval::<(), _>(include_str!("bootstrap.js"))?;
            ctx.eval::<(), _>(source)
        })
        .map_err(|_| ())?;
    drain(&runtime, &deadline, &stopped)?;
    if rejections.load(Ordering::SeqCst) != 0 {
        return Err(());
    }
    let mut ready = Some(ready);
    while !stopped.load(Ordering::SeqCst) {
        if pending.load(Ordering::SeqCst) == 0 {
            if let Some(ready) = ready.take() {
                ready.send(true).map_err(|_| ())?;
            }
        }
        let message = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if ready.is_some() {
                    continue;
                }
                serde_json::json!({"type":"tick", "now": chrono::Utc::now().timestamp_millis()})
            }
            Err(_) => break,
        };
        if message["type"] == "reply" {
            pending.fetch_sub(1, Ordering::SeqCst);
        }
        *deadline.lock().unwrap() = Instant::now() + Duration::from_millis(250);
        context
            .with(|ctx| {
                ctx.globals()
                    .get::<_, Function>("__dispatch")?
                    .call::<_, ()>((message.to_string(),))
            })
            .map_err(|_| ())?;
        drain(&runtime, &deadline, &stopped)?;
        if rejections.load(Ordering::SeqCst) != 0 {
            return Err(());
        }
    }
    Ok(())
}

fn drain(runtime: &Runtime, deadline: &Mutex<Instant>, stopped: &AtomicBool) -> Result<(), ()> {
    // One deadline covers the entire microtask queue, including self-scheduling promises.
    while runtime.is_job_pending() {
        if stopped.load(Ordering::SeqCst) || Instant::now() > *deadline.lock().unwrap() {
            return Err(());
        }
        runtime.execute_pending_job().map_err(|_| ())?;
    }
    Ok(())
}
