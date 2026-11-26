use super::attachment::{openable_file_name, INVITE_MAX_BYTES, OPEN_COPY_MAX_AGE};
use super::*;
use crate::db::accounts::{self, DbAccount};
use crate::db::attachments::DbAttachment;
use crate::db::test_support::TestDb;
use crate::db::threads::DbThread;
use crate::gmail::GmailError;
use crate::sync::events::RecordingEvents;
use crate::sync::fake::{FakeGmail, FakeMsg};
use crate::sync::MailApi;

#[tokio::test]
async fn list_threads_dto_matches_fixture_shape() {
    let t = DbThread {
        id: "t".into(),
        account_id: "a".into(),
        subject: Some("s".into()),
        snippet: None,
        history_id: None,
        last_message_date: Some(5),
        message_count: 2,
        unread_count: 1,
        has_attachment: 0,
        from_name: None,
        from_address: None,
        is_starred: 1,
    };
    let json = serde_json::to_value(ThreadSummaryDto::from(t)).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    // The preview's `toSummary` (src/preview/install.ts) returns the same keys.
    assert_eq!(
        keys,
        [
            "accountId",
            "date",
            "fromAddress",
            "fromName",
            "hasAttachment",
            "id",
            "labelIds",
            "messageCount",
            "snippet",
            "starred",
            "subject",
            "systemLabelIds",
            "unread"
        ]
    );
    assert_eq!(
        (json["unread"].as_bool(), json["starred"].as_bool()),
        (Some(true), Some(true))
    );
}

#[tokio::test]
async fn modify_threads_applies_now_emits_and_reaches_gmail() {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"]));
    let events = Arc::new(RecordingEvents::default());
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        events.clone(),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        pool.clone(),
        sync.clone(),
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    events.take();

    mail.modify_threads("a1", &["t1".into()], &[], &["UNREAD".into()])
        .await
        .unwrap();

    let page = mail
        .list_threads(&["a1".into()], "INBOX", None, None, None, None)
        .await
        .unwrap();
    assert!(!page.threads[0].unread, "read in the cache immediately");
    assert!(events
        .take()
        .iter()
        .any(|e| matches!(e, SyncEvent::MessagesUpdated { .. })));
    for _ in 0..50 {
        if !fake
            .message("m1")
            .unwrap()
            .labels
            .contains(&"UNREAD".to_string())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        fake.message("m1").unwrap().labels,
        ["INBOX"],
        "pushed in the background"
    );
    assert!(matches!(
        mail.modify_threads("a1", &[], &[], &["INBOX".into()]).await,
        Err(MailError::Invalid(_))
    ));
}

#[tokio::test]
async fn modify_threads_reports_spam_and_undoes_it_but_never_touches_trash() {
    let db = TestDb::with_account("a1").await;
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
    let api = fake.clone();
    let sync = SyncManager::new(
        db.pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        db.pool.clone(),
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let in_mailbox = |label: &'static str| {
        let mail = &mail;
        async move {
            mail.list_threads(&["a1".into()], label, None, None, None, None)
                .await
                .unwrap()
                .threads
                .len()
        }
    };

    mail.modify_threads("a1", &["t1".into()], &["SPAM".into()], &["INBOX".into()])
        .await
        .unwrap();
    assert_eq!((in_mailbox("INBOX").await, in_mailbox("SPAM").await), (0, 1));

    mail.modify_threads("a1", &["t1".into()], &["INBOX".into()], &["SPAM".into()])
        .await
        .unwrap();
    assert_eq!((in_mailbox("INBOX").await, in_mailbox("SPAM").await), (1, 0));

    for (add, remove) in [("TRASH", "INBOX"), ("INBOX", "TRASH")] {
        assert!(matches!(
            mail.modify_threads("a1", &["t1".into()], &[add.into()], &[remove.into()])
                .await,
            Err(MailError::Invalid(_))
        ));
    }
}

#[test]
fn inbox_tab_search_names_the_tab_or_what_primary_leaves_out() {
    assert_eq!(
        inbox_tab_search(Some("CATEGORY_PROMOTIONS"), &[]),
        "in:inbox is:unread category:promotions"
    );
    assert_eq!(
        inbox_tab_search(None, &primary_excludes(&["CATEGORY_SOCIAL".into()])),
        "in:inbox is:unread -category:promotions -category:updates -category:forums"
    );
}

#[tokio::test]
async fn mark_inbox_tab_read_refuses_other_labels() {
    let db = TestDb::with_account("a1").await;
    let fake = Arc::new(FakeGmail::new());
    let sync = SyncManager::new(
        db.pool.clone(),
        Arc::new(move |_| fake.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    let mail = MailService::new(
        db.pool.clone(),
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    for label in ["INBOX", "STARRED", "Label_1"] {
        assert!(matches!(
            mail.mark_inbox_tab_read("a1", label).await,
            Err(MailError::Invalid(_))
        ));
    }
}

#[tokio::test]
async fn list_threads_rows_carry_user_label_ids() {
    let db = TestDb::with_account("a1").await;
    let fake = Arc::new(FakeGmail::new());
    fake.add_user_label("Label_1", "alpha", None);
    fake.add_user_label("Label_2", "beta", None);
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "Label_2", "Label_1"]));
    fake.seed(FakeMsg::new("m2", "t2", &["INBOX"]));
    let api = fake.clone();
    let sync = SyncManager::new(
        db.pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        db.pool.clone(),
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let page = mail
        .list_threads(&["a1".to_owned()], "INBOX", None, None, None, None)
        .await
        .unwrap();
    let by_id = |id: &str| {
        page.threads
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .label_ids
            .clone()
    };
    assert_eq!(by_id("t1"), ["Label_1", "Label_2"]);
    assert!(by_id("t2").is_empty());
    let detail = mail.get_thread("a1", "t1", true).await.unwrap();
    assert_eq!(detail.thread.label_ids, ["Label_1", "Label_2"]);
    // System labels travel separately, so a row can say where it sits.
    let system = |id: &str| {
        page.threads
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .system_label_ids
            .clone()
    };
    assert_eq!(system("t1"), ["INBOX"]);
    assert_eq!(system("t2"), ["INBOX"]);
    assert_eq!(detail.thread.system_label_ids, ["INBOX"]);
}

#[tokio::test]
async fn list_threads_dispatches_all_mail_and_primary_and_counts_labels() {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"]));
    fake.seed(FakeMsg::new(
        "m2",
        "t2",
        &["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
    ));
    fake.seed(FakeMsg::new("m3", "t3", &["INBOX", "CATEGORY_SOCIAL"]));
    fake.seed(FakeMsg::new("m4", "t4", &["SPAM", "UNREAD"]));
    fake.seed(FakeMsg::new(
        "m5",
        "t5",
        &["INBOX", "CATEGORY_UPDATES", "Label_1", "UNREAD"],
    ));
    let events = Arc::new(RecordingEvents::default());
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        events,
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        pool,
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let accounts = ["a1".to_owned()];
    let ids = |page: ThreadPageDto| {
        let mut ids: Vec<String> = page.threads.into_iter().map(|t| t.id).collect();
        ids.sort();
        ids
    };

    let primary = mail
        .list_threads(
            &accounts,
            "INBOX",
            Some("CATEGORY_PERSONAL"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(ids(primary), ["t1", "t2"]);
    let social = mail
        .list_threads(
            &accounts,
            "INBOX",
            Some("CATEGORY_SOCIAL"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(ids(social), ["t3"]);
    let all = mail
        .list_threads(&accounts, ALL_MAIL, None, None, None, None)
        .await
        .unwrap();
    assert_eq!(ids(all), ["t1", "t2", "t3", "t5"]);

    let counts = mail.label_counts("a1").await.unwrap();
    let count = |id: &str| {
        counts
            .iter()
            .find(|c| c.label_id == id)
            .map(|c| (c.unread, c.total))
    };
    assert_eq!(count("INBOX"), Some((3, 4)));
    assert_eq!(count("Label_1"), Some((1, 1)));
    assert_eq!(count("CATEGORY_SOCIAL"), Some((0, 1)));
}

#[tokio::test]
async fn label_counts_count_again_only_after_a_change() {
    let (db, _, _, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])).await;
    let inbox = |counts: Vec<LabelCountDto>| {
        counts
            .into_iter()
            .find(|c| c.label_id == "INBOX")
            .map(|c| (c.unread, c.total))
    };
    assert_eq!(inbox(mail.label_counts("a1").await.unwrap()), Some((1, 1)));

    // A count changed behind the service's back (no version bump) isn't seen, so neither a
    // repeat nor a sync that brings nothing new reads the counts again.
    sqlx::query("UPDATE label_thread_counts SET total = total + 5 WHERE label_id = 'INBOX'")
        .execute(&db.pool)
        .await
        .unwrap();
    mail.sync.engine("a1").run_incremental_sync().await.unwrap();
    assert_eq!(inbox(mail.label_counts("a1").await.unwrap()), Some((1, 1)));

    // A real change reads them again (with the tweak, which only a recount would undo).
    mail.modify_threads("a1", &["t1".into()], &[], &["UNREAD".into()])
        .await
        .unwrap();
    assert_eq!(inbox(mail.label_counts("a1").await.unwrap()), Some((0, 6)));
}

#[tokio::test]
async fn list_primary_includes_hidden_tab_mail() {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"]));
    fake.seed(FakeMsg::new(
        "m2",
        "t2",
        &["INBOX", "CATEGORY_SOCIAL", "UNREAD"],
    ));
    fake.seed(FakeMsg::new(
        "m3",
        "t3",
        &["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"],
    ));
    let events = Arc::new(RecordingEvents::default());
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        events.clone(),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        pool,
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let accounts = ["a1".to_owned()];
    let list = |tab: &'static str| {
        let mail = &mail;
        let accounts = &accounts;
        async move {
            let page = mail
                .list_threads(accounts, "INBOX", Some(tab), None, None, None)
                .await
                .unwrap();
            let mut ids: Vec<String> = page.threads.into_iter().map(|t| t.id).collect();
            ids.sort();
            ids
        }
    };
    assert_eq!(list("CATEGORY_PERSONAL").await, ["t1"]);

    events.take();
    let hidden = mail
        .set_inbox_tabs("a1", &["CATEGORY_SOCIAL".to_owned(), "X".to_owned()])
        .await
        .unwrap();
    assert_eq!(hidden, ["CATEGORY_SOCIAL"]);
    assert_eq!(mail.inbox_tabs("a1").await.unwrap(), ["CATEGORY_SOCIAL"]);
    assert!(events.take().contains(&SyncEvent::LabelsUpdated {
        account_id: "a1".into()
    }));

    assert_eq!(list("CATEGORY_PERSONAL").await, ["t1", "t2"]);
    assert_eq!(list("CATEGORY_SOCIAL").await, ["t2"]);
    assert_eq!(list("CATEGORY_PROMOTIONS").await, ["t3"]);
    let counts = mail.mailbox_counts(&accounts).await.unwrap();
    let count = |id: &str| counts.iter().find(|c| c.label_id == id).map(|c| c.unread);
    assert_eq!(count("CATEGORY_PERSONAL"), Some(2));
    assert_eq!(count("CATEGORY_SOCIAL"), Some(1));
}

#[tokio::test]
async fn get_thread_includes_attachments() {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment(
        "a.pdf",
        "application/pdf",
        "g1",
    ));
    fake.seed(
        FakeMsg::new("m2", "t1", &["INBOX"])
            .with_attachment("z.pdf", "application/pdf", "g2")
            .with_attachment("b.pdf", "application/pdf", "g3"),
    );
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        pool.clone(),
        sync.clone(),
        db.dir().join("cache"),
        crate::storage::test_key(),
    );

    let detail = mail.get_thread("a1", "t1", true).await.unwrap();
    let attachments = |id| {
        &detail
            .messages
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .attachments
    };

    assert_eq!(
        attachments("m1"),
        &[AttachmentDto {
            id: "0".into(),
            filename: Some("a.pdf".into()),
            mime_type: Some("application/pdf".into()),
            size: Some(1),
            is_inline: false,
            content_id: None,
        }]
    );
    assert_eq!(
        attachments("m2")
            .iter()
            .map(|a| a.filename.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["b.pdf", "z.pdf"]
    );
}

/// A synced account with one message in `t1`, and the events it emits.
async fn events_fixture(
    msg: FakeMsg,
) -> (TestDb, Arc<FakeGmail>, Arc<RecordingEvents>, MailService) {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(msg);
    let events = Arc::new(RecordingEvents::default());
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        events.clone(),
    );
    // Sync without the manager's background backfill, which would race tests that clear bodies.
    sync.engine("a1").run_incremental_sync().await.unwrap();
    let mail = MailService::new(
        pool,
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    (db, fake, events, mail)
}

async fn fully_fetched(mail: &MailService, id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT fully_fetched FROM messages WHERE id = ?")
        .bind(id)
        .fetch_one(&mail.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn get_thread_serves_cached_bodies_while_gmail_hangs_and_refreshes_later() {
    let (_dir, fake, events, mail) = events_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
    )
    .await;
    // What migration 003 does to messages with attachments: the body stays cached.
    sqlx::query("UPDATE messages SET fully_fetched = 0")
        .execute(&mail.db)
        .await
        .unwrap();
    let gate = fake.hold_batch_gets();
    events.take();

    let detail = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        mail.get_thread("a1", "t1", true),
    )
    .await
    .expect("cached bodies don't wait for Gmail")
    .unwrap();

    assert_eq!(detail.messages[0].body_text.as_deref(), Some("Body of m1"));
    assert!(detail.messages[0].body_available);
    assert_eq!(fully_fetched(&mail, "m1").await, 0, "refresh still pending");

    // Gmail answers: the refresh lands in the background and the open view hears of it.
    gate.add_permits(100);
    for _ in 0..100 {
        if fully_fetched(&mail, "m1").await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(fully_fetched(&mail, "m1").await, 1);
    assert!(events.take().iter().any(|e| matches!(
        e,
        SyncEvent::MessagesUpdated { modified, .. } if modified == &["t1".to_owned()]
    )));
}

#[tokio::test]
async fn clearing_downloaded_mail_drops_bodies_and_attachments_and_tells_the_ui() {
    let (_dir, _fake, events, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    assert_eq!(fully_fetched(&mail, "m1").await, 1);
    let cached = mail.attachments.path("a1", "m1", "0");
    mail.attachments.write(&cached, b"12345").await.unwrap();
    events.take();

    assert_eq!(
        mail.clear_downloaded().await.unwrap(),
        (1, (5 + crate::storage::FILE_OVERHEAD) as u64)
    );
    assert_eq!(fully_fetched(&mail, "m1").await, 0);
    assert!(!cached.exists());
    assert_eq!(
        events.take(),
        vec![SyncEvent::MessagesUpdated {
            account_id: "a1".into(),
            added: vec![],
            removed: vec![],
            modified: vec!["t1".into()],
        }]
    );
}

#[tokio::test]
async fn a_background_refresh_that_fetches_nothing_emits_nothing() {
    let (_dir, fake, events, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0")
        .execute(&mail.db)
        .await
        .unwrap();
    fake.delete("m1");
    events.take();

    mail.sync
        .engine("a1")
        .load_thread_bodies("t1")
        .await
        .unwrap();

    assert!(
        events.take().is_empty(),
        "an open view would refresh, refetch and loop"
    );
}

#[tokio::test]
async fn a_body_gmail_couldnt_send_is_reported_unavailable() {
    let (_dir, fake, _events, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL")
        .execute(&mail.db)
        .await
        .unwrap();
    fake.fail_next("get_message", GmailError::Offline("no route".into()));

    let offline = mail.get_thread("a1", "t1", true).await.unwrap();
    assert_eq!(offline.messages[0].body_text, None);
    assert!(!offline.messages[0].body_available, "not an empty message");

    let online = mail.get_thread("a1", "t1", true).await.unwrap();
    assert!(online.messages[0].body_available);
    assert_eq!(online.messages[0].body_text.as_deref(), Some("Body of m1"));
}

#[tokio::test]
async fn preload_cached_thread_never_requests_gmail() {
    let (_dir, fake, _events, mail) =
        events_fixture(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0")
        .execute(&mail.db)
        .await
        .unwrap();
    let calls = fake.calls("get_message");
    let detail = mail.preload_thread("a1", "t1").await.unwrap();
    assert!(detail.thread.unread);
    assert_eq!(fake.calls("get_message"), calls);
    assert_eq!(fully_fetched(&mail, "m1").await, 0);
}

#[tokio::test]
async fn preload_missing_body_uses_bulk_and_preserves_labels() {
    let (_dir, fake, events, mail) =
        events_fixture(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL")
        .execute(&mail.db)
        .await
        .unwrap();
    // An optimistic label differs from Gmail; body loading must preserve it.
    let mut row = messages::get_message(&mail.db, "a1", "m1")
        .await
        .unwrap()
        .unwrap();
    row.label_ids = Some("[\"INBOX\",\"UNREAD\",\"STARRED\"]".into());
    row.is_starred = 1;
    messages::upsert_message(&mail.db, &row).await.unwrap();
    events.take();
    let calls = fake.background_calls("get_message");
    let detail = mail.preload_thread("a1", "t1").await.unwrap();
    assert_eq!(detail.messages[0].body_text.as_deref(), Some("Body of m1"));
    assert!(detail.thread.unread);
    assert_eq!(detail.body_error, None);
    assert!(events.take().is_empty(), "a preload announces nothing");
    assert!(mail.recent_opens().is_empty());
    assert_eq!(fake.background_calls("get_message"), calls + 1);
    assert!(detail.messages[0].label_ids.contains(&"INBOX".to_owned()));
    assert!(detail.messages[0].starred);
    assert!(detail.messages[0].label_ids.contains(&"STARRED".to_owned()));
}

#[tokio::test]
async fn preload_rate_limit_propagates_without_retry() {
    let (_dir, fake, _events, mail) =
        events_fixture(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL")
        .execute(&mail.db)
        .await
        .unwrap();
    fake.fail_next("get_message", GmailError::RateLimit { retry_after: None });
    let calls = fake.background_calls("get_message");
    let error = mail.preload_thread("a1", "t1").await.unwrap_err();
    assert_eq!(error.code(), "rate_limit");
    assert_eq!(fake.background_calls("get_message"), calls + 1);
    assert_eq!(fully_fetched(&mail, "m1").await, 0);
}

#[tokio::test]
async fn get_thread_still_waits_for_a_missing_body() {
    let (_dir, _fake, _events, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL")
        .execute(&mail.db)
        .await
        .unwrap();

    let detail = mail.get_thread("a1", "t1", true).await.unwrap();

    assert_eq!(detail.messages[0].body_text.as_deref(), Some("Body of m1"));
    assert_eq!(fully_fetched(&mail, "m1").await, 1);
}

/// `events_fixture` with `m1`'s body dropped from the cache, as for mail outside the
/// initial sync.
async fn missing_body_fixture() -> (TestDb, Arc<FakeGmail>, Arc<RecordingEvents>, MailService) {
    let fixture = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    sqlx::query("UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL")
        .execute(&fixture.3.db)
        .await
        .unwrap();
    fixture.2.take();
    fixture
}

/// The `mail:thread_loading` stages among `events`.
fn loading_stages(events: &[SyncEvent]) -> Vec<&'static str> {
    events
        .iter()
        .filter_map(|e| match e {
            SyncEvent::ThreadLoading {
                account_id,
                thread_id,
                stage,
                ..
            } => {
                assert_eq!((account_id.as_str(), thread_id.as_str()), ("a1", "t1"));
                Some(*stage)
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn opened_get_thread_emits_loading_events_and_records_timing() {
    let (_dir, _fake, events, mail) = missing_body_fixture().await;

    let detail = mail.get_thread("a1", "t1", true).await.unwrap();

    assert!(detail.messages[0].body_available);
    assert_eq!(detail.body_error, None);
    let events = events.take();
    let stages = loading_stages(&events);
    let fetching = stages.iter().position(|s| *s == "fetching");
    assert!(fetching.is_some(), "{stages:?}");
    assert_eq!(stages.last(), Some(&"done"), "{stages:?}");
    let loading = events
        .iter()
        .find(|e| e.name() == "mail:thread_loading")
        .unwrap();
    let json = serde_json::to_value(loading).unwrap();
    let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "accountId",
            "attempt",
            "reason",
            "retryInMs",
            "stage",
            "syncBusy",
            "threadId"
        ]
    );

    let opens = mail.recent_opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].source, "gmail");
    assert_eq!(opens[0].messages_fetched, 1);
    assert_eq!(opens[0].outcome, "ok");
}

#[tokio::test]
async fn cached_get_thread_emits_nothing() {
    let (_dir, _fake, events, mail) = events_fixture(FakeMsg::new("m1", "t1", &["INBOX"])).await;
    events.take();

    mail.get_thread("a1", "t1", true).await.unwrap();

    assert_eq!(loading_stages(&events.take()), Vec::<&str>::new());
    let opens = mail.recent_opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].source, "cache");
    assert_eq!(opens[0].messages_fetched, 0);
}

#[tokio::test]
async fn prefetch_get_thread_emits_nothing() {
    let (_dir, _fake, events, mail) = missing_body_fixture().await;

    let detail = mail.get_thread("a1", "t1", false).await.unwrap();

    assert!(detail.messages[0].body_available, "prefetch still fetches");
    assert_eq!(loading_stages(&events.take()), Vec::<&str>::new());
    assert!(mail.recent_opens().is_empty(), "only opens are timed");
}

#[tokio::test]
async fn get_thread_reports_body_error_offline() {
    let (_dir, fake, events, mail) = missing_body_fixture().await;
    fake.fail_next(
        "get_message",
        GmailError::Offline("error sending request for url (https://x/?q=secret)".into()),
    );

    let offline = mail.get_thread("a1", "t1", true).await.unwrap();

    assert!(!offline.messages[0].body_available);
    let error = offline.body_error.expect("the reason is reported");
    assert_eq!(error.code, "network");
    assert!(error.message.contains("offline"), "{}", error.message);
    assert!(!error.message.contains("http"), "{}", error.message);
    assert_eq!(loading_stages(&events.take()).last(), Some(&"done"));
    assert_eq!(mail.recent_opens()[0].outcome, "network");
    let json = serde_json::to_value(mail.get_thread("a1", "t1", true).await.unwrap()).unwrap();
    assert_eq!(json["bodyError"], serde_json::Value::Null);
}

#[tokio::test]
async fn get_thread_sanitizes_html_bodies() {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
    fake.seed(FakeMsg::new("m2", "t1", &["INBOX"]));
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    sqlx::query(
        "UPDATE messages SET body_html = '<script>alert(1)</script><img src=\"cid:logo\"><img src=\"https://t.co/p.gif\">' WHERE id = 'm1'",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET body_html = NULL WHERE id = 'm2'")
        .execute(&pool)
        .await
        .unwrap();
    let mail = MailService::new(
        pool.clone(),
        sync.clone(),
        db.dir().join("cache"),
        crate::storage::test_key(),
    );

    let detail = mail.get_thread("a1", "t1", true).await.unwrap();

    let html = detail.messages.iter().find(|m| m.id == "m1").unwrap();
    let body = html.body_html.as_deref().unwrap();
    assert!(!body.contains("script"), "{body}");
    assert!(body.contains("/a1/m1/logo"), "{body}");
    assert!(html.has_remote_content);
    assert!(!html.declares_dark_mode);
    let plain = detail.messages.iter().find(|m| m.id == "m2").unwrap();
    assert_eq!(plain.body_html, None);
    assert!(!plain.has_remote_content && !plain.declares_dark_mode);
}

/// A synced account whose single message carries the given attachments.
async fn attachment_fixture(
    msg: FakeMsg,
    seed: &[(&str, &[u8])],
) -> (TestDb, Arc<FakeGmail>, MailService) {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(FakeGmail::new());
    fake.seed(msg);
    for (id, bytes) in seed {
        fake.seed_attachment("m1", id, bytes);
    }
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    let mail = MailService::new(
        pool,
        sync,
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    (db, fake, mail)
}

#[tokio::test]
async fn attachment_bytes_are_fetched_once_then_cached() {
    let (dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
        &[("g1", b"%PDF-bytes")],
    )
    .await;

    let first = mail.attachment("a1", "m1", "0").await.unwrap();
    let second = mail.attachment("a1", "m1", "0").await.unwrap();

    assert_eq!(first.bytes, b"%PDF-bytes");
    assert_eq!(second, first);
    assert_eq!(first.mime_type, "application/pdf");
    assert_eq!(first.filename.as_deref(), Some("a.pdf"));
    assert_eq!(fake.attachment_fetches(), 1);
    assert!(dir.dir().join("cache/attachments-v1/a1/m1/0").is_file());
    assert!(matches!(
        mail.attachment("a1", "m1", "9").await,
        Err(MailError::NotFound)
    ));
}

#[tokio::test]
async fn prefetch_caches_previewable_files_once_and_skips_the_rest() {
    let (dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_attachment("plan.pdf", "application/octet-stream", "g1")
            .with_attachment("setup.zip", "application/zip", "g2")
            .with_attachment("huge.pdf", "application/pdf", "g3")
            .with_inline("logo.png", "image/png", "g4", "logo"),
        &[
            ("g1", b"%PDF"),
            ("g2", b"zip"),
            ("g3", b"big"),
            ("g4", b"png"),
        ],
    )
    .await;
    let big = i64::try_from(PREFETCH_MAX_FILE + 1).unwrap();
    sqlx::query("UPDATE attachments SET size = ? WHERE filename = 'huge.pdf'")
        .bind(big)
        .execute(&dir.pool)
        .await
        .unwrap();
    let ids = vec!["m1".to_owned(), "gone".to_owned()];

    assert_eq!(mail.prefetch_attachments("a1", &ids).await, 1);
    assert_eq!(
        mail.prefetch_attachments("a1", &ids).await,
        0,
        "already cached"
    );

    assert_eq!(fake.attachment_fetches(), 1, "only plan.pdf");
    let cached = |row: &str| {
        dir.dir()
            .join("cache/attachments-v1/a1/m1")
            .join(row)
            .is_file()
    };
    assert_eq!(
        [cached("0"), cached("1"), cached("2"), cached("3")],
        [true, false, false, false]
    );
    // The preview then reads it without going to Gmail.
    assert_eq!(
        mail.attachment("a1", "m1", "0").await.unwrap().bytes,
        b"%PDF"
    );
    assert_eq!(fake.attachment_fetches(), 1);
}

#[tokio::test]
async fn prefetch_stops_at_its_total_budget() {
    let (dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_attachment("a.pdf", "application/pdf", "g1")
            .with_attachment("b.pdf", "application/pdf", "g2")
            .with_attachment("c.pdf", "application/pdf", "g3")
            .with_attachment("d.pdf", "application/pdf", "g4")
            .with_attachment("e.pdf", "application/pdf", "g5"),
        &[
            ("g1", b"a"),
            ("g2", b"b"),
            ("g3", b"c"),
            ("g4", b"d"),
            ("g5", b"e"),
        ],
    )
    .await;
    let each = i64::try_from(PREFETCH_MAX_TOTAL / 4).unwrap();
    sqlx::query("UPDATE attachments SET size = ?")
        .bind(each)
        .execute(&dir.pool)
        .await
        .unwrap();

    assert_eq!(mail.prefetch_attachments("a1", &["m1".to_owned()]).await, 4);
    assert_eq!(fake.attachment_fetches(), 4);
}

#[tokio::test]
async fn a_preview_during_a_prefetch_waits_instead_of_downloading_again() {
    let (_dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
        &[("g1", b"%PDF")],
    )
    .await;
    let ids = vec!["m1".to_owned()];
    let (prefetched, opened) = tokio::join!(
        mail.prefetch_attachments("a1", &ids),
        mail.attachment("a1", "m1", "0")
    );
    assert_eq!(opened.unwrap().bytes, b"%PDF");
    assert!(prefetched <= 1);
    assert_eq!(fake.attachment_fetches(), 1);
}

#[tokio::test]
async fn open_copy_writes_documents_and_refuses_executables() {
    let (dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_attachment("../Plan.pdf", "application/pdf", "g1")
            .with_attachment("setup.exe", "application/pdf", "g2"),
        &[("g1", b"%PDF"), ("g2", b"MZ")],
    )
    .await;
    let opened = dir.dir().join("opened");
    let stale = opened.join("old");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::File::options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(stale.join("x.pdf"))
        .unwrap();
    // Windows opens a folder only with FILE_FLAG_BACKUP_SEMANTICS, and needs write access
    // to change its times.
    let mut folder = std::fs::File::options();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        folder.write(true).custom_flags(0x0200_0000);
    }
    #[cfg(not(windows))]
    folder.read(true);
    folder
        .open(&stale)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - 2 * OPEN_COPY_MAX_AGE)
        .unwrap();

    let rows = attachments::get_attachments_for_message(&dir.pool, "a1", "m1")
        .await
        .unwrap();
    let id_of = |name: &str| {
        rows.iter()
            .find(|r| r.filename.as_deref() == Some(name))
            .unwrap()
            .id
            .clone()
    };
    let path = mail
        .open_copy("a1", "m1", &id_of("../Plan.pdf"), &opened)
        .await
        .unwrap();
    assert_eq!(path.file_name().unwrap(), "Plan.pdf");
    assert!(path.starts_with(&opened));
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF");
    assert!(!stale.exists(), "day-old copies are cleared");

    assert!(matches!(
        mail.open_copy("a1", "m1", &id_of("setup.exe"), &opened)
            .await,
        Err(MailError::Invalid(_))
    ));
}

#[tokio::test]
async fn inline_image_rejects_non_images() {
    let (_dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_inline("logo.png", "image/png", "g1", "logo")
            .with_inline("doc.pdf", "application/pdf", "g2", "doc"),
        &[("g1", b"png"), ("g2", b"pdf")],
    )
    .await;

    assert!(matches!(
        mail.inline_image("a1", "m1", "doc").await,
        Err(MailError::NotFound)
    ));
    assert_eq!(fake.attachment_fetches(), 0, "not even downloaded");
    assert!(matches!(
        mail.inline_image("a1", "m1", "missing").await,
        Err(MailError::NotFound)
    ));
    assert_eq!(
        mail.inline_image("a1", "m1", "logo").await.unwrap().bytes,
        b"png"
    );
}

#[tokio::test]
async fn protocol_serves_signed_urls_only() {
    let (_dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_inline("logo.png", "image/png", "g1", "logo"),
        &[("g1", b"png")],
    )
    .await;
    let url = render::attachment_url("a1", "m1", "logo");
    let unsigned = url.split_once('?').unwrap().0;

    assert_eq!(mail.serve_inline_image(unsigned).await.status, 404);
    assert_eq!(fake.attachment_fetches(), 0, "unsigned never reaches Gmail");

    let ok = mail.serve_inline_image(&url).await;
    assert_eq!(ok.status, 200);
    assert_eq!(ok.content_type.as_deref(), Some("image/png"));
    assert_eq!(ok.body, b"png");

    let other = render::attachment_url("a1", "m1", "nope");
    assert_eq!(mail.serve_inline_image(&other).await.status, 404);
}

#[tokio::test]
async fn save_attachment_sanitizes_and_dedupes() {
    let (dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
        &[("g1", b"%PDF")],
    )
    .await;
    sqlx::query("UPDATE attachments SET filename = '../evil/a.pdf'")
        .execute(&mail.db)
        .await
        .unwrap();
    let target = dir.dir().join("Downloads");

    let one = mail
        .save_attachment("a1", "m1", "0", &target)
        .await
        .unwrap();
    let two = mail
        .save_attachment("a1", "m1", "0", &target)
        .await
        .unwrap();

    assert_eq!(one, target.join("a.pdf"));
    assert_eq!(two, target.join("a (1).pdf"));
    assert_eq!(std::fs::read(&one).unwrap(), b"%PDF");
    assert_eq!(std::fs::read(&two).unwrap(), b"%PDF");
    assert!(!dir.dir().join("evil").exists());
}

#[test]
fn safe_file_name_cases() {
    assert_eq!(safe_file_name(None), "attachment");
    assert_eq!(safe_file_name(Some("...")), "attachment");
    assert_eq!(safe_file_name(Some("  . ")), "attachment");
    assert_eq!(safe_file_name(Some("a\u{0}b.txt")), "ab.txt");
    assert_eq!(safe_file_name(Some("../evil/a.pdf")), "a.pdf");
    assert_eq!(safe_file_name(Some("C:\\Temp\\a:b.pdf")), "ab.pdf");
    assert_eq!(safe_file_name(Some("dir/")), "attachment");
    assert_eq!(safe_file_name(Some(".hidden")), "hidden");
    assert_eq!(safe_file_name(Some("ok name.txt ")), "ok name.txt");
    // A right-to-left override would show `invoice\u{202E}fdp.exe` as `invoiceexe.pdf`.
    assert_eq!(
        safe_file_name(Some("invoice\u{202E}fdp.exe")),
        "invoicefdp.exe"
    );
    assert_eq!(
        safe_file_name(Some("\u{200F}a\u{2066}b\u{2069}\u{061C}c\u{202A}.txt")),
        "abc.txt"
    );
    assert_eq!(safe_file_name(Some("Отчёт 報告.pdf")), "Отчёт 報告.pdf");
}

#[test]
fn openable_file_names_are_valid_on_windows() {
    assert_eq!(
        openable_file_name(Some("Q&A? <draft>*.pdf")),
        "Q&A_ _draft__.pdf"
    );
    assert_eq!(
        openable_file_name(Some("say \"hi\" | bye.txt")),
        "say _hi_ _ bye.txt"
    );
    assert_eq!(openable_file_name(Some("CON.pdf")), "_CON.pdf");
    assert_eq!(openable_file_name(Some("com1.tar.gz")), "_com1.tar.gz");
    assert_eq!(openable_file_name(Some("lpt9")), "_lpt9");
    assert_eq!(openable_file_name(Some("console.pdf")), "console.pdf");
    assert_eq!(openable_file_name(Some("com10.pdf")), "com10.pdf");
    assert_eq!(openable_file_name(Some("Plan.pdf")), "Plan.pdf");
    assert_eq!(openable_file_name(Some("éé.pdf")), "éé.pdf");
    assert_eq!(openable_file_name(Some("coméé.pdf")), "coméé.pdf");
}

#[test]
fn unique_path_counts_up_before_the_extension() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        unique_path(dir.path(), "a.tar.gz"),
        dir.path().join("a.tar.gz")
    );
    std::fs::write(dir.path().join("a.tar.gz"), "").unwrap();
    std::fs::write(dir.path().join("a.tar (1).gz"), "").unwrap();
    assert_eq!(
        unique_path(dir.path(), "a.tar.gz"),
        dir.path().join("a.tar (2).gz")
    );
    std::fs::write(dir.path().join("README"), "").unwrap();
    assert_eq!(
        unique_path(dir.path(), "README"),
        dir.path().join("README (1)")
    );
}

#[tokio::test]
async fn embedded_parts_without_an_attachment_id_are_served_and_saved() {
    let (dir, fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_embedded("logo.png", "image/png", Some("logo"), b"tiny-png")
            .with_embedded("note.txt", "text/plain", None, b"hello"),
        &[],
    )
    .await;
    // The rows keep no bytes and no Gmail attachment id.
    let rows = attachments::get_attachments_for_message(&mail.db, "a1", "m1")
        .await
        .unwrap();
    assert!(rows.iter().all(|r| r.attachment_id.is_none()));
    assert_eq!(rows.len(), 2);

    let url = render::attachment_url("a1", "m1", "logo");
    let served = mail.serve_inline_image(&url).await;
    assert_eq!(
        (served.status, served.body.as_slice()),
        (200, &b"tiny-png"[..])
    );
    assert_eq!(
        fake.attachment_fetches(),
        0,
        "nothing to download from Gmail"
    );

    // The regular download is the second row (rows follow parse order).
    let note = rows.iter().find(|r| r.content_id.is_none()).unwrap();
    let saved = mail
        .save_attachment("a1", "m1", &note.id, &dir.dir().join("Downloads"))
        .await
        .unwrap();
    assert_eq!(saved.file_name().unwrap(), "note.txt");
    assert_eq!(std::fs::read(saved).unwrap(), b"hello");

    // Later reads come from the disk cache, not another message fetch.
    let reads = fake.calls("get_message");
    mail.inline_image("a1", "m1", "logo").await.unwrap();
    assert_eq!(fake.calls("get_message"), reads);
    assert!(dir.dir().join("cache/attachments-v1/a1/m1").is_dir());
}

#[tokio::test]
async fn a_part_with_no_bytes_anywhere_is_not_found() {
    let (_dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_embedded("e.png", "image/png", Some("e"), b""),
        &[],
    )
    .await;
    assert!(matches!(
        mail.inline_image("a1", "m1", "e").await,
        Err(MailError::NotFound)
    ));
}

#[tokio::test]
async fn a_header_unsafe_mime_type_is_a_404() {
    let (_dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_inline("l.png", "image/png", "g1", "logo"),
        &[("g1", b"png")],
    )
    .await;
    sqlx::query("UPDATE attachments SET mime_type = 'image/png\nX-Evil: 1'")
        .execute(&mail.db)
        .await
        .unwrap();
    let served = mail
        .serve_inline_image(&render::attachment_url("a1", "m1", "logo"))
        .await;
    assert_eq!(served, InlineResponse::not_found());
}

#[tokio::test]
async fn a_download_that_cannot_be_written_is_a_file_error_not_a_cache_error() {
    let (dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
        &[("g1", b"%PDF")],
    )
    .await;
    // A file where the Downloads folder should be.
    let target = dir.dir().join("Downloads");
    std::fs::write(&target, b"not a folder").unwrap();

    let error = mail
        .save_attachment("a1", "m1", "0", &target)
        .await
        .unwrap_err();

    assert_eq!(error.code(), "file");
    assert!(error
        .to_string()
        .starts_with("Pheeme couldn't save the file"));
}

#[cfg(unix)]
#[tokio::test]
async fn save_attachment_skips_a_dangling_symlink() {
    let (dir, _fake, mail) = attachment_fixture(
        FakeMsg::new("m1", "t1", &["INBOX"]).with_attachment("a.pdf", "application/pdf", "g1"),
        &[("g1", b"%PDF")],
    )
    .await;
    let target = dir.dir().join("Downloads");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(dir.dir().join("nowhere"), target.join("a.pdf")).unwrap();

    let saved = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mail.save_attachment("a1", "m1", "0", &target),
    )
    .await
    .expect("must not retry forever")
    .unwrap();

    assert_eq!(saved, target.join("a (1).pdf"));
    assert!(
        !dir.dir().join("nowhere").exists(),
        "the link was not followed"
    );
}

async fn search_setup() -> (
    tempfile::TempDir,
    MailService,
    Arc<FakeGmail>,
    Arc<FakeGmail>,
) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(dir.path(), &crate::storage::test_key())
        .await
        .unwrap();
    for id in ["a1", "a2"] {
        accounts::insert_account(
            &pool,
            &DbAccount {
                id: id.into(),
                email: format!("{id}@example.com"),
                display_name: None,
                profile_photo_url: None,
                client_id: "c".into(),
                history_id: None,
                created_at: 0,
                updated_at: 0,
                color: 1,
            },
        )
        .await
        .unwrap();
    }
    let (f1, f2) = (Arc::new(FakeGmail::new()), Arc::new(FakeGmail::new()));
    let mut m = FakeMsg::new("m1", "t1", &["INBOX", "UNREAD", "Label_9"]);
    m.subject = "Invoice for March".into();
    f1.seed(m);
    let mut old = FakeMsg::new("old", "t-old", &["Label_9"]).days_ago(2000);
    old.subject = "Ancient invoice".into();
    old.body = "zebra crossing".into();
    f1.seed(old);
    let mut sibling = FakeMsg::new("old-reply", "t-old", &[]).days_ago(1999);
    sibling.subject = "Re: something else".into();
    f1.seed(sibling);
    let mut m2 = FakeMsg::new("m2", "t2", &["INBOX"]);
    m2.subject = "Invoice from a2".into();
    f2.seed(m2);
    let apis = (f1.clone(), f2.clone());
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |id: &str| {
            if id == "a1" {
                apis.0.clone() as Arc<dyn MailApi>
            } else {
                apis.1.clone() as Arc<dyn MailApi>
            }
        }),
        Arc::new(RecordingEvents::default()),
    );
    // Initial sync only (Inbox), no backfill: `old` stays uncached.
    for id in ["a1", "a2"] {
        sync.engine(id).run_initial_sync().await.unwrap();
    }
    let mut conn = pool.acquire().await.unwrap();
    labels::upsert_label_tx(
        &mut conn,
        &labels::DbLabel {
            id: "Label_9".into(),
            account_id: "a1".into(),
            name: "Clients/Acme".into(),
            label_type: "user".into(),
            message_list_visibility: None,
            label_list_visibility: None,
            color_background: None,
            color_text: None,
            messages_total: 0,
            messages_unread: 0,
            threads_total: 0,
            threads_unread: 0,
        },
    )
    .await
    .unwrap();
    drop(conn);
    let cache_dir = dir.path().join("cache");
    (
        dir,
        MailService::new(pool, sync, cache_dir, crate::storage::test_key()),
        f1,
        f2,
    )
}

fn thread_ids(threads: &[ThreadSummaryDto]) -> Vec<&str> {
    threads.iter().map(|t| t.id.as_str()).collect()
}

#[tokio::test]
async fn search_messages_runs_gmail_syntax_locally() {
    let (_dir, mail, _, _) = search_setup().await;
    let both: Vec<String> = vec!["a1".into(), "a2".into()];
    let page = mail
        .search_messages(&both, "invoic", None, None)
        .await
        .unwrap();
    assert!(page.local);
    let mut found = thread_ids(&page.threads);
    found.sort();
    assert_eq!(
        found,
        ["t1", "t2"],
        "prefix match while typing; old isn't cached"
    );

    let page = mail
        .search_messages(&both, "invoice is:unread label:clients-acme", None, None)
        .await
        .unwrap();
    assert_eq!(thread_ids(&page.threads), ["t1"]);
    let page = mail
        .search_messages(&both, "label:no-such-label", None, None)
        .await
        .unwrap();
    assert!(page.local && page.threads.is_empty());

    let page = mail
        .search_messages(&both, "invoice OR bill", None, None)
        .await
        .unwrap();
    assert!(
        !page.local && page.threads.is_empty(),
        "OR is left to Gmail"
    );
}

#[tokio::test]
async fn mark_search_read_covers_cached_and_uncached_matches() {
    let (_dir, mail, f1, _) = search_setup().await;
    let mut lunch = FakeMsg::new("lunch", "t-lunch", &["INBOX", "UNREAD"]);
    lunch.subject = "Lunch?".into();
    f1.seed(lunch);
    mail.sync.engine("a1").run_initial_sync().await.unwrap();
    let mut unseen = FakeMsg::new("unseen", "t-unseen", &["UNREAD"]).days_ago(1500);
    unseen.subject = "Overdue invoice".into();
    f1.seed(unseen);

    let both: Vec<String> = vec!["a1".into(), "a2".into()];
    mail.mark_search_read(&both, "invoice").await.unwrap();
    let unread = mail
        .search_messages(&both, "is:unread", None, None)
        .await
        .unwrap();
    assert_eq!(
        thread_ids(&unread.threads),
        ["t-lunch"],
        "the cached match is read at once, the rest isn't touched"
    );

    // The background sync `mark_search_read` starts may already have sent the change, so look
    // at Gmail rather than the outbox; sending it again is harmless.
    outbox::process(&mail.sync.engine("a1"), now_ms())
        .await
        .unwrap();
    let labels = |id: &str| f1.message(id).unwrap().labels;
    assert!(!labels("m1").contains(&"UNREAD".to_owned()));
    assert!(
        !labels("unseen").contains(&"UNREAD".to_owned()),
        "Gmail's matches that were never downloaded too"
    );
    assert!(labels("lunch").contains(&"UNREAD".to_owned()));

    assert!(matches!(
        mail.mark_search_read(&both, "  ").await,
        Err(MailError::Invalid(_))
    ));
}

#[tokio::test]
async fn search_gmail_caches_whole_threads_it_finds() {
    let (_dir, mail, f1, f2) = search_setup().await;
    let both: Vec<String> = vec!["a1".into(), "a2".into()];
    f2.fail_next(
        "search_messages",
        crate::gmail::GmailError::Offline("x".into()),
    );

    let fetches = f1.calls("get_thread");
    let page = mail.search_gmail(&both, "ancient", None).await.unwrap();
    assert_eq!(thread_ids(&page.threads), ["t-old"]);
    assert_eq!(
        page.threads[0].message_count, 2,
        "the whole thread is cached"
    );
    assert_eq!(page.failed, ["a2"]);
    assert!(page.next.is_empty());
    assert_eq!(f1.calls("get_thread"), fetches + 1);

    // Now cached with bodies: local search finds it, and searching again fetches nothing.
    let local = mail
        .search_messages(&both, "zebra", None, None)
        .await
        .unwrap();
    assert_eq!(thread_ids(&local.threads), ["t-old"]);
    mail.search_gmail(&both, "ancient", None).await.unwrap();
    assert_eq!(f1.calls("get_thread"), fetches + 1);

    let mut trashed = FakeMsg::new("binned", "t-bin", &["TRASH"]).days_ago(3000);
    trashed.subject = "binned receipt".into();
    f1.seed(trashed);
    let page = mail.search_gmail(&both, "binned", None).await.unwrap();
    assert!(page.threads.is_empty(), "Gmail leaves Trash out by default");
    let page = mail
        .search_gmail(&both, "binned in:trash", None)
        .await
        .unwrap();
    assert_eq!(thread_ids(&page.threads), ["t-bin"]);

    f1.fail_next(
        "search_messages",
        crate::gmail::GmailError::Offline("x".into()),
    );
    f2.fail_next(
        "search_messages",
        crate::gmail::GmailError::Offline("x".into()),
    );
    assert!(
        mail.search_gmail(&both, "ancient", None).await.is_err(),
        "every account failed"
    );
    assert!(matches!(
        mail.search_gmail(&both, "  ", None).await,
        Err(MailError::Invalid(_))
    ));
}

#[tokio::test]
async fn search_gmail_pages_per_account() {
    let (_dir, mail, f1, _) = search_setup().await;
    for i in 0..60 {
        let mut m = FakeMsg::new(&format!("p{i}"), &format!("tp{i}"), &[]).days_ago(i + 1);
        m.subject = "paged result".into();
        f1.add(m);
    }
    let both: Vec<String> = vec!["a1".into(), "a2".into()];
    let first = mail.search_gmail(&both, "paged", None).await.unwrap();
    assert_eq!(first.threads.len(), 50);
    assert_eq!(first.next.keys().collect::<Vec<_>>(), ["a1"]);
    let rest = mail
        .search_gmail(&both, "paged", Some(first.next))
        .await
        .unwrap();
    assert_eq!(rest.threads.len(), 10);
    assert!(rest.next.is_empty());
}

#[tokio::test]
async fn recent_searches_trim_and_skip_blank() {
    let (_dir, mail, _, _) = search_setup().await;
    mail.add_recent_search("  from:alice  ").await.unwrap();
    mail.add_recent_search("   ").await.unwrap();
    assert_eq!(mail.recent_searches().await.unwrap(), ["from:alice"]);
}

#[test]
fn invite_part_prefers_the_calendar_part() {
    let att = |id: &str, name: Option<&str>, mime: &str, size: i64| DbAttachment {
        id: id.into(),
        message_id: "m".into(),
        account_id: "a".into(),
        filename: name.map(Into::into),
        mime_type: Some(mime.into()),
        size: Some(size),
        attachment_id: None,
        content_id: None,
        is_inline: 0,
    };
    let pdf = att("0", Some("agenda.pdf"), "application/pdf", 900);
    let file = att("1", Some("invite.ics"), "application/ics", 900);
    let part = att("2", None, "text/calendar", 900);
    assert_eq!(
        invite_part(&[pdf.clone(), file.clone(), part.clone()]).map(|a| a.id.as_str()),
        Some("2")
    );
    assert_eq!(
        invite_part(&[pdf.clone(), file]).map(|a| a.id.as_str()),
        Some("1")
    );
    let octet = att("3", Some("Meeting.ICS"), "application/octet-stream", 900);
    assert_eq!(invite_part(&[octet]).map(|a| a.id.as_str()), Some("3"));
    assert!(invite_part(&[pdf]).is_none());
    let huge = att("4", None, "text/calendar", 2 * INVITE_MAX_BYTES);
    assert!(invite_part(&[huge]).is_none());
}
