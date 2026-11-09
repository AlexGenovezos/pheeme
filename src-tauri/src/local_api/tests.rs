use super::*;
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
    let notified = Arc::new(AtomicUsize::new(0));
    let count = notified.clone();
    let api = LocalApi::new(pool, accounts, mail, sync);
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
    fake.seed(msg("m3", "t3", &["Label_1"], "Shop <shop@x.com>").days_ago(3));
    let h = setup(fake).await;

    let inbox = h.call("list_mailbox", json!({})).await.unwrap();
    let ids: Vec<_> = inbox["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["thread_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["t1", "t2"]);
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

#[test]
fn every_catalog_example_parses() {
    for tool in catalog() {
        let parsed = Request::parse(tool.name, tool.example.clone());
        assert!(parsed.is_ok(), "{}: {:?}", tool.name, parsed.err());
        assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
        assert!(!parsed.unwrap().summary().is_empty());
    }
}
