use super::*;
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
    pub api: LocalApi,
    pub caller: Caller,
    pub notified: Arc<AtomicUsize>,
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
    let mail = MailService::new(pool.clone(), sync.clone(), db.dir().join("cache"));
    let compose = ComposeService::new(
        pool.clone(),
        sync.clone(),
        mail.clone(),
        &db.dir().join("cache"),
    );
    let notified = Arc::new(AtomicUsize::new(0));
    let count = notified.clone();
    let api = LocalApi::new(pool, accounts, mail, compose, sync);
    api.on_activity(Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    api.set_enabled(true).await.unwrap();
    let new = api.connect_client("Claude Code").await.unwrap();
    let caller = api.authenticate(&new.token).await.unwrap();
    Harness {
        _db: db,
        fake,
        api,
        caller,
        notified,
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
    assert_eq!(first["account"], "me@example.com");
    assert_eq!(first["from"], "Shop <shop@x.com>");
    assert_eq!(first["unread"], true);
    assert!(first["labels"]
        .as_array()
        .unwrap()
        .contains(&json!("Receipts")));

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

    let label = h
        .call("create_label", json!({ "name": "Clients/Acme" }))
        .await
        .unwrap();
    assert_eq!(label["name"], "Clients/Acme");
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
    assert_eq!(deals["you_wrote"], 0);
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
    let caught = &filters[0]["caught"][0];
    assert_eq!(caught["thread_id"], "tb1");
    assert!(caught["labels"]
        .as_array()
        .unwrap()
        .contains(&json!("TRASH")));

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
            | Permission::Unsubscribe => 1,
        };
        assert_eq!(Permission::ALL.iter().filter(|q| **q == p).count(), listed);
    }
    assert_eq!(Permission::ALL.len(), 4);
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
