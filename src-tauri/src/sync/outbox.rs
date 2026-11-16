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
//! message in Sent (cache, search with backoff, or incoming sync). A send may wait for an
//! undo window (`next_attempt_at`); until it's claimed it can be cancelled. Once Gmail has a
//! send that came from a saved draft, its op stays as a `cleanup` follow-up, holding only the
//! draft's id, until that draft is deleted.

use super::api::MailApi;
use super::engine::{now_ms, SyncEngine, SyncError};
use super::events::SyncEvent;
use crate::db::outbox::{self as store, DbOp, DbOpMessage, OpProgress};
use crate::db::threads::{self, RecomputeResult};
use crate::db::{self, messages};
use crate::gmail::mime::{
    decode_base64url, decode_header_value, encode_base64url, parse_addresses, rfc822_message_id,
    EmailAddress,
};
use crate::gmail::{GmailError, MessageFormat};
use mailparse::MailHeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeSet, HashMap};

/// What a queued op does, stored in `outbox.kind` as [`OpKind::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    /// Labels added to and removed from whole threads, or every message a search finds.
    Modify,
    /// Whole threads moved to Trash.
    Trash,
    /// A message to send.
    Send,
}

impl OpKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            OpKind::Modify => "modify",
            OpKind::Trash => "trash",
            OpKind::Send => "send",
        }
    }

    /// `None` for a kind this version doesn't know. Such an op is handled the way an
    /// unrecognised kind always was: when pending, as a label change.
    pub fn parse(s: &str) -> Option<Self> {
        [OpKind::Modify, OpKind::Trash, OpKind::Send]
            .into_iter()
            .find(|k| k.as_str() == s)
    }
}

/// Where a queued op stands, stored in `outbox.status` as [`OpStatus::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpStatus {
    /// Waiting to go to Gmail.
    Pending,
    /// Sends only: Gmail may have it; confirming via Sent.
    Checking,
    /// Sends only: every scheduled check came back empty; still watched by sync.
    Unconfirmed,
    /// Sends only: Gmail rejected it.
    Failed,
    /// Sends only: Gmail has the message, and the saved draft it came from is still to be
    /// deleted. The op keeps the draft's id and nothing of the message, so it can never be
    /// sent again.
    Cleanup,
}

impl OpStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            OpStatus::Pending => "pending",
            OpStatus::Checking => "checking",
            OpStatus::Unconfirmed => "unconfirmed",
            OpStatus::Failed => "failed",
            OpStatus::Cleanup => "cleanup",
        }
    }

    /// `None` for a status this version doesn't know; such an op is left alone.
    pub fn parse(s: &str) -> Option<Self> {
        [
            OpStatus::Pending,
            OpStatus::Checking,
            OpStatus::Unconfirmed,
            OpStatus::Failed,
            OpStatus::Cleanup,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }
}

/// Stored status strings, for tests that set or compare an op's status directly.
pub const CHECKING: &str = OpStatus::Checking.as_str();
pub const UNCONFIRMED: &str = OpStatus::Unconfirmed.as_str();
pub const CLEANUP: &str = OpStatus::Cleanup.as_str();

/// The typed view of a stored op's `kind` and `status`.
impl DbOp {
    pub fn op_kind(&self) -> Option<OpKind> {
        OpKind::parse(&self.kind)
    }

    pub fn op_status(&self) -> Option<OpStatus> {
        OpStatus::parse(&self.status)
    }

    /// A send that didn't go through and is still queued: Gmail refused it, or it never
    /// showed up in Sent. What [`failed_sends`], [`resend`] and [`move_to_drafts`] act on.
    pub fn is_unsent_send(&self) -> bool {
        self.op_kind() == Some(OpKind::Send)
            && matches!(
                self.op_status(),
                Some(OpStatus::Unconfirmed | OpStatus::Failed)
            )
    }
}

/// Delay before each Sent search after an ambiguous send: ≈30 s, 2 min, 10 min.
pub const CHECK_DELAYS_MS: [i64; 3] = [30_000, 120_000, 600_000];
/// When a Sent search itself fails, try it again after this long without advancing.
const SEARCH_RETRY_MS: i64 = 30_000;
const BACKOFF_BASE_MS: i64 = 5_000;
const BACKOFF_MAX_MS: i64 = 5 * 60_000;

/// An op's payload, stored as JSON in `outbox.payload`. Its shape follows the op's kind (the
/// JSON carries no tag of its own). Queued rows outlive app versions, so each shape must keep
/// serialising to exactly the JSON it always has: field names, field order and the skipped
/// empty fields (see the round-trip test).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Payload {
    Modify(LabelChange),
    Trash(TrashThreads),
    Send(SendPayload),
}

/// A `modify` op: labels to add and remove on whole threads, or on a whole mailbox.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct LabelChange {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    add: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    remove: Vec<String>,
    /// A change to a whole mailbox (Mark all as read): a Gmail search for its mail. The
    /// change goes to every message it finds that arrived before the op was queued, cached
    /// or not, in place of reading each of `thread_ids` back from Gmail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sweep: Option<String>,
}

/// A `trash` op: the threads moved to Trash.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct TrashThreads {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    thread_ids: Vec<String>,
}

/// A `send` op. A `cleanup` one keeps only `draft_id`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct SendPayload {
    /// Base64url RFC 2822 message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
    /// The conversation a reply belongs in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    /// The saved Gmail draft this message came from, deleted once it is sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft_id: Option<String>,
}

impl SendPayload {
    fn of(op: &DbOp) -> Result<Self, SyncError> {
        parse_payload(op)
    }
}

/// What [`Payload::scrub`] did to a label change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scrubbed {
    Unchanged,
    Changed,
    /// Nothing is left to add or remove.
    Emptied,
}

fn parse_payload<T: serde::de::DeserializeOwned>(op: &DbOp) -> Result<T, SyncError> {
    serde_json::from_str(&op.payload)
        .map_err(|e| SyncError::Db(anyhow::anyhow!("outbox op {} is corrupt: {e}", op.id)))
}

impl Payload {
    /// The op's payload, read in the shape of its kind (an unknown kind as a label change,
    /// which is how such an op is processed).
    fn of(op: &DbOp) -> Result<Self, SyncError> {
        Ok(match op.op_kind() {
            Some(OpKind::Trash) => Payload::Trash(parse_payload(op)?),
            Some(OpKind::Send) => Payload::Send(parse_payload(op)?),
            Some(OpKind::Modify) | None => Payload::Modify(parse_payload(op)?),
        })
    }

    fn kind(&self) -> OpKind {
        match self {
            Payload::Modify(_) => OpKind::Modify,
            Payload::Trash(_) => OpKind::Trash,
            Payload::Send(_) => OpKind::Send,
        }
    }

    fn to_json(&self) -> anyhow::Result<String> {
        Ok(match self {
            Payload::Modify(p) => serde_json::to_string(p)?,
            Payload::Trash(p) => serde_json::to_string(p)?,
            Payload::Send(p) => serde_json::to_string(p)?,
        })
    }

    /// The threads a label or trash change covers (none for a send).
    fn thread_ids(&self) -> &[String] {
        match self {
            Payload::Modify(p) => &p.thread_ids,
            Payload::Trash(p) => &p.thread_ids,
            Payload::Send(_) => &[],
        }
    }

    /// The conversations the op changes or sends into (none known for a whole-mailbox sweep).
    fn touched_threads(&self) -> impl Iterator<Item = &String> {
        let reply = match self {
            Payload::Send(p) => p.thread_id.as_ref(),
            _ => None,
        };
        self.thread_ids().iter().chain(reply)
    }

    /// The Gmail search of a whole-mailbox change.
    fn sweep(&self) -> Option<&str> {
        match self {
            Payload::Modify(p) => p.sweep.as_deref(),
            _ => None,
        }
    }

    /// The labels a change adds and removes (none for a trash or a send).
    fn label_changes(&self) -> (&[String], &[String]) {
        match self {
            Payload::Modify(p) => (&p.add, &p.remove),
            _ => (&[], &[]),
        }
    }

    /// Take threads Gmail now has out of a label or trash change.
    fn drop_threads(&mut self, done: &[String]) {
        match self {
            Payload::Modify(LabelChange { thread_ids, .. })
            | Payload::Trash(TrashThreads { thread_ids }) => {
                thread_ids.retain(|t| !done.contains(t))
            }
            Payload::Send(_) => {}
        }
    }

    /// Take deleted labels out of a label change.
    fn scrub(&mut self, gone: &[String]) -> Scrubbed {
        let Payload::Modify(change) = self else {
            return Scrubbed::Unchanged;
        };
        let before = (change.add.len(), change.remove.len());
        change.add.retain(|l| !gone.contains(l));
        change.remove.retain(|l| !gone.contains(l));
        if (change.add.len(), change.remove.len()) == before {
            Scrubbed::Unchanged
        } else if change.add.is_empty() && change.remove.is_empty() {
            Scrubbed::Emptied
        } else {
            Scrubbed::Changed
        }
    }

    /// The op's effect on one message's labels.
    fn apply(&self, labels: &[String]) -> Vec<String> {
        let mut out: Vec<String> = labels.to_vec();
        let (add, remove) = self.label_changes();
        out.retain(|l| !remove.contains(l));
        if add.iter().any(|l| l == "INBOX") {
            // Gmail takes a message out of Trash when it gets INBOX.
            out.retain(|l| l != "TRASH");
        }
        for l in add {
            if !out.contains(l) {
                out.push(l.clone());
            }
        }
        if matches!(self, Payload::Trash(_)) && !out.iter().any(|l| l == "TRASH") {
            out.push("TRASH".into());
        }
        out
    }
}

/// Threads named in one log line; the rest are counted.
const LOGGED_IDS: usize = 10;

/// `ids` for the diagnostic log: the first [`LOGGED_IDS`], comma-separated, then how many more.
pub(crate) fn id_sample(ids: &[String]) -> String {
    let shown = ids[..ids.len().min(LOGGED_IDS)].join(",");
    match ids.len().saturating_sub(LOGGED_IDS) {
        0 => shown,
        more => format!("{shown} (+{more} more)"),
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
    let payload = Payload::Modify(LabelChange {
        thread_ids: thread_ids.to_vec(),
        add: add.to_vec(),
        remove: remove.to_vec(),
        sweep: None,
    });
    enqueue(pool, account_id, payload).await
}

/// Queue a label change on every message a Gmail search finds: `thread_ids` are cached
/// threads to change now; Gmail gets the change for every message `sweep` finds (see
/// [`LabelChange::sweep`]), so mail not cached yet changes too. Queued even when nothing is cached.
pub async fn enqueue_sweep(
    pool: &SqlitePool,
    account_id: &str,
    thread_ids: &[String],
    add: &[String],
    remove: &[String],
    sweep: &str,
) -> Result<Option<EnqueueResult>, SyncError> {
    let payload = Payload::Modify(LabelChange {
        thread_ids: thread_ids.to_vec(),
        add: add.to_vec(),
        remove: remove.to_vec(),
        sweep: Some(sweep.to_owned()),
    });
    enqueue(pool, account_id, payload).await
}

/// Queue moving whole threads to Trash and apply it to the cache now.
pub async fn enqueue_trash(
    pool: &SqlitePool,
    account_id: &str,
    thread_ids: &[String],
) -> Result<Option<EnqueueResult>, SyncError> {
    let payload = Payload::Trash(TrashThreads {
        thread_ids: thread_ids.to_vec(),
    });
    enqueue(pool, account_id, payload).await
}

/// Queue a label or trash change (`payload`) and apply it to the cache now.
async fn enqueue(
    pool: &SqlitePool,
    account_id: &str,
    payload: Payload,
) -> Result<Option<EnqueueResult>, SyncError> {
    let kind = payload.kind().as_str();
    let mut tx = db::begin_write(pool).await?;
    let op_id = uuid::Uuid::new_v4().to_string();
    let mut targets = Vec::new();
    for thread_id in payload.thread_ids() {
        for msg in messages::labels_for_thread(&mut *tx, account_id, thread_id).await? {
            targets.push((msg.id, thread_id.clone(), msg.labels));
        }
    }
    if targets.is_empty() && payload.sweep().is_none() {
        return Ok(None);
    }
    let now = now_ms();
    let op = DbOp {
        seq: 0,
        id: op_id.clone(),
        account_id: account_id.to_owned(),
        kind: kind.to_owned(),
        payload: payload.to_json()?,
        status: OpStatus::Pending.as_str().into(),
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
        let next = payload.apply(labels);
        messages::set_labels(&mut tx, account_id, message_id, &next).await?;
    }
    let result = threads::recompute_threads(&mut tx, account_id, payload.thread_ids()).await?;
    tx.commit().await?;
    // The record of what the user changed, so "did my move go through?" has an answer: thread
    // ids (no content), matched to `op` again when Gmail applies it or refuses it.
    tracing::info!(
        account = account_id,
        op = %op_id,
        kind = %kind,
        threads = %id_sample(payload.thread_ids()),
        messages = targets.len(),
        add = ?payload.label_changes().0,
        remove = ?payload.label_changes().1,
        whole_mailbox = payload.sweep().is_some(),
        "change queued"
    );
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
        for thread_id in payload.thread_ids().iter().filter(|t| wanted.contains(t)) {
            for msg in messages::labels_for_thread(&mut *conn, account_id, thread_id).await? {
                let labels = msg.labels;
                let target = DbOpMessage {
                    op_id: op.id.clone(),
                    account_id: account_id.to_owned(),
                    message_id: msg.id.clone(),
                    thread_id: thread_id.clone(),
                    prior_label_ids: serde_json::to_string(&labels).expect("strings serialize"),
                };
                let is_recorded = recorded.contains(&msg.id);
                if !covers(&op, is_recorded, msg.date) {
                    continue;
                }
                if !is_recorded {
                    store::add_target(&mut *conn, &target).await?;
                } else if restored.contains(&msg.id) {
                    store::set_prior(&mut *conn, &target).await?;
                }
                let next = payload.apply(&labels);
                if next != labels {
                    messages::set_labels(conn, account_id, &msg.id, &next).await?;
                }
            }
        }
    }
    Ok(())
}

/// Whether a label/trash op applies to a message: one it recorded as a target, or one
/// dated no later than the op (older mail cached or found since). Mail that arrived after
/// the user acted is left alone. Used for both the cache and the Gmail request.
fn covers(op: &DbOp, recorded: bool, date_ms: Option<i64>) -> bool {
    recorded || date_ms.is_some_and(|d| d <= op.created_at)
}

/// Confirm sends whose message is now cached in Sent. Returns the confirmed op ids. One that
/// came from a saved draft stays as its `cleanup` follow-up, which the next [`process`] runs.
pub async fn match_sends(
    conn: &mut SqliteConnection,
    account_id: &str,
) -> Result<Vec<String>, SyncError> {
    let mut done = Vec::new();
    for send in store::sends_awaiting_confirmation(&mut *conn, account_id).await? {
        let Some(rfc) = send.rfc822_message_id.as_deref() else {
            continue;
        };
        if messages::find_sent_by_rfc822(&mut *conn, account_id, rfc)
            .await?
            .is_some()
        {
            let draft = source_draft(&mut *conn, &send.id).await?;
            settle_send(&mut *conn, &send.id, draft.as_deref(), now_ms()).await?;
            done.push(send.id);
        }
    }
    Ok(done)
}

/// The saved draft a queued send came from, read from the op as stored.
async fn source_draft(
    conn: &mut SqliteConnection,
    op_id: &str,
) -> Result<Option<String>, SyncError> {
    Ok(match store::get(conn, op_id).await? {
        Some(op) => SendPayload::of(&op)?.draft_id,
        None => None,
    })
}

/// Gmail has the send's message: the op is done, unless it came from a saved draft, which it
/// stays for as a `cleanup` op until that draft is deleted.
async fn settle_send<'e>(
    ex: impl sqlx::SqliteExecutor<'e>,
    op_id: &str,
    draft_id: Option<&str>,
    now: i64,
) -> Result<(), SyncError> {
    match draft_id {
        None => store::delete(ex, op_id).await?,
        Some(draft) => {
            let payload = Payload::Send(SendPayload {
                draft_id: Some(draft.to_owned()),
                ..Default::default()
            });
            let json = payload.to_json()?;
            store::to_cleanup(ex, op_id, &json, now).await?;
        }
    }
    Ok(())
}

/// Where and when a queued message is sent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendOptions {
    /// Reply: the Gmail thread it belongs in.
    pub thread_id: Option<String>,
    /// The saved draft this message replaces; deleted once the message is sent.
    pub draft_id: Option<String>,
    /// Not before this time (Unix ms): the undo-send window. 0 sends at once.
    pub send_at: i64,
}

/// Queue an RFC 2822 message for sending. Keeps its `Message-ID` or adds one; the id is
/// how delivery gets confirmed after an ambiguous failure. Returns the op id.
pub async fn queue_send(
    pool: &SqlitePool,
    account_id: &str,
    raw: &[u8],
    options: &SendOptions,
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
        kind: OpKind::Send.as_str().into(),
        payload: Payload::Send(SendPayload {
            raw: Some(encode_base64url(&raw)),
            thread_id: options.thread_id.clone(),
            draft_id: options.draft_id.clone(),
        })
        .to_json()?,
        status: OpStatus::Pending.as_str().into(),
        attempts: 0,
        next_attempt_at: options.send_at,
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

/// Undo send: drop a send that hasn't left (still waiting, offline, or rejected). False
/// once it may have reached Gmail, or if it's gone.
pub async fn cancel_send(pool: &SqlitePool, op_id: &str) -> Result<bool, SyncError> {
    Ok(store::delete_unsent(pool, op_id).await?)
}

/// "Send again" after the user confirmed: only for a send that's unconfirmed or failed.
/// It keeps its Message-ID.
pub async fn resend(pool: &SqlitePool, op_id: &str) -> Result<bool, SyncError> {
    let Some(op) = store::get(pool, op_id).await? else {
        return Ok(false);
    };
    if !op.is_unsent_send() {
        return Ok(false);
    }
    let progress = OpProgress {
        status: OpStatus::Pending.as_str(),
        attempts: op.attempts,
        next_attempt_at: 0,
        checks_done: 0,
        last_error: None,
    };
    store::update_progress(pool, op_id, &progress, now_ms()).await?;
    Ok(true)
}

/// A send that didn't go through and is still in the outbox, with enough to show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedSend {
    pub op_id: String,
    /// [`OpStatus::Failed`]: Gmail refused it, so it was never sent.
    /// [`OpStatus::Unconfirmed`]: Gmail may have it, but it never showed up in Sent.
    pub status: String,
    pub subject: Option<String>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    /// Why Gmail refused it; `None` for an unconfirmed send.
    pub error: Option<String>,
    /// The conversation a reply was for.
    pub thread_id: Option<String>,
    /// When it was queued and when it failed (Unix ms).
    pub queued_at: i64,
    pub failed_at: i64,
}

/// As much of a queued message's base64url text as is decoded to read its headers.
const HEADER_PREFIX_B64: usize = 256 * 1024;

/// The account's sends that failed or were never confirmed, oldest first: what [`resend`] and
/// [`cancel_send`] act on. Each message is read one at a time and only its headers are decoded.
pub async fn failed_sends(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<FailedSend>, SyncError> {
    let mut out = Vec::new();
    for id in store::unsent_send_ids(pool, account_id).await? {
        // It may have been confirmed, resent or cancelled since the list was read.
        let Some(op) = store::get(pool, &id).await? else {
            continue;
        };
        if !op.is_unsent_send() {
            continue;
        }
        let payload = SendPayload::of(&op)?;
        let headers = payload.raw.as_deref().and_then(header_block);
        // As written in the message: encoded words are decoded by the two readers below.
        let header = |name: &str| {
            let (headers, _) = mailparse::parse_headers(headers.as_deref()?).ok()?;
            let value = headers.get_first_header(name)?.get_value_raw().to_vec();
            Some(String::from_utf8_lossy(&value).into_owned())
        };
        let addresses =
            |name: &str| header(name).map_or_else(Vec::new, |v| parse_addresses(name, &v));
        out.push(FailedSend {
            subject: header("Subject")
                .map(|v| decode_header_value("Subject", &v))
                .filter(|s| !s.is_empty()),
            to: addresses("To"),
            cc: addresses("Cc"),
            bcc: addresses("Bcc"),
            error: op.last_error,
            thread_id: payload.thread_id,
            queued_at: op.created_at,
            failed_at: op.updated_at,
            status: op.status,
            op_id: op.id,
        });
    }
    Ok(out)
}

/// Where [`move_to_drafts`] put a send back: the Gmail draft and its message (what Drafts lists).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnedDraft {
    pub draft_id: String,
    pub message_id: String,
}

/// Put a failed or unconfirmed send of `account_id`'s back in its Gmail Drafts, exactly as it
/// was queued, and drop it from the outbox, so the user can open it, fix it and send it again
/// (or discard it). The draft it came from is updated in place, else a new one is made. `None`
/// when the op isn't such a send any more (sent, sent again, cancelled or gone): then nothing
/// is left behind in Drafts.
pub async fn move_to_drafts(
    pool: &SqlitePool,
    api: &dyn MailApi,
    account_id: &str,
    op_id: &str,
) -> Result<Option<ReturnedDraft>, SyncError> {
    let unsent = |op: &DbOp| op.is_unsent_send() && op.account_id == account_id;
    let Some(op) = store::get(pool, op_id).await?.filter(unsent) else {
        return Ok(None);
    };
    let payload = SendPayload::of(&op)?;
    let Some(raw) = payload.raw.as_deref() else {
        return Ok(None);
    };
    let raw = decode_base64url(raw).map_err(|e| anyhow::anyhow!("send {op_id}: {e}"))?;
    let thread = payload.thread_id.as_deref();
    let (draft, created) = match payload.draft_id.as_deref() {
        Some(id) => match api.update_draft(id, &raw, thread).await {
            Err(e) if e.is_not_found() => (api.create_draft(&raw, thread).await?, true),
            other => (other?, false),
        },
        None => (api.create_draft(&raw, thread).await?, true),
    };
    // Dropped only now the message is safe in Drafts, and only if nothing else settled it.
    let mut tx = db::begin_write(pool).await?;
    let still_unsent = store::get(&mut *tx, op_id)
        .await?
        .is_some_and(|op| unsent(&op));
    if still_unsent {
        store::delete(&mut *tx, op_id).await?;
    }
    tx.commit().await?;
    if !still_unsent {
        // It went after all: the copy made here would only be a stray draft. (A source draft
        // that was updated goes with the send's own cleanup.)
        if created {
            let _ = api.delete_draft(&draft.id).await;
        }
        return Ok(None);
    }
    Ok(Some(ReturnedDraft {
        message_id: draft.message.map(|m| m.id).unwrap_or_default(),
        draft_id: draft.id,
    }))
}

/// The start of a base64url RFC 2822 message, decoded: its headers, and usually some body.
fn header_block(raw: &str) -> Option<Vec<u8>> {
    if raw.len() <= HEADER_PREFIX_B64 {
        return decode_base64url(raw).ok();
    }
    // Whole 4-character groups decode on their own; `raw` is ASCII.
    decode_base64url(raw.get(..HEADER_PREFIX_B64 / 4 * 4)?).ok()
}

/// Gmail definitively refused (not a network, auth, rate-limit or server problem).
fn is_rejection(e: &GmailError) -> bool {
    matches!(e, GmailError::Api { status, .. } if (400..500).contains(status) && *status != 401 && *status != 429)
}

/// The request certainly didn't reach Gmail, so sending it again can't duplicate it.
fn never_sent(e: &GmailError) -> bool {
    matches!(
        e,
        GmailError::Offline(_)
            | GmailError::RateLimit { .. }
            | GmailError::Auth(_)
            | GmailError::KeychainLocked(_)
            | GmailError::SignedOut(_)
    )
}

fn backoff(attempts: i64) -> i64 {
    let exp = attempts.clamp(0, 16) as u32;
    BACKOFF_BASE_MS.saturating_mul(1 << exp).min(BACKOFF_MAX_MS)
}

/// Push the account's queued changes to Gmail, oldest first. A change that hits a
/// network problem stops the queue (order matters) until its backoff passes. Sends being
/// confirmed don't block anything, and a whole-mailbox change that is waiting holds up later
/// label and trash changes but never a send. Returns whether any op finished.
pub async fn process(engine: &SyncEngine, now: i64) -> Result<bool, SyncError> {
    let mut progressed = false;
    // Conversations of earlier changes still waiting for Gmail. A later change to none of them
    // goes ahead, so a big job waiting out a refusal doesn't hold up the user's next click.
    let mut waiting: BTreeSet<String> = BTreeSet::new();
    let mut send_waiting = false;
    // A whole-mailbox change is waiting: it may touch any conversation, so no later label or
    // trash change overtakes it. Sends change no labels and go ahead.
    let mut sweep_waiting = false;
    // Sends that can't leave now come without their message (see `store::queue`).
    for op in store::queue(&engine.db, &engine.account_id, now).await? {
        match (op.op_kind(), op.op_status()) {
            (Some(OpKind::Send), Some(OpStatus::Checking)) => {
                if op.next_attempt_at <= now && check_send(engine, &op, now).await? {
                    progressed = true;
                }
            }
            (Some(OpKind::Send), Some(OpStatus::Unconfirmed | OpStatus::Failed)) => {}
            (Some(OpKind::Send), Some(OpStatus::Cleanup)) => {
                if op.next_attempt_at <= now {
                    let Some(payload) = readable_payload(engine, &op).await? else {
                        continue;
                    };
                    let draft = match &payload {
                        Payload::Send(p) => p.draft_id.as_deref(),
                        _ => None,
                    };
                    match draft {
                        Some(draft) => {
                            delete_source_draft(engine, &op.id, draft, op.attempts, now).await?
                        }
                        None => store::delete(&engine.db, &op.id).await?,
                    }
                }
            }
            (kind, Some(OpStatus::Pending)) => {
                let is_send = kind == Some(OpKind::Send);
                // A send waiting out its undo window holds nothing else up.
                if op.next_attempt_at > now && is_send && op.attempts == 0 {
                    continue;
                }
                let Some(payload) = readable_payload(engine, &op).await? else {
                    continue;
                };
                let held = op.next_attempt_at > now
                    || (is_send && send_waiting)
                    || (!is_send && sweep_waiting)
                    || payload.touched_threads().any(|t| waiting.contains(t));
                let is_sweep = payload.sweep().is_some();
                if is_sweep && (held || !waiting.is_empty() || send_waiting) {
                    // A whole-mailbox change may touch any conversation: no label or trash
                    // change overtakes it, and it overtakes nothing.
                    sweep_waiting = true;
                    continue;
                }
                if held {
                    waiting.extend(payload.touched_threads().cloned());
                    send_waiting |= is_send;
                    continue;
                }
                let step = if is_send {
                    send(engine, &op, now).await?
                } else {
                    apply_op(engine, &op, now).await?
                };
                match step {
                    Step::Done => progressed = true,
                    Step::Continue => {}
                    // Gmail didn't take the whole-mailbox change this time: like one still
                    // backing off, it holds label changes, not sends.
                    Step::Blocked if is_sweep => sweep_waiting = true,
                    Step::Blocked => break,
                }
            }
            _ => {}
        }
    }
    Ok(progressed)
}

/// The op's payload, or `None` once an op that can't be read is dropped. One corrupt row
/// must not stop the queue: `process` runs before every sync, so an error here would keep
/// the account from ever syncing again.
async fn readable_payload(engine: &SyncEngine, op: &DbOp) -> Result<Option<Payload>, SyncError> {
    let error = match Payload::of(op) {
        Ok(payload) => return Ok(Some(payload)),
        Err(e) => e,
    };
    tracing::error!(account = %engine.account_id, op = %op.id, kind = %op.kind, error = %error, "dropping a queued change that can't be read");
    if op.op_kind() == Some(OpKind::Send) {
        // Nothing to put back: a send changes no labels.
        store::delete(&engine.db, &op.id).await?;
        // A send that hadn't gone out fails like one Gmail refused, so the compose window
        // waiting on it comes back instead of saying "Sending…" for ever. One already sent
        // (only its draft left to clean up) has nothing to report.
        if op.status != CLEANUP {
            send_status(engine, op, FAILED);
        }
    } else {
        // The same path as a change Gmail refuses for good: labels go back and the app is told.
        rollback(engine, op, &GmailError::Decode(error.to_string())).await?;
    }
    Ok(None)
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
        status: OpStatus::Pending.as_str(),
        attempts: op.attempts + 1,
        next_attempt_at: now + backoff(op.attempts),
        checks_done: op.checks_done,
        last_error: Some(&error.to_string()),
    };
    store::update_progress(&engine.db, &op.id, &progress, now).await?;
    if op.attempts == 0 {
        // Once: it retries with backoff, and its outcome is logged when it lands.
        tracing::info!(account = %engine.account_id, op = %op.id, kind = %op.kind, error = %error, "change waiting for Gmail; retrying");
    }
    Ok(())
}

/// Conversations a label/trash change sends to Gmail at a time. Each is read back first (10
/// quota units), so a batch is a small part of a minute's quota; when Gmail refuses one, the
/// batches it already took leave the op and only the rest is tried again.
pub const OP_BATCH_THREADS: usize = 25;

async fn apply_op(engine: &SyncEngine, queued: &DbOp, now: i64) -> Result<Step, SyncError> {
    loop {
        if let Some(step) = apply_batch(engine, queued, now).await? {
            return Ok(step);
        }
    }
}

/// Send the op's next batch of conversations to Gmail. `None` when Gmail took it and more
/// are left.
async fn apply_batch(
    engine: &SyncEngine,
    queued: &DbOp,
    now: i64,
) -> Result<Option<Step>, SyncError> {
    // The queue was read before earlier ops waited on Gmail; deleting a label meanwhile
    // scrubs it from pending ops (and drops ops left empty), so work from the op as it is now.
    let Some(op) = store::get(&engine.db, &queued.id).await? else {
        return Ok(Some(Step::Continue));
    };
    let op = &op;
    let payload = Payload::of(op)?;
    let thread_ids = payload.thread_ids();
    let batch = &thread_ids[..thread_ids.len().min(OP_BATCH_THREADS)];
    let more = payload.sweep().is_none() && batch.len() < thread_ids.len();
    let recorded: BTreeSet<String> = store::messages_of(&engine.db, &op.id)
        .await?
        .into_iter()
        .map(|t| t.message_id)
        .collect();
    let ids = async {
        if let Some(q) = payload.sweep() {
            // The cached threads' own messages too: an unread message outside the Inbox in an
            // inbox thread doesn't match the search.
            let mut ids = recorded.clone();
            ids.extend(swept_ids(engine, q, op.created_at).await?);
            return Ok(ids.into_iter().collect());
        }
        // The thread as Gmail has it now: older messages we never cached are included,
        // mail that arrived after the user acted is not.
        let mut ids = Vec::new();
        for thread_id in batch {
            match engine
                .api
                .get_thread(thread_id, MessageFormat::Minimal)
                .await
            {
                Ok(thread) => ids.extend(
                    thread
                        .messages
                        .iter()
                        .filter(|m| covers(op, recorded.contains(&m.id), m.internal_date_ms()))
                        .map(|m| m.id.clone()),
                ),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(e),
            }
        }
        Ok(ids)
    }
    .await;
    let mut sent = None;
    let mut changed = 0;
    let result = match ids {
        Ok(ids) if !ids.is_empty() => {
            changed = ids.len();
            // Re-read once more: a label may have been deleted while the threads were read.
            let Some(current) = store::get(&engine.db, &op.id).await? else {
                return Ok(Some(Step::Continue));
            };
            let payload = Payload::of(&current)?;
            sent = Some(current.payload);
            match payload {
                Payload::Trash(_) => trash_all(engine, &ids).await,
                _ => {
                    let (add, remove) = payload.label_changes();
                    engine.api.batch_modify(&ids, add, remove).await
                }
            }
        }
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    };
    match result {
        Ok(()) if more => {
            drop_done_threads(engine, &op.id, batch).await?;
            Ok(None)
        }
        Ok(()) => {
            store::delete(&engine.db, &op.id).await?;
            tracing::info!(
                account = %engine.account_id,
                op = %op.id,
                kind = %op.kind,
                messages = changed,
                attempts = op.attempts + 1,
                "Gmail applied the change"
            );
            Ok(Some(Step::Done))
        }
        Err(e) if is_rejection(&e) => {
            // Maybe refused for a label being deleted: a delete scrubs it from this op, holding
            // the label lock until then. Message sync never waits on a label change, so while
            // one is running try again later; once none is, send the rest if it was scrubbed.
            if let Some(sent) = sent {
                let Ok(held) = engine.label_lock.try_lock() else {
                    defer(engine, op, now, &e).await?;
                    return Ok(Some(Step::Blocked));
                };
                let scrubbed = store::get(&engine.db, &op.id)
                    .await?
                    .is_none_or(|now| now.payload != sent);
                drop(held);
                if scrubbed {
                    return Box::pin(apply_batch(engine, queued, now)).await;
                }
            }
            rollback(engine, op, &e).await?;
            Ok(Some(Step::Continue))
        }
        Err(e) => {
            defer(engine, op, now, &e).await?;
            Ok(Some(Step::Blocked))
        }
    }
}

/// Take conversations Gmail now has out of a pending op, so a retry or a rollback covers only
/// the rest. Reads the op afresh: a label delete may have rewritten it meanwhile.
async fn drop_done_threads(
    engine: &SyncEngine,
    op_id: &str,
    done: &[String],
) -> Result<(), SyncError> {
    let _guard = engine.write_lock.lock().await;
    let mut tx = db::begin_write(&engine.db).await?;
    if let Some(op) = store::get(&mut *tx, op_id).await? {
        let mut payload = Payload::of(&op)?;
        payload.drop_threads(done);
        let json = payload.to_json()?;
        store::drop_threads(&mut tx, op_id, &json, done).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Take deleted labels out of the account's pending label changes, inside the caller's write
/// transaction. A change left with nothing to add or remove is dropped; one that can't be read
/// is left for [`process`] to deal with.
pub async fn scrub_labels(
    conn: &mut SqliteConnection,
    account_id: &str,
    label_ids: &[String],
) -> anyhow::Result<()> {
    for queued in store::pending_modify_payloads(&mut *conn, account_id).await? {
        let Ok(change) = serde_json::from_str::<LabelChange>(&queued.payload) else {
            continue;
        };
        let mut payload = Payload::Modify(change);
        match payload.scrub(label_ids) {
            Scrubbed::Unchanged => {}
            Scrubbed::Emptied => store::delete(&mut *conn, &queued.id).await?,
            Scrubbed::Changed => {
                store::set_payload(&mut *conn, &queued.id, &payload.to_json()?).await?
            }
        }
    }
    Ok(())
}

/// Messages per Gmail search page while sweeping a mailbox (the API's maximum).
const SWEEP_PAGE: u32 = 500;

/// Every message `q` finds on Gmail that arrived before `before_ms` (to the second), so mail
/// that came in after the user acted is left alone.
async fn swept_ids(
    engine: &SyncEngine,
    q: &str,
    before_ms: i64,
) -> Result<Vec<String>, GmailError> {
    let q = format!("{q} before:{}", before_ms.div_euclid(1000) + 1);
    let mut ids = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let page = engine
            .api
            .search_messages(&q, false, page_token.as_deref(), SWEEP_PAGE)
            .await?;
        ids.extend(page.messages.into_iter().map(|m| m.id));
        match page.next_page_token {
            Some(next) if !next.is_empty() => page_token = Some(next),
            _ => return Ok(ids),
        }
    }
}

async fn trash_all(engine: &SyncEngine, ids: &[String]) -> Result<(), GmailError> {
    for id in ids {
        match engine.api.trash_message(id).await {
            Ok(()) => {}
            Err(e) if e.is_not_found() => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Undo a rejected change: messages go back to Gmail's current labels (or, if those
/// can't be read, to their labels before the change); later queued changes are re-applied.
async fn rollback(engine: &SyncEngine, op: &DbOp, error: &GmailError) -> Result<(), SyncError> {
    tracing::warn!(account = %engine.account_id, op = %op.id, kind = %op.kind, error = %error, "Gmail rejected a queued change; rolling it back");
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
    let payload = SendPayload::of(op)?;
    let raw = payload
        .raw
        .as_deref()
        .ok_or_else(|| SyncError::Db(anyhow::anyhow!("send {} has no message", op.id)))
        .and_then(|r| {
            decode_base64url(r).map_err(|e| SyncError::Db(anyhow::anyhow!("send {}: {e}", op.id)))
        })?;
    // Recorded before the request leaves: if the app dies mid-send, it's confirmed through
    // Sent on the next run instead of being sent again. Claimed atomically, so a send
    // cancelled (undo) meanwhile never goes out.
    let checking = OpProgress {
        status: OpStatus::Checking.as_str(),
        attempts: op.attempts + 1,
        next_attempt_at: now + CHECK_DELAYS_MS[0],
        checks_done: 0,
        last_error: None,
    };
    if !store::claim_send(&engine.db, &op.id, &checking, now).await? {
        return Ok(Step::Continue);
    }
    let started = std::time::Instant::now();
    let dispatch_at = now_ms();
    tracing::info!(
        op = %op.id,
        queued_ms = dispatch_at.saturating_sub(op.created_at),
        dispatch_late_ms = dispatch_at.saturating_sub(op.next_attempt_at.max(op.created_at)),
        "send dispatch started"
    );
    let result = engine
        .api
        .send_message(&raw, payload.thread_id.as_deref())
        .await;
    tracing::info!(
        op = %op.id,
        request_ms = started.elapsed().as_millis() as u64,
        accepted = result.is_ok(),
        "send request finished"
    );
    match result {
        Ok(_) => {
            sent(engine, op, payload.draft_id.as_deref(), now).await?;
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
                status: OpStatus::Failed.as_str(),
                attempts: op.attempts + 1,
                next_attempt_at: 0,
                checks_done: 0,
                last_error: Some(&e.to_string()),
            };
            store::update_progress(&engine.db, &op.id, &failed, now).await?;
            send_status(engine, op, OpStatus::Failed.as_str());
            Ok(Step::Continue)
        }
        Err(e) => {
            tracing::warn!(op = %op.id, error = %e, "send outcome unknown; confirming via Sent");
            send_status(engine, op, OpStatus::Checking.as_str());
            Ok(Step::Continue)
        }
    }
}

/// Gmail has the message: settle the op, tell the app, then delete the draft it came from.
async fn sent(
    engine: &SyncEngine,
    op: &DbOp,
    draft_id: Option<&str>,
    now: i64,
) -> Result<(), SyncError> {
    settle_send(&engine.db, &op.id, draft_id, now).await?;
    send_status(engine, op, "sent");
    if let Some(draft) = draft_id {
        delete_source_draft(engine, &op.id, draft, 0, now).await?;
    }
    Ok(())
}

/// The message replaced a saved draft: remove it now that the message is in Sent (kept until
/// then, so a send that never leaves and is cancelled loses nothing). `op_id` is the send's
/// `cleanup` op, which goes once the draft is gone or Gmail refuses for good; a network or
/// server failure keeps it, to try again after a backoff, so the sent message doesn't stay in
/// Drafts on every device.
async fn delete_source_draft(
    engine: &SyncEngine,
    op_id: &str,
    draft: &str,
    attempts: i64,
    now: i64,
) -> Result<(), SyncError> {
    match engine.api.delete_draft(draft).await {
        Ok(()) => {}
        Err(e) if e.is_not_found() => {}
        Err(e) if is_rejection(&e) => {
            tracing::warn!(op = %op_id, error = %e, "Gmail refused to delete the sent draft; leaving it");
        }
        Err(e) => {
            if attempts == 0 {
                tracing::warn!(op = %op_id, error = %e, "couldn't delete the sent draft; retrying");
            }
            let retry = OpProgress {
                status: OpStatus::Cleanup.as_str(),
                attempts: attempts + 1,
                next_attempt_at: now + backoff(attempts),
                checks_done: 0,
                last_error: Some(&e.to_string()),
            };
            store::update_progress(&engine.db, op_id, &retry, now).await?;
            return Ok(());
        }
    }
    store::delete(&engine.db, op_id).await?;
    Ok(())
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
            .search_messages(&format!("rfc822msgid:{rfc} in:sent"), false, None, 10)
            .await
        {
            Ok(page) => !page.messages.is_empty(),
            Err(e) => {
                // A failed search isn't a check: retry it without advancing the schedule.
                tracing::info!(op = %op.id, error = %e, "Sent search failed; retrying");
                let retry = OpProgress {
                    status: OpStatus::Checking.as_str(),
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
        // `op` came from the queue without its payload: read the draft from the stored op.
        let mut conn = engine.db.acquire().await?;
        let draft = source_draft(&mut conn, &op.id).await?;
        drop(conn);
        sent(engine, op, draft.as_deref(), now).await?;
        return Ok(true);
    }
    let checks_done = op.checks_done + 1;
    let (status, next) = match CHECK_DELAYS_MS.get(checks_done as usize) {
        Some(delay) => (OpStatus::Checking, now + delay),
        None => (OpStatus::Unconfirmed, 0),
    };
    let progress = OpProgress {
        status: status.as_str(),
        attempts: op.attempts,
        next_attempt_at: next,
        checks_done,
        last_error: None,
    };
    store::update_progress(&engine.db, &op.id, &progress, now).await?;
    if status == OpStatus::Unconfirmed {
        send_status(engine, op, status.as_str());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(kind: OpKind, payload: &str) -> DbOp {
        DbOp {
            seq: 1,
            id: "op".into(),
            account_id: "acct".into(),
            kind: kind.as_str().into(),
            payload: payload.into(),
            status: OpStatus::Pending.as_str().into(),
            attempts: 0,
            next_attempt_at: 0,
            checks_done: 0,
            rfc822_message_id: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// Queued rows outlive app versions: the JSON each kind of op wrote before the payload
    /// shapes were typed, captured from that code, must read back and write out unchanged.
    #[test]
    fn payloads_round_trip_the_stored_json() {
        let stored = [
            (
                OpKind::Modify,
                r#"{"thread_ids":["t1","t2"],"add":["STARRED"],"remove":["INBOX","UNREAD"]}"#,
            ),
            (
                OpKind::Modify,
                r#"{"thread_ids":["t1"],"remove":["UNREAD"],"sweep":"in:inbox is:unread"}"#,
            ),
            (OpKind::Modify, r#"{"remove":["UNREAD"],"sweep":"label:x"}"#),
            (OpKind::Trash, r#"{"thread_ids":["t1","t3"]}"#),
            (
                OpKind::Send,
                r#"{"raw":"UmF3","thread_id":"t9","draft_id":"r-1"}"#,
            ),
            (OpKind::Send, r#"{"raw":"UmF3"}"#),
            // A `cleanup` op: only the draft still to delete.
            (OpKind::Send, r#"{"draft_id":"r-1"}"#),
        ];
        for (kind, json) in stored {
            let payload = Payload::of(&op(kind, json)).unwrap();
            assert_eq!(payload.kind(), kind, "{json}");
            assert_eq!(payload.to_json().unwrap(), json);
        }
    }

    #[test]
    fn payloads_write_the_stored_json() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let written = [
            (
                Payload::Modify(LabelChange {
                    thread_ids: s(&["t1", "t2"]),
                    add: s(&["STARRED"]),
                    remove: s(&["INBOX", "UNREAD"]),
                    sweep: None,
                }),
                r#"{"thread_ids":["t1","t2"],"add":["STARRED"],"remove":["INBOX","UNREAD"]}"#,
            ),
            (
                Payload::Modify(LabelChange {
                    thread_ids: s(&[]),
                    add: s(&[]),
                    remove: s(&["UNREAD"]),
                    sweep: Some("label:x".into()),
                }),
                r#"{"remove":["UNREAD"],"sweep":"label:x"}"#,
            ),
            (
                Payload::Trash(TrashThreads {
                    thread_ids: s(&["t1", "t3"]),
                }),
                r#"{"thread_ids":["t1","t3"]}"#,
            ),
            (
                Payload::Send(SendPayload {
                    raw: Some("UmF3".into()),
                    thread_id: Some("t9".into()),
                    draft_id: Some("r-1".into()),
                }),
                r#"{"raw":"UmF3","thread_id":"t9","draft_id":"r-1"}"#,
            ),
            (
                Payload::Send(SendPayload {
                    draft_id: Some("r-1".into()),
                    ..Default::default()
                }),
                r#"{"draft_id":"r-1"}"#,
            ),
        ];
        for (payload, json) in written {
            assert_eq!(payload.to_json().unwrap(), json);
        }
    }

    #[test]
    fn kinds_and_statuses_keep_their_stored_strings() {
        for (kind, s) in [
            (OpKind::Modify, "modify"),
            (OpKind::Trash, "trash"),
            (OpKind::Send, "send"),
        ] {
            assert_eq!(kind.as_str(), s);
            assert_eq!(OpKind::parse(s), Some(kind));
        }
        for (status, s) in [
            (OpStatus::Pending, "pending"),
            (OpStatus::Checking, "checking"),
            (OpStatus::Unconfirmed, "unconfirmed"),
            (OpStatus::Failed, "failed"),
            (OpStatus::Cleanup, "cleanup"),
        ] {
            assert_eq!(status.as_str(), s);
            assert_eq!(OpStatus::parse(s), Some(status));
        }
        assert_eq!(OpKind::parse("archive"), None);
        assert_eq!(OpStatus::parse("done"), None);
    }
}
