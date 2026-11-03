//! Sync engine and outbox scenarios against the in-memory [`FakeGmail`].

use super::engine::{now_ms, BackfillProgress, SyncEngine, FULL_BODY_DAYS};
use super::events::{RecordingEvents, SyncEvent};
use super::fake::{FakeGmail, FakeMsg};
use super::outbox;
use crate::db::accounts::{self, DbAccount};
use crate::db::threads::{self, ThreadQuery};
use crate::db::{labels, messages, outbox as store};
use crate::gmail::GmailError;
use sqlx::SqlitePool;
use std::sync::Arc;

const ACCT: &str = "a1";

struct H {
    _dir: tempfile::TempDir,
    pool: SqlitePool,
    fake: Arc<FakeGmail>,
    events: Arc<RecordingEvents>,
    engine: SyncEngine,
}

async fn harness() -> H {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(dir.path()).await.unwrap();
    accounts::insert_account(
        &pool,
        &DbAccount {
            id: ACCT.into(),
            email: "me@example.com".into(),
            display_name: None,
            profile_photo_url: None,
            client_id: "c".into(),
            history_id: None,
            created_at: 0,
            updated_at: 0,
        },
    )
    .await
    .unwrap();
    let fake = Arc::new(FakeGmail::new());
    let events = Arc::new(RecordingEvents::default());
    let engine = SyncEngine::new(
        pool.clone(),
        fake.clone(),
        ACCT,
        events.clone(),
        Default::default(),
    );
    H {
        _dir: dir,
        pool,
        fake,
        events,
        engine,
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

async fn listed(pool: &SqlitePool, label: &str) -> Vec<String> {
    let ids = s(&[ACCT]);
    let page = threads::list_threads(
        pool,
        &ThreadQuery {
            account_ids: &ids,
            label_id: label,
            also_label_id: None,
            before: None,
            limit: 500,
        },
    )
    .await
    .unwrap();
    page.threads.into_iter().map(|t| t.id).collect()
}

async fn cached_labels(pool: &SqlitePool, id: &str) -> Option<Vec<String>> {
    let mut l = messages::get_message(pool, ACCT, id)
        .await
        .unwrap()?
        .labels();
    l.sort();
    Some(l)
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

async fn history_id(pool: &SqlitePool) -> Option<String> {
    accounts::get_account(pool, ACCT)
        .await
        .unwrap()
        .unwrap()
        .history_id
}

fn network() -> GmailError {
    GmailError::Network("connection reset".into())
}

fn rejected() -> GmailError {
    GmailError::Api {
        status: 400,
        reason: Some("invalidArgument".into()),
        message: "Invalid label".into(),
    }
}

// ---- initial sync -------------------------------------------------------------------

#[tokio::test]
async fn initial_sync_caches_inbox_threads_and_history_id() {
    let h = harness().await;
    h.fake
        .seed(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"]).days_ago(1));
    h.fake.seed(FakeMsg::new("m2", "t1", &["SENT"]).days_ago(0));
    h.fake
        .seed(FakeMsg::new("m3", "t2", &["INBOX"]).days_ago(2));
    h.fake
        .seed(FakeMsg::new("m4", "t3", &["INBOX"]).days_ago(3));
    h.fake.seed(FakeMsg::new("m5", "t4", &["SENT"]).days_ago(4));
    let before = h.fake.history_id().to_string();

    h.engine.run_initial_sync().await.unwrap();

    assert_eq!(listed(&h.pool, "INBOX").await, s(&["t1", "t2", "t3"]));
    assert!(
        cached_labels(&h.pool, "m2").await.is_some(),
        "whole thread is cached"
    );
    assert!(
        cached_labels(&h.pool, "m5").await.is_none(),
        "non-inbox mail waits for backfill"
    );
    let m1 = messages::get_message(&h.pool, ACCT, "m1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (m1.fully_fetched, m1.body_text.as_deref()),
        (1, Some("Body of m1"))
    );
    assert_eq!(history_id(&h.pool).await.as_deref(), Some(before.as_str()));
    let names = h.events.names();
    assert_eq!(names.first(), Some(&"sync:started"));
    assert_eq!(names.last(), Some(&"sync:completed"));
    assert!(names.contains(&"sync:messages_updated"));
}

#[tokio::test]
async fn initial_sync_stores_labels_and_category_counts() {
    let h = harness().await;
    h.fake.seed(FakeMsg::new(
        "m1",
        "t1",
        &["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
    ));
    h.fake
        .seed(FakeMsg::new("m2", "t2", &["INBOX", "CATEGORY_SOCIAL"]));
    h.engine.run_initial_sync().await.unwrap();

    let inbox = labels::get_label(&h.pool, ACCT, "INBOX")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            inbox.messages_total,
            inbox.messages_unread,
            inbox.threads_unread
        ),
        (2, 1, 1)
    );
    let primary = labels::get_label(&h.pool, ACCT, "CATEGORY_PERSONAL")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(primary.threads_unread, 1);
    assert!(labels::get_label(&h.pool, ACCT, "STARRED")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn load_thread_bodies_fetches_unfetched_only_and_keeps_labels() {
    let h = harness().await;
    h.fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
    h.engine.run_initial_sync().await.unwrap();
    // An old message cached from metadata only, with an optimistic star pending.
    h.fake.seed(FakeMsg::new("old", "t1", &[]).days_ago(400));
    {
        let mut row = messages::get_message(&h.pool, ACCT, "m1")
            .await
            .unwrap()
            .unwrap();
        row.id = "old".into();
        row.fully_fetched = 0;
        row.body_text = None;
        row.label_ids = Some("[\"STARRED\"]".into());
        messages::upsert_message(&h.pool, &row).await.unwrap();
    }
    let calls = h.fake.calls("get_message");

    h.engine.load_thread_bodies("t1").await.unwrap();

    assert_eq!(
        h.fake.calls("get_message"),
        calls + 1,
        "only the unfetched message"
    );
    let old = messages::get_message(&h.pool, ACCT, "old")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (old.fully_fetched, old.body_text.as_deref()),
        (1, Some("Body of old"))
    );
    assert_eq!(
        old.labels(),
        ["STARRED"],
        "labels untouched by body loading"
    );
}

// ---- incremental sync ---------------------------------------------------------------

#[tokio::test]
async fn incremental_applies_added_deleted_and_label_changes() {
    let h = harness().await;
    h.fake
        .seed(FakeMsg::new("m1", "t1", &["INBOX"]).days_ago(2));
    h.fake
        .seed(FakeMsg::new("m2", "t2", &["INBOX", "UNREAD"]).days_ago(1));
    h.engine.run_initial_sync().await.unwrap();
    h.events.take();

    h.fake.add(FakeMsg::new("m3", "t3", &["INBOX", "UNREAD"]));
    h.fake.delete("m1");
    h.fake.relabel("m2", &["STARRED"], &["UNREAD", "INBOX"]);

    assert!(h.engine.run_incremental_sync().await.unwrap());

    assert_eq!(listed(&h.pool, "INBOX").await, s(&["t3"]));
    assert_eq!(listed(&h.pool, "STARRED").await, s(&["t2"]));
    assert!(cached_labels(&h.pool, "m1").await.is_none());
    assert_eq!(
        history_id(&h.pool).await,
        Some(h.fake.history_id().to_string())
    );
    let updated = h.events.take().into_iter().find_map(|e| match e {
        SyncEvent::MessagesUpdated {
            added,
            removed,
            modified,
            ..
        } => Some((added, removed, modified)),
        _ => None,
    });
    assert_eq!(updated, Some((s(&["t3"]), s(&["t1"]), s(&["t2"]))));
}

#[tokio::test]
async fn incremental_paginates_all_pages() {
    let h = harness().await;
    h.engine.run_initial_sync().await.unwrap();
    h.fake.set_history_page_size(2);
    for n in 0..5 {
        h.fake
            .add(FakeMsg::new(&format!("m{n}"), &format!("t{n}"), &["INBOX"]).days_ago(n));
    }
    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(listed(&h.pool, "INBOX").await.len(), 5);
    assert_eq!(h.fake.calls("list_history"), 3);
}

#[tokio::test]
async fn incremental_failed_second_page_applies_nothing() {
    let h = harness().await;
    h.engine.run_initial_sync().await.unwrap();
    let start = history_id(&h.pool).await;
    h.fake.set_history_page_size(1);
    h.fake.add(FakeMsg::new("m1", "t1", &["INBOX"]));
    h.fake.add(FakeMsg::new("m2", "t2", &["INBOX"]));
    h.fake.fail_after("list_history", 1, network());

    assert!(h.engine.run_incremental_sync().await.is_err());
    assert!(listed(&h.pool, "INBOX").await.is_empty());
    assert_eq!(history_id(&h.pool).await, start);

    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(listed(&h.pool, "INBOX").await.len(), 2);
}

#[tokio::test]
async fn added_then_deleted_before_fetch_is_ignored() {
    let h = harness().await;
    h.engine.run_initial_sync().await.unwrap();
    h.fake.add(FakeMsg::new("m1", "t1", &["INBOX"]));
    h.fake.add(FakeMsg::new("m2", "t2", &["INBOX"]));
    // Gone by the time we fetch it, but its deletion isn't in this history window yet.
    h.fake.fail_next(
        "get_message",
        crate::gmail::GmailError::Api {
            status: 404,
            reason: None,
            message: "Not Found".into(),
        },
    );
    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(listed(&h.pool, "INBOX").await.len(), 1);
    assert!(h
        .events
        .take()
        .iter()
        .all(|e| !matches!(e, SyncEvent::Error { .. })));
}

#[tokio::test]
async fn history_expiry_reconciles_existing_cache() {
    let h = harness().await;
    h.fake
        .seed(FakeMsg::new("keep", "t1", &["INBOX"]).days_ago(1));
    h.fake
        .seed(FakeMsg::new("gone", "t2", &["INBOX"]).days_ago(2));
    h.fake
        .seed(FakeMsg::new("archived", "t3", &["INBOX"]).days_ago(3));
    h.engine.run_initial_sync().await.unwrap();

    h.fake.delete("gone");
    h.fake.relabel("archived", &[], &["INBOX"]);
    h.fake
        .seed(FakeMsg::new("old", "t4", &["SENT"]).days_ago(30));
    h.fake.expire_history();

    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(listed(&h.pool, "INBOX").await, s(&["t1"]));
    assert!(cached_labels(&h.pool, "gone").await.is_none());
    assert_eq!(cached_labels(&h.pool, "archived").await, Some(vec![]));
    assert_eq!(
        history_id(&h.pool).await,
        Some(h.fake.history_id().to_string())
    );
    assert!(h
        .events
        .take()
        .iter()
        .all(|e| !matches!(e, SyncEvent::Error { .. })));

    // Backfill was reset and picks up mail that was never cached.
    while h.engine.backfill_step().await.unwrap() == BackfillProgress::More {}
    assert_eq!(listed(&h.pool, "SENT").await, s(&["t4"]));
}

// ---- backfill -----------------------------------------------------------------------

#[tokio::test]
async fn backfill_pages_until_done_and_switches_to_metadata() {
    let h = harness().await;
    h.fake.set_list_page_size(2);
    h.fake.seed(FakeMsg::new("a", "ta", &["SENT"]).days_ago(1));
    h.fake.seed(FakeMsg::new("b", "tb", &["SENT"]).days_ago(2));
    h.fake.seed(FakeMsg::new("c", "tc", &["SENT"]).days_ago(10));
    h.fake
        .seed(FakeMsg::new("d", "td", &["SENT"]).days_ago(FULL_BODY_DAYS + 20));
    h.fake
        .seed(FakeMsg::new("e", "te", &["TRASH"]).days_ago(FULL_BODY_DAYS + 30));
    h.engine.run_initial_sync().await.unwrap();

    assert_eq!(
        h.engine.backfill_step().await.unwrap(),
        BackfillProgress::More
    );
    assert_eq!(
        h.engine.backfill_step().await.unwrap(),
        BackfillProgress::More
    );
    assert_eq!(
        h.engine.backfill_step().await.unwrap(),
        BackfillProgress::Done
    );
    assert_eq!(
        h.engine.backfill_step().await.unwrap(),
        BackfillProgress::Done
    );

    let full = |id: &'static str| {
        let pool = h.pool.clone();
        async move {
            messages::get_message(&pool, ACCT, id)
                .await
                .unwrap()
                .unwrap()
                .fully_fetched
        }
    };
    assert_eq!(full("a").await, 1);
    assert_eq!(full("d").await, 1, "page 2 itself is still fetched in full");
    assert_eq!(full("e").await, 0, "after the body window: metadata only");
    assert_eq!(
        listed(&h.pool, "TRASH").await,
        s(&["te"]),
        "spam/trash included"
    );
}

#[tokio::test]
async fn backfill_does_not_overwrite_newer_cache() {
    let h = harness().await;
    h.fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
    h.engine.run_initial_sync().await.unwrap();
    // Cache moved on (e.g. a pending star) while the server copy says otherwise.
    let mut conn = h.pool.acquire().await.unwrap();
    messages::set_labels(&mut conn, ACCT, "m1", &s(&["INBOX", "STARRED"]))
        .await
        .unwrap();
    drop(conn);
    while h.engine.backfill_step().await.unwrap() == BackfillProgress::More {}
    assert_eq!(
        cached_labels(&h.pool, "m1").await,
        Some(s(&["INBOX", "STARRED"]))
    );
}

#[tokio::test]
async fn backfill_skips_messages_deleted_by_sync() {
    let h = harness().await;
    h.fake.seed(FakeMsg::new("m1", "t1", &["SENT"]));
    h.engine.run_initial_sync().await.unwrap();
    // Sync deleted m1 after backfill fetched its page (tombstone recorded under the lock).
    h.engine.write_lock.lock().await.insert("m1".into());
    while h.engine.backfill_step().await.unwrap() == BackfillProgress::More {}
    assert!(cached_labels(&h.pool, "m1").await.is_none());
    assert!(
        h.engine.write_lock.lock().await.is_empty(),
        "cleared when backfill completes"
    );
}

// ---- outbox -------------------------------------------------------------------------

async fn synced_inbox(h: &H, msgs: Vec<FakeMsg>) {
    for m in msgs {
        h.fake.seed(m);
    }
    h.engine.run_initial_sync().await.unwrap();
    h.events.take();
}

async fn archive(h: &H, thread: &str) -> String {
    outbox::enqueue_modify(&h.pool, ACCT, &s(&[thread]), &[], &s(&["INBOX"]))
        .await
        .unwrap()
        .unwrap()
        .op_id
}

async fn star(h: &H, thread: &str) -> String {
    outbox::enqueue_modify(&h.pool, ACCT, &s(&[thread]), &s(&["STARRED"]), &[])
        .await
        .unwrap()
        .unwrap()
        .op_id
}

async fn ops(h: &H) -> Vec<store::DbOp> {
    store::for_account(&h.pool, ACCT).await.unwrap()
}

fn server_labels(h: &H, id: &str) -> Vec<String> {
    sorted(h.fake.message(id).unwrap().labels)
}

#[tokio::test]
async fn enqueue_archive_applies_locally_and_persists_op() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])]).await;
    archive(&h, "t1").await;
    assert!(listed(&h.pool, "INBOX").await.is_empty());
    assert_eq!(cached_labels(&h.pool, "m1").await, Some(s(&["UNREAD"])));
    let ops = ops(&h).await;
    assert_eq!((ops.len(), ops[0].status.as_str()), (1, "pending"));
    assert_eq!(
        server_labels(&h, "m1"),
        s(&["INBOX", "UNREAD"]),
        "nothing sent yet"
    );
    assert!(outbox::enqueue_trash(&h.pool, ACCT, &s(&["nope"]))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn ops_survive_restart_and_replay_in_order() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX"]).days_ago(1)]).await;
    star(&h, "t1").await;
    archive(&h, "t1").await;

    // Restart: a fresh pool on the same file.
    let pool = crate::db::init_db(h._dir.path()).await.unwrap();
    let engine = SyncEngine::new(
        pool,
        h.fake.clone(),
        ACCT,
        h.events.clone(),
        Default::default(),
    );
    assert!(outbox::process(&engine, now_ms()).await.unwrap());

    assert_eq!(h.fake.calls("batch_modify"), 2);
    assert_eq!(server_labels(&h, "m1"), s(&["STARRED"]));
    assert!(ops(&h).await.is_empty());
}

#[tokio::test]
async fn sync_during_pending_op_keeps_optimistic_state() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])]).await;
    archive(&h, "t1").await;
    // Another device marks it read before our archive reaches Gmail.
    h.fake.relabel("m1", &[], &["UNREAD"]);

    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(
        cached_labels(&h.pool, "m1").await,
        Some(vec![]),
        "read applied, still archived"
    );
    assert!(listed(&h.pool, "INBOX").await.is_empty());

    // Our own change comes back through history: a no-op.
    outbox::process(&h.engine, now_ms()).await.unwrap();
    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(cached_labels(&h.pool, "m1").await, Some(vec![]));
    assert_eq!(server_labels(&h, "m1"), Vec::<String>::new());
}

#[tokio::test]
async fn pending_op_survives_full_refetch_after_history_expiry() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX"])]).await;
    archive(&h, "t1").await;
    // Offline for a week: the reconcile refetches the Inbox, where m1 still is on Gmail.
    h.fake.expire_history();
    h.engine.run_incremental_sync().await.unwrap();
    assert!(
        listed(&h.pool, "INBOX").await.is_empty(),
        "pending archive re-applied"
    );
    assert_eq!(cached_labels(&h.pool, "m1").await, Some(vec![]));
}

#[tokio::test]
async fn new_message_after_archive_is_not_archived() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX"]).days_ago(1)]).await;
    archive(&h, "t1").await;
    h.fake
        .add(FakeMsg::new("m2", "t1", &["INBOX", "UNREAD"]).at(now_ms() + 60_000));
    h.engine.run_incremental_sync().await.unwrap();
    outbox::process(&h.engine, now_ms()).await.unwrap();
    h.engine.run_incremental_sync().await.unwrap();

    assert_eq!(server_labels(&h, "m2"), s(&["INBOX", "UNREAD"]));
    assert_eq!(
        cached_labels(&h.pool, "m2").await,
        Some(s(&["INBOX", "UNREAD"]))
    );
    assert_eq!(cached_labels(&h.pool, "m1").await, Some(vec![]));
    assert_eq!(
        listed(&h.pool, "INBOX").await,
        s(&["t1"]),
        "the new reply brings it back"
    );
}

#[tokio::test]
async fn archive_includes_older_uncached_messages() {
    let h = harness().await;
    let mut msgs: Vec<FakeMsg> = (0..super::engine::INITIAL_THREADS as i64)
        .map(|n| FakeMsg::new(&format!("n{n}"), &format!("tn{n}"), &["INBOX"]).days_ago(n))
        .collect();
    msgs.push(FakeMsg::new("old", "t1", &["INBOX"]).days_ago(100));
    synced_inbox(&h, msgs).await;
    assert!(cached_labels(&h.pool, "old").await.is_none());
    h.fake.add(FakeMsg::new("reply", "t1", &["INBOX"]));
    h.engine.run_incremental_sync().await.unwrap();

    archive(&h, "t1").await;
    outbox::process(&h.engine, now_ms()).await.unwrap();
    assert_eq!(server_labels(&h, "old"), Vec::<String>::new());
    assert_eq!(server_labels(&h, "reply"), Vec::<String>::new());
}

#[tokio::test]
async fn rejected_op_rolls_back_with_later_ops_reapplied() {
    let h = harness().await;
    synced_inbox(&h, vec![FakeMsg::new("m1", "t1", &["INBOX"])]).await;
    let starred = star(&h, "t1").await;
    archive(&h, "t1").await;
    h.fake.fail_next("batch_modify", rejected());

    outbox::process(&h.engine, now_ms()).await.unwrap();

    assert_eq!(
        server_labels(&h, "m1"),
        Vec::<String>::new(),
        "archive still went through"
    );
    assert_eq!(
        cached_labels(&h.pool, "m1").await,
        Some(vec![]),
        "star rolled back, archive kept"
    );
    let rejected = h.events.take().into_iter().find_map(|e| match e {
        SyncEvent::OpRejected { op_id, .. } => Some(op_id),
        _ => None,
    });
    assert_eq!(rejected, Some(starred));
    assert!(ops(&h).await.is_empty());
}

#[tokio::test]
async fn network_failure_keeps_op_pending_and_blocks_later_ops() {
    let h = harness().await;
    synced_inbox(
        &h,
        vec![
            FakeMsg::new("m1", "t1", &["INBOX"]),
            FakeMsg::new("m2", "t2", &["INBOX"]),
        ],
    )
    .await;
    archive(&h, "t1").await;
    archive(&h, "t2").await;
    h.fake
        .fail_next("get_thread", GmailError::Offline("no route".into()));

    let now = now_ms();
    assert!(!outbox::process(&h.engine, now).await.unwrap());
    let queued = ops(&h).await;
    assert_eq!(queued.len(), 2);
    assert!(queued[0].next_attempt_at > now && queued[0].attempts == 1);
    assert_eq!(h.fake.calls("batch_modify"), 0, "later op waits its turn");
    assert!(
        !outbox::process(&h.engine, now + 1).await.unwrap(),
        "still backing off"
    );
    assert!(
        listed(&h.pool, "INBOX").await.is_empty(),
        "optimistic state kept"
    );

    assert!(outbox::process(&h.engine, now + 60_000).await.unwrap());
    assert!(ops(&h).await.is_empty());
    assert_eq!(server_labels(&h, "m2"), Vec::<String>::new());
}

// ---- sends --------------------------------------------------------------------------

const RAW: &[u8] = b"From: me@example.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nHello";

async fn send_op(h: &H) -> store::DbOp {
    let id = outbox::queue_send(&h.pool, ACCT, RAW).await.unwrap();
    store::get(&h.pool, &id).await.unwrap().unwrap()
}

async fn op_status(h: &H, id: &str) -> Option<String> {
    store::get(&h.pool, id).await.unwrap().map(|o| o.status)
}

#[tokio::test]
async fn queue_send_adds_message_id_and_sends() {
    let h = harness().await;
    let op = send_op(&h).await;
    let mid = op.rfc822_message_id.clone().unwrap();
    assert!(mid.starts_with('<') && mid.ends_with("@pheeme.app>"));
    outbox::process(&h.engine, now_ms()).await.unwrap();
    assert_eq!(h.fake.sent().len(), 1);
    assert!(op_status(&h, &op.id).await.is_none());
    let raw = crate::gmail::mime::decode_base64url(&h.fake.sent()[0]).unwrap();
    assert!(String::from_utf8(raw)
        .unwrap()
        .starts_with(&format!("Message-ID: {mid}\r\n")));
}

#[tokio::test]
async fn ambiguous_send_never_resends_and_confirms_via_search() {
    let h = harness().await;
    h.engine.run_initial_sync().await.unwrap();
    let op = send_op(&h).await;
    h.fake.deliver_then_fail(network());
    let t = now_ms();

    outbox::process(&h.engine, t).await.unwrap();
    assert_eq!(op_status(&h, &op.id).await.as_deref(), Some("checking"));
    // Search fails at the first check: not counted, retried.
    h.fake
        .fail_next("search_messages", GmailError::Offline("x".into()));
    outbox::process(&h.engine, t + 30_000).await.unwrap();
    let after = store::get(&h.pool, &op.id).await.unwrap().unwrap();
    assert_eq!((after.status.as_str(), after.checks_done), ("checking", 0));
    outbox::process(&h.engine, t + 60_000).await.unwrap();

    assert!(op_status(&h, &op.id).await.is_none(), "found in Sent");
    assert_eq!(h.fake.sent().len(), 1, "never sent twice");
    assert_eq!(h.fake.calls("send_message"), 1);
}

#[tokio::test]
async fn interrupted_send_is_confirmed_not_resent() {
    let h = harness().await;
    let op = send_op(&h).await;
    // The app died after marking the send in flight.
    let progress = store::OpProgress {
        status: outbox::CHECKING,
        attempts: 1,
        next_attempt_at: 0,
        checks_done: 0,
        last_error: None,
    };
    store::update_progress(&h.pool, &op.id, &progress, 0)
        .await
        .unwrap();
    for n in 0..4 {
        outbox::process(&h.engine, now_ms() + n * 3_600_000)
            .await
            .unwrap();
    }
    assert_eq!(h.fake.calls("send_message"), 0);
    assert_eq!(op_status(&h, &op.id).await.as_deref(), Some("unconfirmed"));
}

#[tokio::test]
async fn unconfirmed_send_is_cleared_by_sync_but_not_by_a_draft() {
    let h = harness().await;
    h.engine.run_initial_sync().await.unwrap();
    let op = send_op(&h).await;
    let mid = op.rfc822_message_id.clone().unwrap();
    h.fake.fail_next("send_message", network());
    let t = now_ms();
    outbox::process(&h.engine, t).await.unwrap();
    for (n, delay) in outbox::CHECK_DELAYS_MS.iter().enumerate() {
        outbox::process(&h.engine, t + delay * (n as i64 + 1) * 10)
            .await
            .unwrap();
    }
    assert_eq!(op_status(&h, &op.id).await.as_deref(), Some("unconfirmed"));

    let mut draft = FakeMsg::new("d1", "td", &["DRAFT"]);
    draft.message_id = mid.clone();
    h.fake.add(draft);
    h.engine.run_incremental_sync().await.unwrap();
    assert_eq!(
        op_status(&h, &op.id).await.as_deref(),
        Some("unconfirmed"),
        "a draft doesn't count"
    );

    let mut sent = FakeMsg::new("s1", "ts", &["SENT"]);
    sent.message_id = mid;
    h.fake.add(sent);
    h.engine.run_incremental_sync().await.unwrap();
    assert!(op_status(&h, &op.id).await.is_none());
    assert!(h.events.take().iter().any(|e| matches!(
        e,
        SyncEvent::SendStatus { status, .. } if status == "sent"
    )));
}

#[tokio::test]
async fn rejected_send_fails_and_resend_keeps_message_id() {
    let h = harness().await;
    let op = send_op(&h).await;
    h.fake.fail_next("send_message", rejected());
    outbox::process(&h.engine, now_ms()).await.unwrap();
    assert_eq!(op_status(&h, &op.id).await.as_deref(), Some("failed"));
    assert!(h.fake.sent().is_empty());

    assert!(outbox::resend(&h.pool, &op.id).await.unwrap());
    outbox::process(&h.engine, now_ms()).await.unwrap();
    assert_eq!(h.fake.sent().len(), 1);
    let raw = crate::gmail::mime::decode_base64url(&h.fake.sent()[0]).unwrap();
    assert!(String::from_utf8(raw)
        .unwrap()
        .contains(op.rfc822_message_id.as_deref().unwrap()));
}

#[tokio::test]
async fn offline_send_stays_pending_and_retries() {
    let h = harness().await;
    let op = send_op(&h).await;
    h.fake
        .fail_next("send_message", GmailError::Offline("no route".into()));
    let t = now_ms();
    outbox::process(&h.engine, t).await.unwrap();
    assert_eq!(op_status(&h, &op.id).await.as_deref(), Some("pending"));
    outbox::process(&h.engine, t + 60_000).await.unwrap();
    assert!(op_status(&h, &op.id).await.is_none());
    assert_eq!(h.fake.sent().len(), 1);
}
