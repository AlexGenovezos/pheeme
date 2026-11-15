use super::*;
use crate::db::messages::{upsert_message, DbMessage};
use crate::db::test_support::TestDb;
use crate::gmail::people::Person;
use serde_json::json;
use std::collections::VecDeque;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn message(
    id: &str,
    labels: &[&str],
    from: (&str, Option<&str>),
    to: &[(&str, Option<&str>)],
    date: i64,
) -> DbMessage {
    let addresses = |list: &[(&str, Option<&str>)]| {
        json!(list
            .iter()
            .map(|(address, name)| json!({"name": name, "address": address}))
            .collect::<Vec<_>>())
        .to_string()
    };
    DbMessage {
        id: id.into(),
        account_id: "a1".into(),
        thread_id: id.into(),
        label_ids: Some(json!(labels).to_string()),
        from_address: Some(from.0.into()),
        from_name: from.1.map(str::to_owned),
        to_addresses: Some(addresses(to)),
        cc_addresses: Some("[]".into()),
        subject: None,
        snippet: None,
        body_html: None,
        body_text: None,
        date: Some(date),
        size_estimate: None,
        has_attachment: 0,
        is_read: 1,
        is_starred: 0,
        raw_headers: None,
        fully_fetched: 0,
        rfc822_message_id: None,
    }
}

const ME: (&str, Option<&str>) = ("me@example.com", Some("Me"));

async fn contact(db: &SqlitePool, address: &str) -> Option<(Option<String>, i64, i64, i64, i64)> {
    sqlx::query_as(
        "SELECT name, sent_count, received_count, last_sent, last_received FROM contacts
         WHERE account_id = 'a1' AND address = ?",
    )
    .bind(address)
    .fetch_optional(db)
    .await
    .unwrap()
}

/// Answers each list from a queue of pages (or errors), then empty pages.
#[derive(Default)]
struct FakePeople {
    saved: Mutex<VecDeque<Result<PeoplePage, GmailError>>>,
    other: Mutex<VecDeque<Result<PeoplePage, GmailError>>>,
    calls: Mutex<Vec<(ContactList, Option<String>)>>,
    creates: Mutex<Vec<(String, Option<String>)>>,
}

#[async_trait::async_trait]
impl PeopleApi for FakePeople {
    async fn create_contact(&self, address: &str, name: Option<&str>) -> Result<(), GmailError> {
        lock(&self.creates).push((address.to_owned(), name.map(str::to_owned)));
        Ok(())
    }
    async fn list_people(
        &self,
        list: ContactList,
        page_token: Option<&str>,
    ) -> Result<PeoplePage, GmailError> {
        lock(&self.calls).push((list, page_token.map(str::to_owned)));
        let queue = match list {
            ContactList::Saved => &self.saved,
            ContactList::Other => &self.other,
        };
        lock(queue)
            .pop_front()
            .unwrap_or_else(|| Ok(PeoplePage::default()))
    }
}

#[tokio::test]
async fn saving_a_person_is_confirmed_cached_and_serialized_against_duplicate_clicks() {
    let db = TestDb::with_account("a1").await;
    let fake = Arc::new(FakePeople::default());
    let svc = service(&db.pool, fake.clone());
    let (a, b) = tokio::join!(
        svc.save_person("a1", " Ada@Example.com ", Some("Ada")),
        svc.save_person("a1", "ada@example.com", Some("Ada")),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        *lock(&fake.creates),
        vec![("ada@example.com".into(), Some("Ada".into()))]
    );
    assert_eq!(suggest(&svc, "ada").await, vec!["ada@example.com"]);
    let rows = db::contacts::all(&db.pool, "a1").await.unwrap();
    assert!(rows[0].saved);
    assert!(svc
        .save_person("missing", "ada@example.com", None)
        .await
        .is_err());
    assert!(svc.save_person("a1", "not an address", None).await.is_err());
    assert_eq!(lock(&fake.creates).len(), 1);
}

#[tokio::test]
async fn person_conversations_match_exact_addresses_and_respect_accounts_and_mail_state() {
    let db = TestDb::with_account("a1").await;
    let mut other = db::accounts::get_account(&db.pool, "a1")
        .await
        .unwrap()
        .unwrap();
    other.id = "a2".into();
    other.email = "second@example.com".into();
    db::accounts::insert_account(&db.pool, &other)
        .await
        .unwrap();
    for (id, labels, from, to) in [
        (
            "received",
            vec!["INBOX"],
            ("Ada@Example.com", Some("Ada")),
            vec![ME],
        ),
        (
            "sent",
            vec!["SENT"],
            ME,
            vec![("ada@example.com", Some("Ada"))],
        ),
        (
            "substring",
            vec!["INBOX"],
            ("notada@example.com", Some("ada@example.com")),
            vec![ME],
        ),
        ("spam", vec!["SPAM"], ("ada@example.com", None), vec![ME]),
        ("trash", vec!["TRASH"], ("ada@example.com", None), vec![ME]),
        ("draft", vec!["DRAFT"], ME, vec![("ada@example.com", None)]),
    ] {
        upsert_message(&db.pool, &message(id, &labels, from, &to, 100))
            .await
            .unwrap();
    }
    let mut other_message = message("private", &["INBOX"], ("ada@example.com", None), &[ME], 200);
    other_message.account_id = "a2".into();
    upsert_message(&db.pool, &other_message).await.unwrap();
    let mut tx = db::begin_write(&db.pool).await.unwrap();
    db::threads::recompute_threads(
        &mut tx,
        "a1",
        &["received", "sent", "substring", "spam", "trash", "draft"].map(str::to_owned),
    )
    .await
    .unwrap();
    db::threads::recompute_threads(&mut tx, "a2", &["private".to_owned()])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let rows = db::contacts::person_threads(&db.pool, "a1", "ada@example.com")
        .await
        .unwrap();
    let mut ids: Vec<_> = rows.into_iter().map(|t| t.id).collect();
    ids.sort();
    assert_eq!(ids, vec!["received", "sent"]);
}

fn page(people: &[(&str, Option<&str>)], next: Option<&str>) -> Result<PeoplePage, GmailError> {
    Ok(PeoplePage {
        people: people
            .iter()
            .map(|(address, name)| Person {
                name: name.map(str::to_owned),
                addresses: vec![(*address).to_owned()],
                ..Person::default()
            })
            .collect(),
        next_page_token: next.map(str::to_owned),
    })
}

fn service(db: &SqlitePool, people: Arc<FakePeople>) -> Arc<ContactService> {
    ContactService::new(
        db.clone(),
        Arc::new(move |_: &str| people.clone() as Arc<dyn PeopleApi>),
    )
}

async fn suggest(svc: &ContactService, query: &str) -> Vec<String> {
    svc.suggest("a1", query, DEFAULT_LIMIT)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.address)
        .collect()
}

fn api_error(message: &str) -> GmailError {
    GmailError::Api {
        status: 403,
        reason: Some("PERMISSION_DENIED".into()),
        message: message.into(),
    }
}

#[tokio::test]
async fn cached_mail_counts_each_message_once_by_its_labels() {
    let db = TestDb::with_account("a1").await;
    let p = &db.pool;
    upsert_message(
        p,
        &message("m1", &["SENT"], ME, &[("Ada@X.com", Some("Ada"))], 10),
    )
    .await
    .unwrap();
    upsert_message(p, &message("m2", &["SENT"], ME, &[("ada@x.com", None)], 20))
        .await
        .unwrap();
    upsert_message(
        p,
        &message(
            "m3",
            &["INBOX", "CATEGORY_PERSONAL"],
            ("ada@x.com", Some("Ada L")),
            &[ME],
            30,
        ),
    )
    .await
    .unwrap();
    // A label change re-upserts the message: it still counts once.
    upsert_message(
        p,
        &message(
            "m3",
            &["CATEGORY_PERSONAL"],
            ("ada@x.com", Some("Ada L")),
            &[ME],
            30,
        ),
    )
    .await
    .unwrap();
    upsert_message(
        p,
        &message("d1", &["DRAFT"], ME, &[("draft@x.com", None)], 40),
    )
    .await
    .unwrap();
    upsert_message(
        p,
        &message("s1", &["SPAM"], ("spam@x.com", None), &[ME], 40),
    )
    .await
    .unwrap();
    upsert_message(
        p,
        &message(
            "n1",
            &["INBOX", "CATEGORY_PROMOTIONS"],
            ("deals@shop.com", None),
            &[ME],
            40,
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        contact(p, "ada@x.com").await,
        Some((Some("Ada L".into()), 2, 1, 20, 30))
    );
    assert_eq!(contact(p, "draft@x.com").await, None);
    assert_eq!(contact(p, "spam@x.com").await, None);
    assert_eq!(contact(p, "deals@shop.com").await, None);
}

#[tokio::test]
async fn malformed_address_json_never_fails_the_insert() {
    let db = TestDb::with_account("a1").await;
    let mut m = message("m1", &["INBOX"], ("ok@x.com", None), &[], 10);
    m.to_addresses = Some("not json".into());
    m.cc_addresses = Some(r#"["a string", {"address": "cc@x.com"}]"#.into());
    upsert_message(&db.pool, &m).await.unwrap();
    assert!(contact(&db.pool, "ok@x.com").await.is_some());
    assert!(contact(&db.pool, "cc@x.com").await.is_some());
}

/// The migration indexes mail cached before it by the same rules the trigger applies.
#[tokio::test]
async fn migration_backfill_matches_the_trigger() {
    let db = TestDb::with_account("a1").await;
    let p = &db.pool;
    let mut cc = message("m2", &["SENT"], ME, &[("bob@y.org", Some("Bob"))], 20);
    cc.cc_addresses = Some(
        json!([{"name": null, "address": "Ada@x.com"}, {"name": "Bob", "address": "bob@y.org"}])
            .to_string(),
    );
    for m in [
        message("m1", &["SENT"], ME, &[("ada@x.com", Some("Ada"))], 10),
        cc,
        message(
            "m3",
            &["INBOX"],
            ("ada@x.com", Some("Ada L")),
            &[ME, ("carol@z.net", None)],
            30,
        ),
        message(
            "m4",
            &["CATEGORY_UPDATES"],
            ("bills@z.net", None),
            &[ME],
            40,
        ),
        message("m5", &["DRAFT"], ME, &[("draft@x.com", None)], 50),
    ] {
        upsert_message(p, &m).await.unwrap();
    }
    let all = || async {
        sqlx::query_as::<_, (String, Option<String>, i64, i64, i64, i64, i64)>(
            "SELECT address, name, name_date, sent_count, received_count, last_sent, last_received
             FROM contacts ORDER BY address",
        )
        .fetch_all(p)
        .await
        .unwrap()
    };
    let from_trigger = all().await;
    assert_eq!(from_trigger.len(), 4, "{from_trigger:?}");

    let migration = include_str!("../db/migrations/009_contacts.sql");
    let backfill = &migration[migration.find("CREATE TEMP TABLE contact_msgs").unwrap()..];
    sqlx::query("DELETE FROM contacts")
        .execute(p)
        .await
        .unwrap();
    sqlx::raw_sql(backfill).execute(p).await.unwrap();
    assert_eq!(all().await, from_trigger);
}

#[tokio::test]
async fn suggestions_match_word_starts_and_rank_people_you_write_to_first() {
    let db = TestDb::with_account("a1").await;
    let p = &db.pool;
    let now = now_ms();
    upsert_message(
        p,
        &message(
            "m1",
            &["SENT"],
            ME,
            &[("ada.lovelace@x.com", Some("Ada Lovelace"))],
            now - DAY,
        ),
    )
    .await
    .unwrap();
    upsert_message(
        p,
        &message(
            "m2",
            &["INBOX"],
            ("adam@y.org", Some("Adam Smith")),
            &[ME],
            now - DAY,
        ),
    )
    .await
    .unwrap();
    upsert_message(
        p,
        &message("m3", &["INBOX"], ("no-reply@ada.io", None), &[ME], now),
    )
    .await
    .unwrap();
    let svc = service(p, Arc::default());

    assert_eq!(
        suggest(&svc, "ada").await,
        ["ada.lovelace@x.com", "adam@y.org"]
    );
    assert_eq!(suggest(&svc, "  LOVE").await, ["ada.lovelace@x.com"]);
    assert_eq!(suggest(&svc, "ada smi").await, ["adam@y.org"]);
    assert_eq!(suggest(&svc, "y.org").await, ["adam@y.org"]);
    assert_eq!(
        suggest(&svc, "ada.lovelace@x").await,
        ["ada.lovelace@x.com"]
    );
    assert_eq!(
        suggest(&svc, "me").await,
        Vec::<String>::new(),
        "never the account itself"
    );
    assert_eq!(
        suggest(&svc, "reply").await,
        Vec::<String>::new(),
        "robots aren't suggested"
    );
    assert_eq!(suggest(&svc, "").await, Vec::<String>::new());
    assert_eq!(suggest(&svc, "zed").await, Vec::<String>::new());
}

#[tokio::test]
async fn google_contacts_join_suggestions_with_their_saved_names() {
    let db = TestDb::with_account("a1").await;
    let p = &db.pool;
    upsert_message(
        p,
        &message(
            "m1",
            &["INBOX"],
            ("grace@navy.mil", Some("G. Hopper")),
            &[ME],
            now_ms(),
        ),
    )
    .await
    .unwrap();
    let people = Arc::new(FakePeople::default());
    lock(&people.saved).extend([
        page(&[("Grace@navy.mil", Some("Grace Hopper"))], Some("next")),
        page(&[("linus@kernel.org", Some("Linus"))], None),
    ]);
    lock(&people.other).push_back(page(
        &[("ken@bell.com", None), ("not-an-address", None)],
        None,
    ));
    let svc = service(p, people.clone());

    let status = svc.refresh_google("a1").await.unwrap();
    assert_eq!(status.status, "on");
    assert_eq!(status.count, 3);
    assert!(status.synced_at.is_some());
    assert_eq!(
        lock(&people.calls).clone(),
        [
            (ContactList::Saved, None),
            (ContactList::Saved, Some("next".into())),
            (ContactList::Other, None)
        ]
    );

    let found = svc.suggest("a1", "grace", 8).await.unwrap();
    assert_eq!(
        found,
        [SuggestionDto {
            name: Some("Grace Hopper".into()),
            address: "grace@navy.mil".into()
        }]
    );
    assert_eq!(suggest(&svc, "lin").await, ["linus@kernel.org"]);
    assert_eq!(suggest(&svc, "ken").await, ["ken@bell.com"]);
}

#[tokio::test]
async fn the_card_prefers_the_saved_contact_and_fills_gaps_from_other_contacts() {
    let db = TestDb::with_account("a1").await;
    let people = Arc::new(FakePeople::default());
    let person = |phone: Option<&str>, organization: Option<&str>, photo: Option<&str>| Person {
        addresses: vec!["Ada@example.com".into()],
        phone: phone.map(str::to_owned),
        organization: organization.map(str::to_owned),
        photo_url: photo.map(str::to_owned),
        ..Person::default()
    };
    lock(&people.saved).push_back(Ok(PeoplePage {
        people: vec![person(
            Some("+1 555 0100"),
            Some("Programmer at Analytical Engines"),
            None,
        )],
        next_page_token: None,
    }));
    lock(&people.other).push_back(Ok(PeoplePage {
        people: vec![person(
            Some("+1 555 0199"),
            None,
            Some("https://lh3.googleusercontent.com/ada"),
        )],
        next_page_token: None,
    }));
    let svc = service(&db.pool, people);
    svc.refresh_google("a1").await.unwrap();

    let card = db::contacts::card(&db.pool, "a1", "ada@example.com")
        .await
        .unwrap();
    assert_eq!(
        card,
        db::contacts::CardRow {
            phone: Some("+1 555 0100".into()),
            organization: Some("Programmer at Analytical Engines".into()),
            photo_url: Some("https://lh3.googleusercontent.com/ada".into()),
        }
    );
    assert_eq!(
        db::contacts::card(&db.pool, "a1", "nobody@example.com")
            .await
            .unwrap(),
        db::contacts::CardRow::default()
    );
}

#[tokio::test]
async fn refresh_reports_a_disabled_api_and_a_missing_permission() {
    let db = TestDb::with_account("a1").await;
    let people = Arc::new(FakePeople::default());
    let svc = service(&db.pool, people.clone());
    assert_eq!(svc.google_status("a1").await.unwrap().status, "unknown");

    let disabled = "People API has not been used in project 42 before or it is disabled.";
    lock(&people.saved).push_back(Err(api_error(disabled)));
    lock(&people.other).push_back(Err(api_error(disabled)));
    let status = svc.refresh_google("a1").await.unwrap();
    assert_eq!(status.status, "api_disabled");
    assert_eq!(
        status.enable_url.as_deref(),
        Some(&*format!("{PEOPLE_API_URL}?project=42"))
    );

    // Only "Other contacts" allowed: those still download.
    lock(&people.saved).push_back(Err(api_error(
        "Request had insufficient authentication scopes.",
    )));
    lock(&people.other).push_back(page(&[("ken@bell.com", None)], None));
    let status = svc.refresh_google("a1").await.unwrap();
    assert_eq!(status.status, "missing_scope");
    assert_eq!(status.count, 1);
}

#[tokio::test]
async fn a_passing_failure_keeps_the_last_status_and_copy() {
    let db = TestDb::with_account("a1").await;
    let people = Arc::new(FakePeople::default());
    let svc = service(&db.pool, people.clone());
    lock(&people.saved).push_back(page(&[("linus@kernel.org", None)], None));
    svc.refresh_google("a1").await.unwrap();

    lock(&people.saved).push_back(Err(GmailError::Offline("no network".into())));
    let status = svc.refresh_google("a1").await.unwrap();
    assert_eq!(status.status, "on");
    assert_eq!(status.count, 1);

    // With no status yet, the same failure is shown.
    let fresh = TestDb::with_account("a1").await;
    let people = Arc::new(FakePeople::default());
    lock(&people.saved).push_back(Err(GmailError::Offline("no network".into())));
    let status = service(&fresh.pool, people)
        .refresh_google("a1")
        .await
        .unwrap();
    assert_eq!(status.status, "error");
    assert!(status.message.unwrap().contains("no network"));
}
