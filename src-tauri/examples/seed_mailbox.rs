//! Fill an app data directory with a synced-looking mailbox, for the nightly real-app run
//! (scripts/perf/app-run.mjs). `cargo run --release --example seed_mailbox -- <data dir> [threads]`.
//!
//! One account, `threads` conversations (default 20,000) with three in five in the Inbox, the
//! system labels, and the backfill marked complete, so the app opens straight to the list.

use pheeme_lib::db::{self, accounts, labels, messages, sync_state, threads};
use std::path::PathBuf;

const ACCT: &str = "perf-account";
const MINUTE_MS: i64 = 60_000;
const SYSTEM_LABELS: [&str; 13] = [
    "INBOX",
    "SENT",
    "DRAFT",
    "TRASH",
    "SPAM",
    "UNREAD",
    "STARRED",
    "IMPORTANT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];

fn labels_of(i: usize) -> Vec<String> {
    let mut l: Vec<&str> = match i % 5 {
        0..=2 => vec![
            "INBOX",
            threads::CATEGORY_LABELS[i % threads::CATEGORY_LABELS.len()],
        ],
        3 => vec!["SENT"],
        _ => vec!["Label_1"],
    };
    if i.is_multiple_of(3) {
        l.push("UNREAD");
    }
    l.into_iter().map(String::from).collect()
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(
        args.next()
            .expect("usage: seed_mailbox <data dir> [threads]"),
    );
    let count: usize = args.next().map_or(Ok(20_000), |n| n.parse())?;
    let now = chrono::Utc::now().timestamp_millis();

    let pool = db::init_db(&dir).await?;
    accounts::insert_account(
        &pool,
        &accounts::DbAccount {
            id: ACCT.into(),
            email: "perf@example.com".into(),
            display_name: Some("Perf Run".into()),
            profile_photo_url: None,
            client_id: "perf.apps.googleusercontent.com".into(),
            history_id: Some("1".into()),
            created_at: now / 1000,
            updated_at: now / 1000,
        },
    )
    .await?;

    let mut tx = db::begin_write(&pool).await?;
    for (id, name, kind) in SYSTEM_LABELS
        .iter()
        .map(|l| (*l, *l, "system"))
        .chain([("Label_1", "Receipts", "user")])
    {
        labels::upsert_label_tx(
            &mut tx,
            &labels::DbLabel {
                id: id.into(),
                account_id: ACCT.into(),
                name: name.into(),
                label_type: kind.into(),
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
        .await?;
    }
    let mut ids = Vec::with_capacity(count);
    for i in 0..count {
        let id = format!("m{i:06}");
        let thread = format!("t{i:06}");
        let labels = labels_of(i);
        let sender = i % 211;
        messages::upsert_message_tx(
            &mut tx,
            &messages::DbMessage {
                rfc822_message_id: Some(format!("<{id}@example.com>")),
                snippet: Some(format!(
                    "A preview line for conversation {i}, long enough to wrap."
                )),
                body_text: Some(format!("Body of conversation {i}. ").repeat(30)),
                body_html: None,
                from_address: Some(format!("sender{sender}@example.com")),
                from_name: Some(format!("Sender {sender}")),
                subject: Some(format!("Conversation {i}")),
                is_read: (!labels.iter().any(|l| l == "UNREAD")).into(),
                label_ids: Some(serde_json::to_string(&labels)?),
                id,
                account_id: ACCT.into(),
                thread_id: thread.clone(),
                to_addresses: Some(r#"[{"name":null,"address":"perf@example.com"}]"#.into()),
                cc_addresses: None,
                date: Some(now - (i as i64 + 1) * 7 * MINUTE_MS),
                size_estimate: Some(2_000),
                has_attachment: 0,
                is_starred: 0,
                raw_headers: None,
                fully_fetched: 1,
            },
        )
        .await?;
        ids.push(thread);
    }
    for chunk in ids.chunks(1_000) {
        threads::recompute_threads(&mut tx, ACCT, chunk).await?;
    }
    sync_state::reset_backfill(&mut tx, ACCT).await?;
    sync_state::save_backfill(&mut tx, ACCT, None, true, true).await?;
    tx.commit().await?;
    pool.close().await;
    println!("seeded {count} conversations into {}", dir.display());
    Ok(())
}
