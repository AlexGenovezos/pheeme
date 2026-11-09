//! ComposeService against the in-memory Gmail.

use super::*;
use crate::db::accounts::DbAccount;
use crate::db::outbox as store;
use crate::gmail::mime::decode_base64url;
use crate::sync::events::RecordingEvents;
use crate::sync::fake::{FakeGmail, FakeMsg};
use mailparse::MailHeaderMap;
use std::path::PathBuf;

const ACCT: &str = "a1";

struct H {
    _dir: tempfile::TempDir,
    pool: SqlitePool,
    fake: Arc<FakeGmail>,
    sync: Arc<SyncManager>,
    compose: ComposeService,
    files: PathBuf,
}

async fn harness() -> H {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(dir.path()).await.unwrap();
    accounts::insert_account(
        &pool,
        &DbAccount {
            id: ACCT.into(),
            email: "me@example.com".into(),
            display_name: Some("Me Myself".into()),
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
    let api = fake.clone();
    let sync = SyncManager::new(
        pool.clone(),
        Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
        Arc::new(RecordingEvents::default()),
    );
    let cache = dir.path().join("cache");
    let mail = MailService::new(pool.clone(), sync.clone(), cache.clone());
    let compose = ComposeService::new(pool.clone(), sync.clone(), mail, &cache);
    let files = dir.path().join("files");
    std::fs::create_dir_all(&files).unwrap();
    H {
        _dir: dir,
        pool,
        fake,
        sync,
        compose,
        files,
    }
}

fn addr(address: &str) -> EmailAddress {
    EmailAddress {
        name: None,
        address: address.into(),
    }
}

fn addresses(list: &[EmailAddress]) -> Vec<&str> {
    list.iter().map(|a| a.address.as_str()).collect()
}

const ORIGINAL: &[u8] = b"From: Bo <bo@example.com>\r\n\
Reply-To: team@example.com\r\n\
To: me@example.com, ann@example.com\r\n\
Cc: cy@example.com\r\n\
Subject: Plans\r\n\
Message-ID: <m2@example.com>\r\n\
References: <m1@example.com>\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Shall we?</p>";

#[tokio::test]
async fn reply_all_template_comes_from_the_cached_original() {
    let h = harness().await;
    h.fake
        .seed(FakeMsg::from_raw("m2", "t1", &["INBOX"], ORIGINAL));
    h.sync.sync_account(ACCT).await.unwrap();

    let d = h
        .compose
        .template(ACCT, "m2", ComposeMode::ReplyAll)
        .await
        .unwrap();
    assert_eq!(addresses(&d.to), ["team@example.com", "ann@example.com"]);
    assert_eq!(addresses(&d.cc), ["cy@example.com"]);
    assert_eq!(d.subject, "Re: Plans");
    assert_eq!(d.in_reply_to.as_deref(), Some("<m2@example.com>"));
    assert_eq!(d.references, ["<m1@example.com>", "<m2@example.com>"]);
    assert_eq!(d.thread_id.as_deref(), Some("t1"));
    assert!(d.quote_html.unwrap().contains("<p>Shall we?</p>"));

    assert!(matches!(
        h.compose.template(ACCT, "nope", ComposeMode::Reply).await,
        Err(MailError::NotFound)
    ));
}

#[tokio::test]
async fn forward_stages_the_original_attachments() {
    let h = harness().await;
    h.fake.seed(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_attachment("a.pdf", "application/pdf", "g1")
            .with_embedded("small.txt", "text/plain", None, b"tiny"),
    );
    h.fake.seed_attachment("m1", "g1", b"%PDF-1");
    h.sync.sync_account(ACCT).await.unwrap();

    let d = h
        .compose
        .template(ACCT, "m1", ComposeMode::Forward)
        .await
        .unwrap();
    assert!(d.to.is_empty());
    let names: Vec<&str> = d.attachments.iter().map(|a| a.filename.as_str()).collect();
    assert_eq!(names, ["a.pdf", "small.txt"]);
    assert_eq!(
        h.compose.staging.read(&d.attachments[0]).await.unwrap(),
        b"%PDF-1"
    );
    assert_eq!(
        h.compose.staging.read(&d.attachments[1]).await.unwrap(),
        b"tiny"
    );
}

fn draft_to(address: &str) -> ComposeDraft {
    ComposeDraft {
        to: vec![addr(address)],
        subject: "Hello".into(),
        body_html: "<p>Hi</p>".into(),
        ..Default::default()
    }
}

async fn wait_for_sends(fake: &FakeGmail, n: usize) {
    for _ in 0..100 {
        if fake.sent().len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("expected {n} sends, got {}", fake.sent().len());
}

#[tokio::test]
async fn reply_is_sent_in_its_thread_from_the_account() {
    let h = harness().await;
    let mut d = draft_to("bo@example.com");
    d.thread_id = Some("t1".into());
    d.in_reply_to = Some("<m2@example.com>".into());

    let queued = h.compose.send(ACCT, &d, 0).await.unwrap();
    wait_for_sends(&h.fake, 1).await;

    assert_eq!(h.fake.sent_threads(), [Some("t1".to_owned())]);
    let raw = decode_base64url(&h.fake.sent()[0]).unwrap();
    let mail = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(
        mail.headers.get_first_value("From").unwrap(),
        "\"Me Myself\" <me@example.com>"
    );
    assert_eq!(
        mail.headers.get_first_value("In-Reply-To").unwrap(),
        "<m2@example.com>"
    );
    // The op is removed right after the send lands.
    for _ in 0..100 {
        if store::get(&h.pool, &queued.op_id).await.unwrap().is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(store::get(&h.pool, &queued.op_id).await.unwrap().is_none());
}

#[tokio::test]
async fn send_needs_a_recipient() {
    let h = harness().await;
    let err = h
        .compose
        .send(ACCT, &ComposeDraft::default(), 0)
        .await
        .unwrap_err();
    assert!(matches!(err, MailError::Invalid(_)));
}

#[tokio::test]
async fn undo_cancels_a_send_still_in_its_window() {
    let h = harness().await;
    let queued = h
        .compose
        .send(ACCT, &draft_to("bo@example.com"), 30_000)
        .await
        .unwrap();
    assert!(queued.send_at > now_ms() + 20_000);

    // A sync during the window leaves it alone.
    h.sync.sync_account(ACCT).await.unwrap();
    assert!(h.fake.sent().is_empty());

    assert!(h.compose.cancel_send(&queued.op_id).await.unwrap());
    assert!(!h.compose.cancel_send(&queued.op_id).await.unwrap());
    let engine = h.sync.engine(ACCT);
    outbox::process(&engine, now_ms() + 60_000).await.unwrap();
    assert!(h.fake.sent().is_empty());
}

#[tokio::test]
async fn a_send_that_left_cannot_be_cancelled() {
    let h = harness().await;
    let queued = h
        .compose
        .send(ACCT, &draft_to("bo@example.com"), 30_000)
        .await
        .unwrap();
    h.fake
        .deliver_then_fail(GmailError::Network("reset".into()));
    outbox::process(&h.sync.engine(ACCT), queued.send_at)
        .await
        .unwrap();
    assert_eq!(
        store::get(&h.pool, &queued.op_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        "checking"
    );
    assert!(!h.compose.cancel_send(&queued.op_id).await.unwrap());
}

#[tokio::test]
async fn draft_round_trip_then_send_replaces_it() {
    let h = harness().await;
    h.sync.sync_account(ACCT).await.unwrap();
    let file = h.files.join("notes.txt");
    std::fs::write(&file, b"hello").unwrap();
    let staged = h.compose.stage_file(&file).await.unwrap();
    let mut d = draft_to("bo@example.com");
    d.bcc = vec![addr("hidden@example.com")];
    d.attachments = vec![staged];

    let first = h.compose.save_draft(ACCT, &d).await.unwrap();
    d.draft_id = Some(first.draft_id.clone());
    d.subject = "Hello again".into();
    let second = h.compose.save_draft(ACCT, &d).await.unwrap();
    assert_eq!(second.draft_id, first.draft_id, "same draft, updated");
    assert_ne!(second.message_id, first.message_id);
    assert_eq!(h.fake.drafts().len(), 1);

    h.sync.sync_account(ACCT).await.unwrap();
    let list = h.compose.list_drafts(ACCT).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].subject.as_deref(), Some("Hello again"));

    let opened = h
        .compose
        .open_draft(ACCT, &second.message_id)
        .await
        .unwrap();
    assert_eq!(opened.draft_id.as_deref(), Some(first.draft_id.as_str()));
    assert_eq!(addresses(&opened.to), ["bo@example.com"]);
    assert_eq!(addresses(&opened.bcc), ["hidden@example.com"]);
    assert_eq!(opened.subject, "Hello again");
    assert!(opened.body_html.contains("<p>Hi</p>"));
    assert_eq!(opened.thread_id, None, "not a reply");
    assert_eq!(opened.attachments.len(), 1);
    assert_eq!(opened.attachments[0].filename, "notes.txt");
    assert_eq!(
        h.compose
            .staging
            .read(&opened.attachments[0])
            .await
            .unwrap(),
        b"hello"
    );

    h.compose.send(ACCT, &opened, 0).await.unwrap();
    wait_for_sends(&h.fake, 1).await;
    // The draft is removed right after the send lands.
    for _ in 0..100 {
        if h.fake.drafts().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(h.fake.drafts().is_empty(), "the draft is gone once sent");
}

#[tokio::test]
async fn saving_a_draft_deleted_elsewhere_creates_a_new_one() {
    let h = harness().await;
    let mut d = draft_to("bo@example.com");
    let saved = h.compose.save_draft(ACCT, &d).await.unwrap();
    h.compose.delete_draft(ACCT, &saved.draft_id).await.unwrap();
    // Deleting twice is fine.
    h.compose.delete_draft(ACCT, &saved.draft_id).await.unwrap();

    d.draft_id = Some(saved.draft_id.clone());
    let again = h.compose.save_draft(ACCT, &d).await.unwrap();
    assert_ne!(again.draft_id, saved.draft_id);
    assert_eq!(h.fake.drafts().len(), 1);
}

#[tokio::test]
async fn a_draft_survives_a_send_that_never_left() {
    let h = harness().await;
    let mut d = draft_to("bo@example.com");
    let saved = h.compose.save_draft(ACCT, &d).await.unwrap();
    d.draft_id = Some(saved.draft_id);
    let queued = h.compose.send(ACCT, &d, 30_000).await.unwrap();
    h.fake
        .fail_next("send_message", GmailError::Offline("down".into()));
    outbox::process(&h.sync.engine(ACCT), queued.send_at)
        .await
        .unwrap();

    assert!(h.compose.cancel_send(&queued.op_id).await.unwrap());
    assert_eq!(h.fake.drafts().len(), 1, "still in Drafts");
}

#[tokio::test]
async fn reply_carries_the_images_its_quote_shows_but_not_files() {
    let h = harness().await;
    h.fake.seed(
        FakeMsg::new("m1", "t1", &["INBOX"])
            .with_attachment("a.pdf", "application/pdf", "g1")
            .with_inline("logo.png", "image/png", "g2", "logo"),
    );
    h.fake.seed_attachment("m1", "g2", b"PNG");
    h.sync.sync_account(ACCT).await.unwrap();

    let d = h
        .compose
        .template(ACCT, "m1", ComposeMode::Reply)
        .await
        .unwrap();
    assert_eq!(d.attachments.len(), 1);
    assert_eq!(d.attachments[0].content_id.as_deref(), Some("logo"));
    assert_eq!(
        h.compose.staging.read(&d.attachments[0]).await.unwrap(),
        b"PNG"
    );
}

fn send_as(email: &str, signature: Option<&str>, primary: bool) -> crate::gmail::types::SendAs {
    crate::gmail::types::SendAs {
        send_as_email: email.into(),
        signature: signature.map(Into::into),
        is_primary: primary,
        ..Default::default()
    }
}

#[tokio::test]
async fn gmail_signature_is_the_accounts_own_sanitized() {
    let h = harness().await;
    assert_eq!(h.compose.gmail_signature(ACCT).await.unwrap(), None);

    h.fake.set_send_as(vec![
        send_as("alias@example.com", Some("Alias"), false),
        send_as(
            "Me@Example.com",
            Some("<b onclick=\"x()\">Me</b><script>bad()</script><img src=\"https://x/logo.png\">"),
            false,
        ),
    ]);
    let sig = h.compose.gmail_signature(ACCT).await.unwrap().unwrap();
    assert!(sig.contains("<b>Me</b>"), "{sig}");
    assert!(sig.contains("<img src=\"https://x/logo.png\">"), "{sig}");
    assert!(!sig.contains("script") && !sig.contains("onclick"), "{sig}");

    // No entry for the address itself: the primary one.
    h.fake.set_send_as(vec![
        send_as("other@example.com", Some(" "), true),
        send_as("alias@example.com", Some("Alias"), false),
    ]);
    assert_eq!(
        h.compose.gmail_signature(ACCT).await.unwrap(),
        None,
        "blank is none"
    );
}

#[tokio::test]
async fn gmail_signature_without_the_settings_scope_says_so() {
    let h = harness().await;
    h.fake.fail_next(
        "list_send_as",
        GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        },
    );
    assert_eq!(
        h.compose.gmail_signature(ACCT).await.unwrap_err().code(),
        "missing_scope"
    );
}
