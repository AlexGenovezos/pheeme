use super::*;
use crate::calendar::fake::{calendar, FakeCalendar};
use crate::calendar::CalendarApi;
use crate::compose::ComposeService;
use crate::db::test_support::TestDb;
use crate::gmail::types::{Filter, FilterAction, FilterCriteria};
use crate::secrets::MemoryStore;
use crate::sync::events::RecordingEvents;
use crate::sync::fake::{FakeGmail, FakeMsg};
use crate::sync::MailApi;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) struct Harness {
    pub _db: TestDb,
    pub fake: Arc<FakeGmail>,
    /// Account a1's Google Calendar: primary calendar `me@example.com`, access not yet allowed.
    pub cal: Arc<FakeCalendar>,
    pub calendar: Arc<CalendarService>,
    pub api: LocalApi,
    pub caller: Caller,
    pub notified: Arc<AtomicUsize>,
    pub sync: Arc<SyncManager>,
}

pub(crate) async fn setup(fake: FakeGmail) -> Harness {
    let db = TestDb::with_account("a1").await;
    let pool = db.pool.clone();
    let fake = Arc::new(fake);
    let gmail = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| gmail.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    sync.sync_account("a1").await.unwrap();
    let accounts = Arc::new(AccountService::new(
        pool.clone(),
        Arc::new(MemoryStore::new()),
    ));
    let mail = MailService::new(
        pool.clone(),
        sync.clone(),
        db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let compose = ComposeService::new(
        pool.clone(),
        sync.clone(),
        mail.clone(),
        &db.dir().join("cache"),
        crate::storage::test_key(),
    );
    let notified = Arc::new(AtomicUsize::new(0));
    let count = notified.clone();
    let cal = Arc::new(FakeCalendar::default());
    let mut primary = calendar("me@example.com");
    primary.primary = true;
    cal.add_calendar(primary);
    let cal_api = cal.clone();
    let calendar = CalendarService::new(
        pool.clone(),
        Arc::new(move |_: &str| cal_api.clone() as Arc<dyn CalendarApi>),
        Arc::new(RecordingEvents::default()),
    );
    let api = LocalApi::new(
        pool,
        accounts,
        mail,
        compose,
        sync.clone(),
        calendar.clone(),
    );
    api.on_activity(Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    api.set_enabled(true).await.unwrap();
    let new = api.connect_client("Claude Code").await.unwrap();
    let caller = api.authenticate(&new.token).await.unwrap();
    Harness {
        _db: db,
        fake,
        cal,
        calendar,
        api,
        caller,
        notified,
        sync,
    }
}

fn msg(id: &str, thread: &str, labels: &[&str], from: &str) -> FakeMsg {
    FakeMsg {
        from: from.into(),
        ..FakeMsg::new(id, thread, labels)
    }
}

impl Harness {
    async fn call(&self, tool: &str, args: Value) -> Result<Value, ApiError> {
        self.api.call(&self.caller, tool, args).await
    }
}

#[tokio::test]
async fn tokens_authenticate_until_the_client_is_removed() {
    let h = setup(FakeGmail::new()).await;
    let new = h.api.connect_client("  Desktop  ").await.unwrap();
    assert_eq!(new.client.name, "Desktop");
    assert!(new.token.starts_with("pheeme_"));
    let caller = h.api.authenticate(&new.token).await.unwrap();
    assert_eq!(caller.client_name, "Desktop");
    assert!(matches!(
        h.api.authenticate("pheeme_wrong").await,
        Err(ApiError::Unauthorized)
    ));
    assert!(matches!(
        h.api.authenticate("").await,
        Err(ApiError::Unauthorized)
    ));
    assert!(matches!(
        h.api.connect_client("  ").await,
        Err(ApiError::Invalid(_))
    ));

    h.api.remove_client(&new.client.id).await.unwrap();
    assert!(matches!(
        h.api.authenticate(&new.token).await,
        Err(ApiError::Unauthorized)
    ));
    let names: Vec<_> = h
        .api
        .clients()
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names, ["Claude Code"]);
}

#[tokio::test]
async fn calls_are_refused_while_turned_off_and_logged_when_on() {
    let h = setup(FakeGmail::new()).await;
    h.api.set_enabled(false).await.unwrap();
    assert!(matches!(
        h.call("list_accounts", json!({})).await,
        Err(ApiError::Disabled)
    ));
    assert!(h.api.activity(10).await.unwrap().is_empty());

    h.api.set_enabled(true).await.unwrap();
    let out = h.call("list_accounts", Value::Null).await.unwrap();
    assert_eq!(out["accounts"][0]["account"], "me@example.com");
    let err = h.call("nope", json!({})).await.unwrap_err();
    assert!(matches!(err, ApiError::UnknownTool(_)));
    let err = h
        .call("list_mailbox", json!({ "mailbox": "inbox", "bogus": 1 }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("bogus"), "{err}");

    let log = h.api.activity(10).await.unwrap();
    let tools: Vec<_> = log.iter().map(|a| a.tool.as_str()).collect();
    assert_eq!(tools, ["list_mailbox", "nope", "list_accounts"]);
    assert_eq!(log[2].summary, "accounts");
    assert_eq!(log[2].client_name, "Claude Code");
    assert!(log[2].error.is_none());
    assert!(log[0].error.is_some());
    // The exact arguments are kept, even ones the tool refused.
    assert_eq!(log[0].arguments, r#"{"bogus":1,"mailbox":"inbox"}"#);
    assert_eq!(log[0].result, None);
    assert_eq!(log[2].arguments, "null");
    assert_eq!(h.notified.load(Ordering::SeqCst), 3);
    let client = &h.api.clients().await.unwrap()[0];
    assert!(client.last_used_at.is_some());
}

#[tokio::test]
async fn lists_mailboxes_with_label_names() {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Receipts", None);
    fake.seed(
        msg(
            "m1",
            "t1",
            &["INBOX", "UNREAD", "Label_1"],
            "Shop <shop@x.com>",
        )
        .days_ago(1),
    );
    fake.seed(msg("m2", "t2", &["INBOX"], "Friend <f@x.com>").days_ago(2));
    // Inbox mail only: the first sync caches the inbox, the rest arrives with the background
    // backfill, which the test doesn't wait for.
    fake.seed(msg("m3", "t3", &["INBOX", "Label_1"], "Shop <shop@x.com>").days_ago(3));
    let h = setup(fake).await;

    let inbox = h.call("list_mailbox", json!({})).await.unwrap();
    let ids: Vec<_> = inbox["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["thread_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["t1", "t2", "t3"]);
    let first = &inbox["threads"][0];
    // One account: rows don't repeat it, and flags that are off are left out.
    assert!(first.get("account").is_none(), "{first}");
    assert!(first.get("starred").is_none(), "{first}");
    assert!(first.get("messages").is_none(), "{first}");
    assert_eq!(first["from"], "Shop <shop@x.com>");
    assert_eq!(first["unread"], true);
    assert_eq!(first["labels"], json!(["inbox", "Receipts"]));

    let compact = h
        .call("list_mailbox", json!({ "compact": true }))
        .await
        .unwrap();
    let row = &compact["threads"][0];
    assert!(
        row.get("labels").is_none() && row.get("snippet").is_none(),
        "{row}"
    );

    let unread = h
        .call("list_mailbox", json!({ "unread_only": true }))
        .await
        .unwrap();
    assert_eq!(unread["threads"].as_array().unwrap().len(), 1);

    let label = h
        .call("list_mailbox", json!({ "mailbox": "receipts", "limit": 1 }))
        .await
        .unwrap();
    assert_eq!(label["threads"][0]["thread_id"], "t1");
    let cursor = label["next_cursor"].as_str().unwrap().to_owned();
    let next = h
        .call(
            "list_mailbox",
            json!({ "mailbox": "Receipts", "limit": 1, "cursor": cursor }),
        )
        .await
        .unwrap();
    assert_eq!(next["threads"][0]["thread_id"], "t3");

    // The log keeps which conversations a read returned, not the mail.
    let log = h.api.activity(10).await.unwrap();
    let read: Value = serde_json::from_str(log[0].result.as_deref().unwrap()).unwrap();
    assert_eq!(read, json!({ "thread_ids": ["t3"] }));

    let missing = h
        .call("list_mailbox", json!({ "mailbox": "Nope" }))
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("list_labels"), "{missing}");
    let wrong = h
        .call("list_mailbox", json!({ "account": "who@x.com" }))
        .await
        .unwrap_err();
    assert!(wrong.to_string().contains("me@example.com"), "{wrong}");
}

#[tokio::test]
async fn searches_the_cache_and_reads_threads_as_text() {
    let fake = FakeGmail::new();
    fake.seed(FakeMsg {
        body: "Your invoice total is $12.".into(),
        subject: "Invoice".into(),
        ..msg("m1", "t1", &["INBOX"], "Billing <bill@x.com>").days_ago(1)
    });
    fake.seed(msg("m2", "t2", &["INBOX"], "Friend <f@x.com>").days_ago(2));
    let h = setup(fake).await;

    let found = h
        .call("search_mail", json!({ "query": "from:bill@x.com" }))
        .await
        .unwrap();
    assert_eq!(found["searched"], "the mail cached on this computer");
    let ids: Vec<_> = found["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["thread_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["t1"]);

    let thread = h
        .call("get_thread", json!({ "thread_id": "t1" }))
        .await
        .unwrap();
    assert_eq!(thread["thread"]["subject"], "Invoice");
    let message = &thread["messages"][0];
    assert_eq!(message["from"], "Billing <bill@x.com>");
    assert!(message["body"]
        .as_str()
        .unwrap()
        .contains("Your invoice total is $12."));
    assert_eq!(message["body_truncated"], false);

    let short = h
        .call(
            "get_thread",
            json!({ "thread_id": "t1", "max_chars_per_message": 1 }),
        )
        .await
        .unwrap();
    assert_eq!(short["messages"][0]["body_truncated"], false);

    let missing = h
        .call("get_thread", json!({ "thread_id": "nope" }))
        .await
        .unwrap_err();
    assert!(matches!(missing, ApiError::Mail(MailError::NotFound)));
}

#[tokio::test]
async fn gmail_search_honours_the_limit_and_pages_through() {
    let fake = FakeGmail::new();
    for n in 0..5 {
        fake.seed(msg(&format!("m{n}"), &format!("t{n}"), &["INBOX"], "a@x.com").days_ago(n + 1));
    }
    let h = setup(fake).await;
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut args = json!({ "query": "subject", "gmail": true, "limit": 2 });
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let page = h.call("search_mail", args).await.unwrap();
        assert_eq!(page["searched"], "Gmail");
        assert!(page["note"].as_str().unwrap().contains("in:anywhere"));
        let threads = page["threads"].as_array().unwrap();
        assert!(threads.len() <= 2);
        seen.extend(
            threads
                .iter()
                .map(|t| t["thread_id"].as_str().unwrap().to_owned()),
        );
        match page["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_owned()),
            None => break,
        }
    }
    assert_eq!(seen, ["t0", "t1", "t2", "t3", "t4"]);
}

#[tokio::test]
async fn lists_filters_in_words() {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Receipts", None);
    fake.seed_filter(Filter {
        id: None,
        criteria: FilterCriteria {
            from: Some("deals@x.com".into()),
            ..Default::default()
        },
        action: FilterAction {
            add_label_ids: vec!["TRASH".into()],
            ..Default::default()
        },
    });
    fake.seed_filter(Filter {
        id: None,
        criteria: FilterCriteria {
            from: Some("shop@x.com".into()),
            ..Default::default()
        },
        action: FilterAction {
            add_label_ids: vec!["Label_1".into()],
            remove_label_ids: vec!["INBOX".into()],
            ..Default::default()
        },
    });
    let h = setup(fake).await;
    let out = h.call("list_filters", json!({})).await.unwrap();
    let filters = &out["accounts"][0]["filters"];
    assert_eq!(filters[0]["trashes"], true);
    assert_eq!(filters[0]["actions"][0], "delete it");
    assert_eq!(filters[1]["skips_inbox"], true);
    assert_eq!(filters[1]["add_labels"][0], "Receipts");
    assert_eq!(h.fake.calls("list_filters"), 1);
}

fn ids(out: &Value, key: &str) -> Vec<String> {
    out[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            v.as_str()
                .unwrap_or(v["thread_id"].as_str().unwrap_or(""))
                .to_owned()
        })
        .collect()
}

async fn mailbox(h: &Harness, name: &str) -> Vec<String> {
    let out = h
        .call("list_mailbox", json!({ "mailbox": name }))
        .await
        .unwrap();
    ids(&out, "threads")
}

#[tokio::test]
async fn writes_need_their_group_allowed() {
    let fake = FakeGmail::new();
    fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
    let h = setup(fake).await;
    let err = h
        .call("archive", json!({ "thread_ids": ["t1"] }))
        .await
        .unwrap_err();
    assert!(matches!(err, ApiError::NotAllowed(Permission::Organize)));
    assert!(err.to_string().contains("Organize mail"), "{err}");
    assert_eq!(mailbox(&h, "inbox").await, ["t1"]);
    assert!(h.api.activity(1).await.unwrap()[0].error.is_none());
    assert!(h.api.activity(2).await.unwrap()[1].error.is_some());

    h.api.set_allows(Permission::Organize, true).await.unwrap();
    let err = h
        .call("create_filter", json!({ "from": "a@x.com", "trash": true }))
        .await
        .unwrap_err();
    assert!(matches!(err, ApiError::NotAllowed(Permission::Filters)));
    let err = h
        .call("create_draft", json!({ "body": "hi" }))
        .await
        .unwrap_err();
    assert!(matches!(err, ApiError::NotAllowed(Permission::Drafts)));
}

#[tokio::test]
async fn organizes_mail_through_the_outbox() {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Receipts", None);
    fake.seed(msg("m1", "t1", &["INBOX", "UNREAD"], "a@x.com").days_ago(1));
    fake.seed(msg("m2", "t2", &["INBOX"], "b@x.com").days_ago(2));
    let h = setup(fake).await;
    h.api.set_allows(Permission::Organize, true).await.unwrap();

    let out = h
        .call("archive", json!({ "thread_ids": ["t1", "nope"] }))
        .await
        .unwrap();
    assert_eq!(ids(&out, "changed"), ["t1"]);
    assert_eq!(ids(&out, "not_found"), ["nope"]);
    assert_eq!(mailbox(&h, "inbox").await, ["t2"]);
    h.call("move_to_inbox", json!({ "thread_ids": ["t1"] }))
        .await
        .unwrap();
    assert_eq!(mailbox(&h, "inbox").await, ["t1", "t2"]);

    h.call("mark_read", json!({ "thread_ids": ["t1"] }))
        .await
        .unwrap();
    let unread = h
        .call("list_mailbox", json!({ "unread_only": true }))
        .await
        .unwrap();
    assert!(ids(&unread, "threads").is_empty());
    h.call("star", json!({ "thread_ids": ["t2"] }))
        .await
        .unwrap();
    assert_eq!(mailbox(&h, "starred").await, ["t2"]);

    h.call(
        "change_labels",
        json!({ "thread_ids": ["t2"], "add": ["receipts"] }),
    )
    .await
    .unwrap();
    assert_eq!(mailbox(&h, "Receipts").await, ["t2"]);
    let err = h
        .call(
            "change_labels",
            json!({ "thread_ids": ["t2"], "add": ["INBOX"] }),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("move_to_inbox"), "{err}");
    let err = h
        .call("archive", json!({ "thread_ids": ["nope"] }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("None of those"), "{err}");

    h.call("trash", json!({ "thread_ids": ["t2"] }))
        .await
        .unwrap();
    assert_eq!(mailbox(&h, "trash").await, ["t2"]);
    assert_eq!(mailbox(&h, "inbox").await, ["t1"]);
    h.call("move_to_inbox", json!({ "thread_ids": ["t2"] }))
        .await
        .unwrap();
    assert!(mailbox(&h, "trash").await.is_empty());
    assert_eq!(mailbox(&h, "inbox").await, ["t1", "t2"]);
    h.call("trash", json!({ "thread_ids": ["t2"] }))
        .await
        .unwrap();

    let label = h
        .call("create_label", json!({ "name": "Clients/Acme" }))
        .await
        .unwrap();
    assert_eq!(label["name"], "Clients/Acme");
}

#[tokio::test]
async fn labels_every_match_of_a_search_without_reading_each_conversation() {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Receipts", None);
    fake.seed(msg("m1", "t1", &["INBOX", "CATEGORY_UPDATES"], "shop@x.com").days_ago(1));
    fake.seed(msg("m2", "t2", &["INBOX", "CATEGORY_SOCIAL"], "b@x.com").days_ago(2));
    let h = setup(fake).await;
    h.api.set_allows(Permission::Organize, true).await.unwrap();
    // Old mail Pheeme hasn't downloaded is labelled too.
    h.fake
        .add(msg("old", "t3", &["CATEGORY_UPDATES"], "shop@x.com").days_ago(400));

    let reads = h.fake.calls("get_thread");
    let out = h
        .call(
            "change_labels",
            json!({ "query": "category:updates", "add": ["receipts"] }),
        )
        .await
        .unwrap();
    assert_eq!(out["query"], "category:updates");
    h.sync.sync_account("a1").await.unwrap();

    let labels = |id: &str| h.fake.message(id).unwrap().labels;
    assert!(labels("m1").contains(&"Label_1".to_string()));
    assert!(labels("old").contains(&"Label_1".to_string()));
    assert!(!labels("m2").contains(&"Label_1".to_string()));
    assert_eq!(
        h.fake.calls("get_thread"),
        reads,
        "no per-conversation reads"
    );
    assert_eq!(mailbox(&h, "Receipts").await, ["t1", "t3"]);

    let err = h
        .call(
            "change_labels",
            json!({ "query": "x", "thread_ids": ["t1"], "add": ["receipts"] }),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("thread_ids or query"), "{err}");
}

#[tokio::test]
async fn creates_and_deletes_filters() {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Receipts", None);
    let h = setup(fake).await;
    h.api.set_allows(Permission::Filters, true).await.unwrap();

    let out = h
        .call(
            "create_filter",
            json!({
                "from": "shop@x.com", "subject": "Order", "add_label": "Receipts",
                "category": "updates", "skip_inbox": true, "mark_read": true, "important": false
            }),
        )
        .await
        .unwrap();
    let held = h.fake.filters();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].criteria.from.as_deref(), Some("shop@x.com"));
    assert_eq!(held[0].criteria.other["subject"], "Order");
    assert_eq!(
        held[0].action.add_label_ids,
        ["Label_1", "CATEGORY_UPDATES"]
    );
    assert_eq!(
        held[0].action.remove_label_ids,
        ["INBOX", "UNREAD", "IMPORTANT"]
    );
    assert_eq!(out["filter"]["add_labels"][0], "Receipts");

    for bad in [
        json!({ "skip_inbox": true }),
        json!({ "from": "a@x.com" }),
        json!({ "from": "a@x.com", "add_label": "Nope" }),
        json!({ "from": "a@x.com", "category": "spam" }),
    ] {
        assert!(h.call("create_filter", bad.clone()).await.is_err(), "{bad}");
    }
    assert_eq!(h.fake.filters().len(), 1);

    let id = out["filter"]["id"].as_str().unwrap().to_owned();
    let err = h
        .call("delete_filter", json!({ "filter_id": "nope" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no filter"), "{err}");
    h.call("delete_filter", json!({ "filter_id": id }))
        .await
        .unwrap();
    assert!(h.fake.filters().is_empty());
}

#[tokio::test]
async fn writes_new_drafts_and_replies_but_never_sends() {
    let fake = FakeGmail::new();
    fake.seed(FakeMsg {
        subject: "Lunch?".into(),
        ..msg("m1", "t1", &["INBOX"], "Friend <f@x.com>").days_ago(1)
    });
    let h = setup(fake).await;
    h.api.set_allows(Permission::Drafts, true).await.unwrap();

    let out = h
        .call(
            "create_draft",
            json!({ "to": ["Ann <ann@x.com>"], "subject": "Hello", "body": "Line one\nLine two" }),
        )
        .await
        .unwrap();
    let draft_id = out["draft_id"].as_str().unwrap();
    let message = h.fake.drafts()[draft_id].clone();
    let raw = String::from_utf8_lossy(h.fake.message(&message).unwrap().raw.as_deref().unwrap())
        .into_owned();
    assert!(raw.contains("ann@x.com"), "{raw}");
    assert!(raw.contains("Subject: Hello"), "{raw}");

    let reply = h
        .call(
            "create_draft",
            json!({ "reply_to_message_id": "m1", "body": "Yes!" }),
        )
        .await
        .unwrap();
    assert_eq!(reply["thread_id"], "t1");
    let message = h.fake.drafts()[reply["draft_id"].as_str().unwrap()].clone();
    let raw = String::from_utf8_lossy(h.fake.message(&message).unwrap().raw.as_deref().unwrap())
        .into_owned();
    assert!(raw.contains("f@x.com"), "{raw}");
    assert!(raw.contains("Re: Lunch?"), "{raw}");

    let err = h
        .call(
            "create_draft",
            json!({ "to": ["not an address"], "body": "x" }),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("isn't an email address"), "{err}");
    assert!(h.fake.sent().is_empty());
}

#[tokio::test]
async fn reports_the_heaviest_senders() {
    let fake = FakeGmail::new();
    for n in 0..3 {
        fake.seed(
            msg(
                &format!("d{n}"),
                &format!("td{n}"),
                &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
                "Deals <DEALS@shop.com>",
            )
            .days_ago(n + 1),
        );
    }
    // Initial sync caches the inbox; other mail arrives with the background backfill, so the
    // test sticks to inbox mail.
    fake.seed(msg("b1", "tb1", &["INBOX", "UNREAD"], "alerts@bank.com").days_ago(2));
    fake.seed(msg("b2", "tb2", &["INBOX"], "alerts@bank.com").days_ago(3));
    fake.seed(msg("old", "told", &["INBOX"], "old@x.com").days_ago(200));
    fake.seed(msg("me", "tme", &["SENT"], "me@example.com").days_ago(1));
    let h = setup(fake).await;

    let out = h
        .call("sender_report", json!({ "days": 90 }))
        .await
        .unwrap();
    let senders = out["accounts"][0]["senders"].as_array().unwrap();
    let names: Vec<_> = senders
        .iter()
        .map(|s| s["sender"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["deals@shop.com", "alerts@bank.com"]);
    let deals = &senders[0];
    assert_eq!(deals["messages"], 3);
    assert_eq!(deals["unread"], 3);
    assert_eq!(deals["in_inbox"], 3);
    assert_eq!(deals["tab"], "promotions");
    // Counts of 0 are left out.
    assert!(deals.get("you_wrote").is_none(), "{deals}");
    assert_eq!(deals["thread_id"], "td0");
    assert!(deals["last_date"].is_string());
    let bank = &senders[1];
    assert_eq!(bank["messages"], 2);
    assert_eq!(bank["unread"], 1);
    assert_eq!(bank["tab"], "primary");
    // The log names the senders a report returned, not just the conversations.
    let logged = h.api.activity(1).await.unwrap()[0].result.clone().unwrap();
    assert!(
        logged.contains(r#""senders":["deals@shop.com","alerts@bank.com"]"#),
        "{logged}"
    );

    let one = h
        .call("sender_report", json!({ "limit": 1 }))
        .await
        .unwrap();
    assert_eq!(one["accounts"][0]["senders"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn audits_what_filters_caught() {
    let fake = FakeGmail::new();
    fake.seed(msg("b1", "tb1", &["TRASH"], "alerts@bank.com").days_ago(2));
    fake.seed(msg("b2", "tb2", &[], "alerts@bank.com").days_ago(3));
    for (from, add, remove) in [
        ("alerts@bank.com", vec!["TRASH"], vec![]),
        ("news@x.com", vec!["STARRED"], vec![]),
    ] {
        fake.seed_filter(Filter {
            id: None,
            criteria: FilterCriteria {
                from: Some(from.into()),
                ..Default::default()
            },
            action: FilterAction {
                add_label_ids: add.into_iter().map(String::from).collect(),
                remove_label_ids: remove,
                ..Default::default()
            },
        });
    }
    let h = setup(fake).await;
    let out = h.call("filter_audit", json!({ "days": 7 })).await.unwrap();
    let filters = out["accounts"][0]["filters"].as_array().unwrap();
    assert_eq!(
        filters.len(),
        1,
        "only the filter that deletes: {filters:?}"
    );
    assert_eq!(
        filters[0]["gmail_query"],
        "from:(alerts@bank.com) in:anywhere newer_than:7d"
    );
    assert_eq!(filters[0]["matched"], 2);
    assert_eq!(filters[0]["more"], false);
    assert_eq!(filters[0]["now_in"], json!({ "archived": 1, "trash": 1 }));
    let caught = &filters[0]["caught"][0];
    assert_eq!(caught["thread_id"], "tb1");
    assert!(caught["labels"]
        .as_array()
        .unwrap()
        .contains(&json!("trash")));
    assert!(
        filters[0].get("worth_checking").is_none(),
        "nothing that looks wanted: {:?}",
        filters[0]
    );

    let compact = h
        .call(
            "filter_audit",
            json!({ "days": 7, "sample": 1, "compact": true }),
        )
        .await
        .unwrap();
    let caught = compact["accounts"][0]["filters"][0]["caught"]
        .as_array()
        .unwrap();
    assert_eq!(caught.len(), 1);
    assert!(caught[0].get("labels").is_none() && caught[0].get("snippet").is_none());

    let all = h
        .call("filter_audit", json!({ "all": true }))
        .await
        .unwrap();
    assert_eq!(all["accounts"][0]["filters"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn unsubscribes_only_when_allowed_and_only_to_public_https() {
    let raw = |id: &str, unsubscribe: &str, post: bool| {
        format!(
            "From: List <{id}@news.com>\r\nTo: me@example.com\r\nSubject: News {id}\r\n\
             Message-ID: <{id}@news.com>\r\nDate: Mon, 2 Nov 2026 10:00:00 +0000\r\n\
             List-Unsubscribe: {unsubscribe}\r\n{}\r\nHello\r\n",
            if post {
                "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"
            } else {
                ""
            }
        )
    };
    let fake = FakeGmail::new();
    fake.seed(FakeMsg::from_raw(
        "n1",
        "t1",
        &["INBOX"],
        raw(
            "n1",
            "<https://news.com/u?x=1>, <mailto:leave@news.com>",
            false,
        )
        .as_bytes(),
    ));
    fake.seed(FakeMsg::from_raw(
        "n2",
        "t2",
        &["INBOX"],
        raw("n2", "<https://10.0.0.1/u>", true).as_bytes(),
    ));
    let h = setup(fake).await;

    let err = h
        .call("unsubscribe", json!({ "thread_id": "t1" }))
        .await
        .unwrap_err();
    assert!(matches!(err, ApiError::NotAllowed(Permission::Unsubscribe)));
    h.api
        .set_allows(Permission::Unsubscribe, true)
        .await
        .unwrap();

    let out = h
        .call("unsubscribe", json!({ "thread_id": "t1" }))
        .await
        .unwrap();
    assert_eq!(out["unsubscribed"], false);
    assert_eq!(out["web"], "https://news.com/u?x=1");
    assert_eq!(out["mailto"], "mailto:leave@news.com");
    assert_eq!(out["sender"], "n1@news.com");

    let err = h
        .call("unsubscribe", json!({ "thread_id": "t2" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("public site"), "{err}");

    let report = h.call("sender_report", json!({})).await.unwrap();
    let kind = |sender: &str| {
        report["accounts"][0]["senders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sender"] == sender)
            .unwrap()["unsubscribe"]
            .clone()
    };
    assert_eq!(kind("n1@news.com"), "link");
    assert_eq!(kind("n2@news.com"), "one_click");
}

#[test]
fn every_permission_is_listed_once() {
    // A new group missing from `ALL` would never show as allowed in Settings.
    for p in Permission::ALL {
        let listed = match p {
            Permission::Organize
            | Permission::Filters
            | Permission::Drafts
            | Permission::Unsubscribe
            | Permission::Calendar => 1,
        };
        assert_eq!(Permission::ALL.iter().filter(|q| **q == p).count(), listed);
    }
    assert_eq!(Permission::ALL.len(), 5);
}

#[test]
fn every_catalog_example_parses() {
    for tool in catalog() {
        let parsed = Request::parse(tool.name, tool.example.clone());
        assert!(parsed.is_ok(), "{}: {:?}", tool.name, parsed.err());
        assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
        let parsed = parsed.unwrap();
        assert!(!parsed.summary().is_empty());
        assert_eq!(
            parsed.permission().is_none(),
            tool.read_only,
            "{}",
            tool.name
        );
    }
}

/// Unread Promotions from two senders, one of them twice, plus a read one and an inbox one.
fn promotions() -> FakeGmail {
    let fake = FakeGmail::new();
    fake.add_user_label("Label_1", "Deals", None);
    for (n, from) in [
        "Shop <deals@shop.com>",
        "Shop <deals@shop.com>",
        "News <news@paper.com>",
    ]
    .iter()
    .enumerate()
    {
        fake.seed(FakeMsg {
            body: "Big sale today".into(),
            ..msg(
                &format!("p{n}"),
                &format!("tp{n}"),
                &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS", "Label_1"],
                from,
            )
            .days_ago(n as i64 + 1)
        });
    }
    fake.seed(
        msg(
            "r1",
            "tr1",
            &["INBOX", "CATEGORY_PROMOTIONS"],
            "Shop <deals@shop.com>",
        )
        .days_ago(5),
    );
    fake.seed(msg("i1", "ti1", &["INBOX", "UNREAD"], "Friend <f@x.com>").days_ago(1));
    fake
}

#[tokio::test]
async fn counts_and_groups_mail_in_one_call() {
    let h = setup(promotions()).await;

    let out = h
        .call(
            "count_mail",
            json!({ "mailbox": "promotions", "unread_only": true, "group_by": "sender" }),
        )
        .await
        .unwrap();
    assert_eq!(out["conversations"], 3);
    assert_eq!(out["unread"], 3);
    assert_eq!(
        out["groups"],
        json!([
            { "group": "deals@shop.com", "name": "Shop", "conversations": 2, "unread": 2 },
            { "group": "news@paper.com", "name": "News", "conversations": 1, "unread": 1 },
        ])
    );
    // The log keeps the groups a count returned.
    let logged = h.api.activity(1).await.unwrap()[0].result.clone().unwrap();
    assert!(logged.contains("deals@shop.com"), "{logged}");

    let all = h
        .call(
            "count_mail",
            json!({ "mailbox": "promotions", "group_by": "domain", "limit": 1 }),
        )
        .await
        .unwrap();
    assert_eq!(all["conversations"], 4);
    assert_eq!(all["unread"], 3);
    assert_eq!(all["groups"][0]["group"], "shop.com");
    assert_eq!(all["groups"][0]["conversations"], 3);
    assert_eq!(all["more_groups"], 1);

    let tabs = h
        .call("count_mail", json!({ "group_by": "tab" }))
        .await
        .unwrap();
    assert_eq!(
        tabs["groups"],
        json!([
            { "group": "promotions", "conversations": 4, "unread": 3 },
            { "group": "primary", "conversations": 1, "unread": 1 },
        ])
    );

    let labels = h
        .call(
            "count_mail",
            json!({ "query": "sale", "group_by": "label" }),
        )
        .await
        .unwrap();
    let groups: Vec<_> = labels["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["group"].as_str().unwrap(),
                g["conversations"].as_i64().unwrap(),
            )
        })
        .collect();
    assert!(groups.contains(&("Deals", 3)), "{groups:?}");
    assert!(groups.contains(&("promotions", 3)), "{groups:?}");

    let months = h
        .call(
            "count_mail",
            json!({ "query": "is:unread", "group_by": "month" }),
        )
        .await
        .unwrap();
    assert_eq!(months["conversations"], 4);
    assert_eq!(months["groups"][0]["group"].as_str().unwrap().len(), 7);

    for bad in [
        json!({ "query": "sale", "mailbox": "inbox" }),
        json!({ "group_by": "colour" }),
        json!({ "query": "sale OR deal" }),
    ] {
        assert!(h.call("count_mail", bad.clone()).await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn changes_every_match_of_a_search_with_a_dry_run_first() {
    let fake = promotions();
    let h = setup(fake).await;
    h.api.set_allows(Permission::Organize, true).await.unwrap();
    // Old promotional mail Pheeme hasn't downloaded changes on Gmail too.
    h.fake.add(FakeMsg {
        body: "Big sale today".into(),
        ..msg(
            "old",
            "told",
            &["UNREAD", "CATEGORY_PROMOTIONS"],
            "deals@shop.com",
        )
        .days_ago(400)
    });
    let query = "sale category:promotions";

    let dry = h
        .call("mark_read", json!({ "query": query, "dry_run": true }))
        .await
        .unwrap();
    // The three unread promotions, and the old one too if the background backfill has
    // cached it by now.
    let cached = dry["cached_conversations"].as_i64().unwrap();
    assert!((3..=4).contains(&cached), "{dry}");
    assert_eq!(dry["dry_run"], true);
    assert_eq!(dry["gmail_query"], "(sale category:promotions) is:unread");
    let unread = || async {
        h.call(
            "count_mail",
            json!({ "mailbox": "promotions", "unread_only": true }),
        )
        .await
        .unwrap()["conversations"]
            .clone()
    };
    assert_eq!(unread().await, 3, "a dry run changes nothing");

    let reads = h.fake.calls("get_thread");
    let done = h
        .call("mark_read", json!({ "query": query }))
        .await
        .unwrap();
    assert!(
        done["cached_conversations"].as_i64().unwrap() >= 3,
        "{done}"
    );
    assert_eq!(unread().await, 0, "cached matches change at once");
    let labels = |id: &str| h.fake.message(id).unwrap().labels;
    h.sync.sync_account("a1").await.unwrap();
    for id in ["p0", "p1", "p2", "old"] {
        assert!(!labels(id).contains(&"UNREAD".to_string()), "{id}");
    }
    assert!(
        labels("i1").contains(&"UNREAD".to_string()),
        "outside the search"
    );
    assert_eq!(
        h.fake.calls("get_thread"),
        reads,
        "no per-conversation reads"
    );

    let archived = h
        .call("archive", json!({ "query": "from:news@paper.com" }))
        .await
        .unwrap();
    assert_eq!(archived["cached_conversations"], 1);
    assert_eq!(mailbox(&h, "promotions").await, ["tp0", "tp1", "tr1"]);

    for (tool, args, says) in [
        ("trash", json!({ "query": "sale" }), "takes thread_ids"),
        (
            "move_to_inbox",
            json!({ "query": "sale" }),
            "takes thread_ids",
        ),
        (
            "mark_read",
            json!({ "thread_ids": ["tp0"], "dry_run": true }),
            "dry_run goes with query",
        ),
        (
            "star",
            json!({ "thread_ids": ["tp0"], "query": "sale" }),
            "either thread_ids or query",
        ),
    ] {
        let err = h.call(tool, args).await.unwrap_err();
        assert!(err.to_string().contains(says), "{tool}: {err}");
    }
}

#[tokio::test]
async fn long_pages_stop_early_and_page_on() {
    let fake = FakeGmail::new();
    for n in 0..40 {
        fake.seed(FakeMsg {
            subject: "x".repeat(2_000),
            ..msg(&format!("m{n}"), &format!("t{n:02}"), &["INBOX"], "a@x.com").days_ago(n + 1)
        });
    }
    let h = setup(fake).await;
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut args = json!({ "limit": 100 });
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let page = h.call("list_mailbox", args).await.unwrap();
        assert!(page.to_string().len() < 70_000, "a page stays small");
        seen.extend(ids(&page, "threads"));
        pages += 1;
        match page["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_owned()),
            None => break,
        }
    }
    assert!(pages > 1, "40 rows of 2,000 characters don't fit one page");
    let want: Vec<String> = (0..40).map(|n| format!("t{n:02}")).collect();
    assert_eq!(seen, want);
}

#[tokio::test]
async fn sender_report_filters_by_tab_and_sorts_by_unread() {
    let fake = FakeGmail::new();
    for n in 0..3 {
        fake.seed(
            msg(
                &format!("b{n}"),
                &format!("tb{n}"),
                &["INBOX"],
                "bank@x.com",
            )
            .days_ago(n + 1),
        );
    }
    for n in 0..2 {
        fake.seed(
            msg(
                &format!("d{n}"),
                &format!("td{n}"),
                &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
                "deals@x.com",
            )
            .days_ago(n + 1),
        );
    }
    let h = setup(fake).await;
    let senders = |out: Value| -> Vec<String> {
        out["accounts"][0]["senders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["sender"].as_str().unwrap().to_owned())
            .collect()
    };
    let most = h.call("sender_report", json!({})).await.unwrap();
    assert_eq!(senders(most), ["bank@x.com", "deals@x.com"]);
    let unread = h
        .call("sender_report", json!({ "sort_by": "unread" }))
        .await
        .unwrap();
    assert_eq!(senders(unread), ["deals@x.com", "bank@x.com"]);
    let promos = h
        .call("sender_report", json!({ "tab": "promotions" }))
        .await
        .unwrap();
    assert_eq!(senders(promos), ["deals@x.com"]);
    let primary = h
        .call("sender_report", json!({ "tab": "primary" }))
        .await
        .unwrap();
    assert_eq!(senders(primary), ["bank@x.com"]);
    assert!(h
        .call("sender_report", json!({ "sort_by": "date" }))
        .await
        .is_err());
}

#[tokio::test]
async fn a_hidden_tab_counts_as_primary() {
    let h = setup(promotions()).await;
    h.api
        .mail
        .set_inbox_tabs("a1", &["CATEGORY_PROMOTIONS".to_owned()])
        .await
        .unwrap();
    let tabs = h
        .call("count_mail", json!({ "group_by": "tab" }))
        .await
        .unwrap();
    assert_eq!(
        tabs["groups"],
        json!([{ "group": "primary", "conversations": 5, "unread": 4 }])
    );
    let primary = h
        .call("sender_report", json!({ "tab": "primary" }))
        .await
        .unwrap();
    let senders: Vec<_> = primary["accounts"][0]["senders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sender"].as_str().unwrap())
        .collect();
    assert_eq!(senders, ["deals@shop.com", "f@x.com", "news@paper.com"]);
}

#[tokio::test]
async fn query_writes_stay_out_of_spam_and_trash_and_preview_only_real_changes() {
    let h = setup(promotions()).await;
    h.api.set_allows(Permission::Organize, true).await.unwrap();
    for query in [
        "in:trash sale",
        "sale in:anywhere",
        "label:spam",
        "+in:trash",
        "+label:spam sale",
    ] {
        let err = h.call("star", json!({ "query": query })).await.unwrap_err();
        assert!(err.to_string().contains("Spam or Trash"), "{query}: {err}");
    }
    // Every promotion but one is unread already: only that one would change.
    let dry = h
        .call(
            "mark_unread",
            json!({ "query": "category:promotions", "dry_run": true }),
        )
        .await
        .unwrap();
    assert_eq!(dry["cached_conversations"], 1, "{dry}");
}

const CAL: &str = "me@example.com";

/// Account a1's calendar, synced, in New York time: lunch (busy), a declined review and a
/// focus block marked free on Monday 2 Dec 2030, and an invitation the user hasn't answered.
async fn with_calendar() -> Harness {
    use crate::calendar::fake::timed;
    use crate::gmail::calendar::CalendarSettings;
    let h = setup(FakeGmail::new()).await;
    h.cal.set_settings(CalendarSettings {
        time_zone: Some("America/New_York".into()),
        week_start: Some(1),
    });
    let mut lunch = timed(
        "lunch",
        "Lunch with Sam",
        "2030-12-02T12:00:00-05:00",
        "2030-12-02T13:00:00-05:00",
    );
    lunch["location"] = json!("Joe's");
    lunch["attendees"] = json!([
        {"email": "me@example.com", "self": true, "organizer": true, "responseStatus": "accepted"},
        {"email": "sam@example.com", "responseStatus": "accepted"}
    ]);
    lunch["organizer"] = json!({"email": "me@example.com", "self": true});
    h.cal.put(CAL, lunch);
    let mut review = timed(
        "review",
        "Review",
        "2030-12-02T14:00:00-05:00",
        "2030-12-02T15:00:00-05:00",
    );
    review["organizer"] = json!({"email": "boss@example.com"});
    review["attendees"] = json!([
        {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
        {"email": "me@example.com", "self": true, "responseStatus": "declined"}
    ]);
    h.cal.put(CAL, review);
    let mut focus = timed(
        "focus",
        "Focus",
        "2030-12-02T09:00:00-05:00",
        "2030-12-02T11:00:00-05:00",
    );
    focus["transparency"] = json!("transparent");
    h.cal.put(CAL, focus);
    let mut invite = timed(
        "invite",
        "Planning",
        "2030-12-03T10:00:00-05:00",
        "2030-12-03T11:00:00-05:00",
    );
    invite["organizer"] = json!({"email": "boss@example.com"});
    invite["attendees"] = json!([
        {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
        {"email": "me@example.com", "self": true, "responseStatus": "needsAction"}
    ]);
    h.cal.put(CAL, invite);
    h.calendar.sync_now("a1").await.unwrap();
    h
}

#[tokio::test]
async fn calendar_reads_say_when_access_isnt_allowed() {
    let h = setup(FakeGmail::new()).await;
    let out = h.call("list_calendars", json!({})).await.unwrap();
    assert_eq!(out["accounts"][0]["access"], "unknown");
    assert!(out["accounts"][0]["note"]
        .as_str()
        .unwrap()
        .contains("opening Calendar in Pheeme"));
    let out = h.call("list_events", json!({})).await.unwrap();
    assert_eq!(out["events"], json!([]));
    assert_eq!(out["calendar_access"][0]["account"], "me@example.com");
    let err = h
        .call("get_event", json!({ "event_id": "lunch" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("calendar access"), "{err}");
}

#[tokio::test]
async fn lists_and_reads_events_in_the_calendar_time_zone() {
    let h = with_calendar().await;
    let cals = h.call("list_calendars", json!({})).await.unwrap();
    assert_eq!(cals["accounts"][0]["time_zone"], "America/New_York");
    assert_eq!(cals["accounts"][0]["calendars"][0]["calendar_id"], CAL);
    assert_eq!(cals["accounts"][0]["calendars"][0]["primary"], true);

    let out = h
        .call(
            "list_events",
            json!({ "from": "2030-12-02", "to": "2030-12-03" }),
        )
        .await
        .unwrap();
    assert_eq!(out["time_zone"], "America/New_York");
    let ids: Vec<_> = out["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["focus", "lunch", "review", "invite"]);
    let lunch = &out["events"][1];
    assert_eq!(lunch["start"], "2030-12-02T12:00:00-05:00");
    assert_eq!(lunch["location"], "Joe's");
    assert_eq!(lunch["calendar_id"], CAL);
    assert_eq!(out["events"][0]["shows_as_free"], true);
    assert!(out.get("calendar_access").is_none());

    let found = h
        .call(
            "list_events",
            json!({ "from": "2030-12-01", "query": "sam" }),
        )
        .await
        .unwrap();
    assert_eq!(found["events"].as_array().unwrap().len(), 1);
    let paris = h
        .call(
            "list_events",
            json!({ "from": "2030-12-02", "limit": 1, "time_zone": "Europe/Paris" }),
        )
        .await
        .unwrap();
    assert_eq!(paris["events"][0]["start"], "2030-12-02T15:00:00+01:00");
    assert!(paris["more"].as_str().unwrap().starts_with("3 more"));

    let lunch = h
        .call("get_event", json!({ "event_id": "lunch" }))
        .await
        .unwrap();
    assert_eq!(lunch["title"], "Lunch with Sam");
    assert_eq!(lunch["guests"][1]["email"], "sam@example.com");
    assert_eq!(lunch["guests"][0]["is_me"], true);
    assert_eq!(lunch["can_edit"], true);
    let invite = h
        .call("get_event", json!({ "event_id": "invite" }))
        .await
        .unwrap();
    assert_eq!(invite["my_response"], "needsAction");
    assert_eq!(invite["can_answer"], true);
    assert_eq!(invite["can_edit"], false);
}

#[tokio::test]
async fn free_time_skips_busy_events_but_not_declined_or_free_ones() {
    let h = with_calendar().await;
    let out = h
        .call(
            "find_free_time",
            json!({ "from": "2030-12-02", "to": "2030-12-02", "duration_minutes": 60 }),
        )
        .await
        .unwrap();
    let slots: Vec<(&str, &str)> = out["slots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["start"].as_str().unwrap(), s["end"].as_str().unwrap()))
        .collect();
    assert_eq!(
        slots,
        [
            ("2030-12-02T09:00:00-05:00", "2030-12-02T12:00:00-05:00"),
            ("2030-12-02T13:00:00-05:00", "2030-12-02T17:00:00-05:00"),
        ]
    );
    assert_eq!(out["busy_periods"], 1);
}

#[tokio::test]
async fn calendar_changes_need_their_switch() {
    let h = with_calendar().await;
    let err = h
        .call(
            "create_event",
            json!({ "title": "Gym", "start": "2030-12-04T07:00" }),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ApiError::NotAllowed(Permission::Calendar)));
    assert!(err.to_string().contains("Change calendar"), "{err}");
    assert!(h.cal.writes().is_empty());
}

#[tokio::test]
async fn creates_events_with_guests_without_emailing_them() {
    let h = with_calendar().await;
    h.api.set_allows(Permission::Calendar, true).await.unwrap();
    let out = h
        .call(
            "create_event",
            json!({
                "title": "Coffee",
                "start": "2030-12-04T09:30",
                "guests": ["kim@example.com"],
                "add_meet": true,
            }),
        )
        .await
        .unwrap();
    let w = &h.cal.writes()[0];
    assert_eq!(w.method, "insert");
    assert_eq!(w.calendar_id, CAL);
    assert_eq!(
        w.send_updates,
        Some(crate::gmail::calendar::SendUpdates::None)
    );
    assert!(w.conference);
    assert_eq!(w.body["summary"], "Coffee");
    assert_eq!(w.body["start"]["dateTime"], "2030-12-04T09:30:00-05:00");
    assert_eq!(w.body["end"]["dateTime"], "2030-12-04T10:30:00-05:00");
    assert_eq!(w.body["attendees"][0]["email"], "kim@example.com");
    assert_eq!(out["guests_emailed"], false);
    assert_eq!(out["created"]["title"], "Coffee");
    assert_eq!(out["created"]["guests"], json!(["kim@example.com"]));

    // An all-day event lasts a day unless told otherwise.
    h.call(
        "create_event",
        json!({ "title": "Off", "start": "2030-12-24", "notify_guests": true }),
    )
    .await
    .unwrap();
    let w = &h.cal.writes()[1];
    assert_eq!(w.body["start"]["date"], "2030-12-24");
    assert_eq!(w.body["end"]["date"], "2030-12-25");
    assert_eq!(
        w.send_updates,
        Some(crate::gmail::calendar::SendUpdates::All)
    );
}

#[tokio::test]
async fn updates_move_events_and_change_guests() {
    let h = with_calendar().await;
    h.api.set_allows(Permission::Calendar, true).await.unwrap();
    let out = h
        .call(
            "update_event",
            json!({
                "event_id": "lunch",
                "start": "2030-12-02T12:30",
                "add_guests": ["kim@example.com"],
                "remove_guests": ["SAM@example.com"],
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["changed"], json!(["time", "guests"]));
    let w = &h.cal.writes()[0];
    assert_eq!(w.method, "patch");
    assert_eq!(w.event_id.as_deref(), Some("lunch"));
    // The length is kept.
    assert_eq!(w.body["end"]["dateTime"], "2030-12-02T13:30:00-05:00");
    let guests: Vec<_> = w.body["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["email"].as_str().unwrap())
        .collect();
    assert_eq!(guests, ["me@example.com", "kim@example.com"]);
    assert!(h
        .call("update_event", json!({ "event_id": "lunch" }))
        .await
        .unwrap_err()
        .to_string()
        .contains("Nothing to change"));
    // Only the organizer changes an invitation.
    let err = h
        .call(
            "update_event",
            json!({ "event_id": "invite", "title": "Mine" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "read_only");
}

#[tokio::test]
async fn answers_invitations_and_deletes_events() {
    let h = with_calendar().await;
    h.api.set_allows(Permission::Calendar, true).await.unwrap();
    let out = h
        .call(
            "respond_to_event",
            json!({ "event_id": "invite", "response": "maybe", "comment": "Running late" }),
        )
        .await
        .unwrap();
    assert_eq!(out["response"], "tentative");
    let me = h.cal.event(CAL, "invite").unwrap()["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["self"] == true)
        .cloned()
        .unwrap();
    assert_eq!(me["responseStatus"], "tentative");
    assert_eq!(me["comment"], "Running late");

    let out = h
        .call("delete_event", json!({ "event_id": "lunch" }))
        .await
        .unwrap();
    assert_eq!(out["deleted"]["title"], "Lunch with Sam");
    let w = h.cal.writes().pop().unwrap();
    assert_eq!(w.method, "delete");
    assert_eq!(
        w.send_updates,
        Some(crate::gmail::calendar::SendUpdates::None)
    );
    let left = h
        .call(
            "list_events",
            json!({ "from": "2030-12-02", "to": "2030-12-02" }),
        )
        .await
        .unwrap();
    assert!(left["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["event_id"] != "lunch"));
}
