//! The outbox: optimistic label/trash changes and sends, persisted and replayed in order.
//!
//! A queued change is applied to the cache at once. Until Gmail accepts it, every sync
//! that touches its thread re-applies it on top of the server state ([`rebase_threads`]),
//! so the history record our own change produces is a no-op and other devices' unrelated
//! changes survive. Network trouble keeps it queued; only a definitive Gmail rejection
//! rolls it back.
//!
//! Sends are never retried automatically once Gmail may have received them: they're
//! marked `checking` before the request goes out and then confirmed by finding the
//! message in Sent (cache, search with backoff, or incoming sync).

use super::engine::{now_ms, SyncEngine, SyncError};
use super::events::SyncEvent;
use crate::db::outbox::{self as store, DbOp, DbOpMessage, OpProgress};
use crate::db::threads::{self, RecomputeResult};
use crate::db::{self, messages};
use crate::gmail::mime::{encode_base64url, rfc822_message_id};
use crate::gmail::{GmailError, MessageFormat};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeSet, HashMap};

pub const KIND_MODIFY: &str = "modify";
pub const KIND_TRASH: &str = "trash";
pub const KIND_SEND: &str = "send";

pub const PENDING: &str = "pending";
/// Sends only: Gmail may have it; confirming via Sent.
pub const CHECKING: &str = "checking";
/// Sends only: every scheduled check came back empty; still watched by sync.
pub const UNCONFIRMED: &str = "unconfirmed";
/// Sends only: Gmail rejected it.
pub const FAILED: &str = "failed";

/// Delay before each Sent search after an ambiguous send: ≈30 s, 2 min, 10 min.
pub const CHECK_DELAYS_MS: [i64; 3] = [30_000, 120_000, 600_000];
/// When a Sent search itself fails, try it again after this long without advancing.
const SEARCH_RETRY_MS: i64 = 30_000;
const BACKOFF_BASE_MS: i64 = 5_000;
const BACKOFF_MAX_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Payload {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    add: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    remove: Vec<String>,
    /// Sends: base64url RFC 2822 message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
}

impl Payload {
    fn of(op: &DbOp) -> Result<Self, SyncError> {
        serde_json::from_str(&op.payload)
            .map_err(|e| SyncError::Db(anyhow::anyhow!("outbox op {} is corrupt: {e}", op.id)))
    }

    /// The op's effect on one message's labels.
    fn apply(&self, kind: &str, labels: &[String]) -> Vec<String> {
        let mut out: Vec<String> = labels.to_vec();
        let (add, remove): (&[String], &[String]) = match kind {
            KIND_TRASH => (&[], &[]),
            _ => (&self.add, &self.remove),
        };
        out.retain(|l| !remove.contains(l));
        for l in add {
            if !out.contains(l) {
                out.push(l.clone());
            }
        }
        if kind == KIND_TRASH && !out.iter().any(|l| l == "TRASH") {
            out.push("TRASH".into());
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueResult {
    pub op_id: String,
    pub threads: RecomputeResult,
}

/// Queue a label change on whole threads and apply it to the cache now.
/// `None` when none of the threads has cached messages.
pub async fn enqueue_modify(
    pool: &SqlitePool,
    account_id: &str,
    thread_ids: &[String],
    add: &[String],
    remove: &[String],
) -> Result<Option<EnqueueResult>, SyncError> {
    let payload = Payload {
        thread_ids: thread_ids.to_vec(),
        add: add.to_vec(),
        remove: remove.to_vec(),
        raw: None,
    };
    enqueue(pool, account_id, KIND_MODIFY, payload).await
}

/// Queue moving whole threads to Trash and apply it to the cache now.
pub async fn enqueue_trash(
    pool: &SqlitePool,
    account_id: &str,
    thread_ids: &[String],
) -> Result<Option<EnqueueResult>, SyncError> {
    let payload = Payload {
        thread_ids: thread_ids.to_vec(),
        ..Default::default()
    };
    enqueue(pool, account_id, KIND_TRASH, payload).await
}

async fn enqueue(
    pool: &SqlitePool,
    account_id: &str,
    kind: &str,
    payload: Payload,
) -> Result<Option<EnqueueResult>, SyncError> {
    let mut tx = db::begin_write(pool).await?;
    let op_id = uuid::Uuid::new_v4().to_string();
    let mut targets = Vec::new();
    for thread_id in &payload.thread_ids {
        for msg in messages::get_messages_for_thread(&mut *tx, account_id, thread_id).await? {
            targets.push((msg.id.clone(), thread_id.clone(), msg.labels()));
        }
    }
    if targets.is_empty() {
        return Ok(None);
    }
    let now = now_ms();
    let op = DbOp {
        seq: 0,
        id: op_id.clone(),
        account_id: account_id.to_owned(),
        kind: kind.to_owned(),
        payload: serde_json::to_string(&payload).map_err(anyhow::Error::from)?,
        status: PENDING.into(),
        attempts: 0,
        next_attempt_at: 0,
        checks_done: 0,
        rfc822_message_id: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    };
    let rows: Vec<DbOpMessage> = targets
        .iter()
        .map(|(message_id, thread_id, labels)| DbOpMessage {
            op_id: op_id.clone(),
            account_id: account_id.to_owned(),
            message_id: message_id.clone(),
            thread_id: thread_id.clone(),
            prior_label_ids: serde_json::to_string(labels).expect("strings serialize"),
        })
        .collect();
    store::insert(&mut tx, &op, &rows).await?;
    for (message_id, _, labels) in &targets {
        let next = payload.apply(kind, labels);
        messages::set_labels(&mut tx, account_id, message_id, &next).await?;
    }
    let result = threads::recompute_threads(&mut tx, account_id, &payload.thread_ids).await?;
    tx.commit().await?;
    Ok(Some(EnqueueResult {
        op_id,
        threads: result,
    }))
}

/// Re-apply pending label/trash ops (oldest first) to their messages in `thread_ids`.
/// Runs inside every sync write, before threads are recomputed.
///
/// An op covers the messages of its threads cached when it was queued, plus any older
/// message cached since (backfill), which is recorded as a target now; mail that arrived
/// after the user acted is left alone. `restored` (after a rollback put these messages back
/// to a base state) re-takes each op's rollback labels for them just before replaying it.
pub async fn rebase_threads(
    conn: &mut SqliteConnection,
    account_id: &str,
    thread_ids: &[String],
    restored: &BTreeSet<String>,
) -> Result<(), SyncError> {
    if thread_ids.is_empty() {
        return Ok(());
    }
    let wanted: BTreeSet<&String> = thread_ids.iter().collect();
    for op in store::pending_touching_threads(conn, account_id, thread_ids).await? {
        let payload = Payload::of(&op)?;
        let recorded: BTreeSet<String> = store::messages_of(&mut *conn, &op.id)
            .await?
            .into_iter()
            .map(|t| t.message_id)
            .collect();
        for thread_id in payload.thread_ids.iter().filter(|t| wanted.contains(t)) {
            for msg in messages::get_messages_for_thread(&mut *conn, account_id, thread_id).await? {
                let labels = msg.labels();
                let target = DbOpMessage {
                    op_id: op.id.clone(),
                    account_id: account_id.to_owned(),
                    message_id: msg.id.clone(),
                    thread_id: thread_id.clone(),
                    prior_label_ids: serde_json::to_string(&labels).expect("strings serialize"),
                };
                if !recorded.contains(&msg.id) {
                    if !msg.date.is_some_and(|d| d <= op.created_at) {
                        continue;
                    }
                    store::add_target(&mut *conn, &target).await?;
                } else if restored.contains(&msg.id) {
                    store::set_prior(&mut *conn, &target).await?;
                }
                let next = payload.apply(&op.kind, &labels);
                if next != labels {
                    messages::set_labels(conn, account_id, &msg.id, &next).await?;
                }
            }
        }
    }
    Ok(())
}

/// Confirm sends whose message is now cached in Sent. Returns the confirmed op ids.
pub async fn match_sends(
    conn: &mut SqliteConnection,
    account_id: &str,
) -> Result<Vec<String>, SyncError> {
    let mut done = Vec::new();
    for op in store::sends_awaiting_confirmation(&mut *conn, account_id).await? {
        let Some(rfc) = op.rfc822_message_id.as_deref() else {
            continue;
        };
        if messages::find_sent_by_rfc822(&mut *conn, account_id, rfc)
            .await?
            .is_some()
        {
            store::delete(&mut *conn, &op.id).await?;
            done.push(op.id);
        }
    }
    Ok(done)
}

/// Queue an RFC 2822 message for sending. Keeps its `Message-ID` or adds one; the id is
/// how delivery gets confirmed after an ambiguous failure. Returns the op id.
pub async fn queue_send(
    pool: &SqlitePool,
    account_id: &str,
    raw: &[u8],
) -> Result<String, SyncError> {
    let (message_id, raw) = match rfc822_message_id(raw) {
        Some(id) => (id, raw.to_vec()),
        None => {
            let id = format!("<{}@pheeme.app>", uuid::Uuid::new_v4());
            let mut with = format!("Message-ID: {id}\r\n").into_bytes();
            with.extend_from_slice(raw);
            (id, with)
        }
    };
    let now = now_ms();
    let op = DbOp {
        seq: 0,
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account_id.to_owned(),
        kind: KIND_SEND.into(),
        payload: serde_json::to_string(&Payload {
            raw: Some(encode_base64url(&raw)),
            ..Default::default()
        })
        .map_err(anyhow::Error::from)?,
        status: PENDING.into(),
        attempts: 0,
        next_attempt_at: 0,
        checks_done: 0,
        rfc822_message_id: Some(message_id),
        last_error: None,
        created_at: now,
        updated_at: now,
    };
    let mut tx = db::begin_write(pool).await?;
    store::insert(&mut tx, &op, &[]).await?;
    tx.commit().await?;
    Ok(op.id)
}

/// "Send again" after the user confirmed: only for a send that's unconfirmed or failed.
/// It keeps its Message-ID.
pub async fn resend(pool: &SqlitePool, op_id: &str) -> Result<bool, SyncError> {
    let Some(op) = store::get(pool, op_id).await? else {
        return Ok(false);
    };
    if op.kind != KIND_SEND || !(op.status == UNCONFIRMED || op.status == FAILED) {
        return Ok(false);
    }
    let progress = OpProgress {
        status: PENDING,
        attempts: op.attempts,
        next_attempt_at: 0,
        checks_done: 0,
        last_error: None,
    };
    store::update_progress(pool, op_id, &progress, now_ms()).await?;
    Ok(true)
}

/// Gmail definitively refused (not a network, auth, rate-limit or server problem).
fn is_rejection(e: &GmailError) -> bool {
    matches!(e, GmailError::Api { status, .. } if (400..500).contains(status) && *status != 401 && *status != 429)
}

/// The request certainly didn't reach Gmail, so sending it again can't duplicate it.
fn never_sent(e: &GmailError) -> bool {
    matches!(
        e,
        GmailError::Offline(_) | GmailError::RateLimit { .. } | GmailError::Auth(_)
    )
}

fn backoff(attempts: i64) -> i64 {
    let exp = attempts.clamp(0, 16) as u32;
    BACKOFF_BASE_MS.saturating_mul(1 << exp).min(BACKOFF_MAX_MS)
}

/// Push the account's queued changes to Gmail, oldest first. A change that hits a
/// network problem stops the queue (order matters) until its backoff passes. Sends being
/// confirmed don't block anything. Returns whether any op finished.
pub async fn process(engine: &SyncEngine, now: i64) -> Result<bool, SyncError> {
    let mut progressed = false;
    for op in store::for_account(&engine.db, &engine.account_id).await? {
        match (op.kind.as_str(), op.status.as_str()) {
            (KIND_SEND, CHECKING) => {
                if op.next_attempt_at <= now && check_send(engine, &op, now).await? {
                    progressed = true;
                }
            }
            (KIND_SEND, UNCONFIRMED | FAILED) => {}
            (_, PENDING) => {
                if op.next_attempt_at > now {
                    break;
                }
                let step = if op.kind == KIND_SEND {
                    send(engine, &op, now).await?
                } else {
                    apply_op(engine, &op, now).await?
                };
                match step {
                    Step::Done => progressed = true,
                    Step::Continue => {}
                    Step::Blocked => break,
                }
            }
            _ => {}
        }
    }
    Ok(progressed)
}

enum Step {
    Done,
    Continue,
    Blocked,
}

async fn defer(
    engine: &SyncEngine,
    op: &DbOp,
    now: i64,
    error: &GmailError,
) -> Result<(), SyncError> {
    let progress = OpProgress {
        status: PENDING,
        attempts: op.attempts + 1,
        next_attempt_at: now + backoff(op.attempts),
        checks_done: op.checks_done,
        last_error: Some(&error.to_string()),
    };
    store::update_progress(&engine.db, &op.id, &progress, now).await?;
    Ok(())
}

async fn apply_op(engine: &SyncEngine, op: &DbOp, now: i64) -> Result<Step, SyncError> {
    let payload = Payload::of(op)?;
    let recorded: BTreeSet<String> = store::messages_of(&engine.db, &op.id)
        .await?
        .into_iter()
        .map(|t| t.message_id)
        .collect();
    let result = async {
        // The thread as Gmail has it now: older messages we never cached are included,
        // mail that arrived after the user acted is not.
        let mut ids = Vec::new();
        for thread_id in &payload.thread_ids {
            match engine
                .api
                .get_thread(thread_id, MessageFormat::Minimal)
                .await
            {
                Ok(thread) => ids.extend(
                    thread
                        .messages
                        .iter()
                        .filter(|m| {
                            recorded.contains(&m.id)
                                || m.internal_date_ms().is_some_and(|d| d <= op.created_at)
                        })
                        .map(|m| m.id.clone()),
                ),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(e),
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        if op.kind == KIND_TRASH {
            for id in &ids {
                match engine.api.trash_message(id).await {
                    Ok(()) => {}
                    Err(e) if e.is_not_found() => {}
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        } else {
            engine
                .api
                .batch_modify(&ids, &payload.add, &payload.remove)
                .await
        }
    }
    .await;
    match result {
        Ok(()) => {
            store::delete(&engine.db, &op.id).await?;
            Ok(Step::Done)
        }
        Err(e) if is_rejection(&e) => {
            rollback(engine, op, &e).await?;
            Ok(Step::Continue)
        }
        Err(e) => {
            defer(engine, op, now, &e).await?;
            Ok(Step::Blocked)
        }
    }
}

/// Undo a rejected change: messages go back to Gmail's current labels (or, if those
/// can't be read, to their labels before the change); later queued changes are re-applied.
async fn rollback(engine: &SyncEngine, op: &DbOp, error: &GmailError) -> Result<(), SyncError> {
    let targets = store::messages_of(&engine.db, &op.id).await?;
    let ids: Vec<String> = targets.iter().map(|t| t.message_id.clone()).collect();
    let server: HashMap<String, Vec<String>> = engine
        .api
        .batch_get_messages(&ids, MessageFormat::Minimal)
        .await
        .into_iter()
        .filter_map(|(id, r)| r.ok().map(|m| (id, m.label_ids)))
        .collect();

    let _guard = engine.write_lock.lock().await;
    let mut tx = db::begin_write(&engine.db).await?;
    // Re-read: backfill may have added targets while Gmail was being asked.
    let targets = store::messages_of(&mut *tx, &op.id).await?;
    store::delete(&mut *tx, &op.id).await?;
    let mut touched = Vec::new();
    for t in &targets {
        let labels = match server.get(&t.message_id) {
            Some(l) => l.clone(),
            None => messages::parse_labels(Some(&t.prior_label_ids)),
        };
        messages::set_labels(&mut tx, &engine.account_id, &t.message_id, &labels).await?;
        touched.push(t.thread_id.clone());
    }
    let restored: BTreeSet<String> = targets.iter().map(|t| t.message_id.clone()).collect();
    rebase_threads(&mut tx, &engine.account_id, &touched, &restored).await?;
    let result = threads::recompute_threads(&mut tx, &engine.account_id, &touched).await?;
    tx.commit().await?;

    if !result.is_empty() {
        engine
            .events
            .emit(SyncEvent::messages_updated(&engine.account_id, result));
    }
    engine.events.emit(SyncEvent::OpRejected {
        account_id: engine.account_id.clone(),
        op_id: op.id.clone(),
        kind: op.kind.clone(),
        message: error.to_string(),
    });
    Ok(())
}

fn send_status(engine: &SyncEngine, op: &DbOp, status: &str) {
    engine.events.emit(SyncEvent::SendStatus {
        account_id: engine.account_id.clone(),
        op_id: op.id.clone(),
        status: status.into(),
    });
}

async fn send(engine: &SyncEngine, op: &DbOp, now: i64) -> Result<Step, SyncError> {
    let raw = Payload::of(op)?
        .raw
        .ok_or_else(|| SyncError::Db(anyhow::anyhow!("send {} has no message", op.id)))?;
    // Recorded before the request leaves: if the app dies mid-send, it's confirmed through
    // Sent on the next run instead of being sent again.
    let checking = OpProgress {
        status: CHECKING,
        attempts: op.attempts + 1,
        next_attempt_at: now + CHECK_DELAYS_MS[0],
        checks_done: 0,
        last_error: None,
    };
    store::update_progress(&engine.db, &op.id, &checking, now).await?;

    match engine.api.send_message(&raw).await {
        Ok(_) => {
            store::delete(&engine.db, &op.id).await?;
            send_status(engine, op, "sent");
            Ok(Step::Done)
        }
        Err(e) if never_sent(&e) => {
            defer(
                engine,
                &DbOp {
                    attempts: op.attempts,
                    ..op.clone()
                },
                now,
                &e,
            )
            .await?;
            Ok(Step::Blocked)
        }
        Err(e) if is_rejection(&e) => {
            let failed = OpProgress {
                status: FAILED,
                attempts: op.attempts + 1,
                next_attempt_at: 0,
                checks_done: 0,
                last_error: Some(&e.to_string()),
            };
            store::update_progress(&engine.db, &op.id, &failed, now).await?;
            send_status(engine, op, FAILED);
            Ok(Step::Continue)
        }
        Err(e) => {
            tracing::warn!(op = %op.id, error = %e, "send outcome unknown; confirming via Sent");
            send_status(engine, op, CHECKING);
            Ok(Step::Continue)
        }
    }
}

/// One scheduled confirmation check for an ambiguous send. Returns whether it confirmed.
async fn check_send(engine: &SyncEngine, op: &DbOp, now: i64) -> Result<bool, SyncError> {
    let Some(rfc) = op.rfc822_message_id.as_deref() else {
        return Ok(false);
    };
    let found = if messages::find_sent_by_rfc822(&engine.db, &engine.account_id, rfc)
        .await?
        .is_some()
    {
        true
    } else {
        match engine
            .api
            .search_messages(&format!("rfc822msgid:{rfc} in:sent"))
            .await
        {
            Ok(page) => !page.messages.is_empty(),
            Err(e) => {
                // A failed search isn't a check: retry it without advancing the schedule.
                tracing::info!(op = %op.id, error = %e, "Sent search failed; retrying");
                let retry = OpProgress {
                    status: CHECKING,
                    attempts: op.attempts,
                    next_attempt_at: now + SEARCH_RETRY_MS,
                    checks_done: op.checks_done,
                    last_error: Some(&e.to_string()),
                };
                store::update_progress(&engine.db, &op.id, &retry, now).await?;
                return Ok(false);
            }
        }
    };
    if found {
        store::delete(&engine.db, &op.id).await?;
        send_status(engine, op, "sent");
        return Ok(true);
    }
    let checks_done = op.checks_done + 1;
    let (status, next) = match CHECK_DELAYS_MS.get(checks_done as usize) {
        Some(delay) => (CHECKING, now + delay),
        None => (UNCONFIRMED, 0),
    };
    let progress = OpProgress {
        status,
        attempts: op.attempts,
        next_attempt_at: next,
        checks_done,
        last_error: None,
    };
    store::update_progress(&engine.db, &op.id, &progress, now).await?;
    if status == UNCONFIRMED {
        send_status(engine, op, UNCONFIRMED);
    }
    Ok(false)
}
