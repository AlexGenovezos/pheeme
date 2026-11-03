//! Heap soak and leak check: a long session against the in-memory Gmail under dhat.
//!
//! Backfills a mailbox, then runs sync cycles the way the app does (new mail, deletions and
//! label changes from other devices, the user's own changes through the outbox, list and
//! thread reads). Every cycle leaves the mailbox the same size, so the live heap should level
//! off: the test fails when it keeps growing per cycle, or when the peak passes its budget.
//!
//! `cargo test --release --features test-support --test soak -- --nocapture`;
//! `SOAK=long` for the nightly size. See docs/performance.md.

use pheeme_lib::db::{self, accounts};
use pheeme_lib::mail::MailService;
use pheeme_lib::sync::engine::{BackfillProgress, SyncEngine};
use pheeme_lib::sync::fake::{FakeGmail, FakeMsg};
use pheeme_lib::sync::manager::SyncManager;
use pheeme_lib::sync::{outbox, MailApi, NoopEvents};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

const ACCT: &str = "a1";
/// Messages that arrive, and as many that are deleted, each cycle.
const CHURN: usize = 10;
/// New messages stay this many cycles before Gmail deletes them.
const KEPT_CYCLES: usize = 20;
/// Messages other devices keep relabeling.
const RELABELED: usize = 100;
/// Live heap growth allowed per cycle once warmed up (sampling noise, not a leak).
const MAX_GROWTH_PER_CYCLE: f64 = 256.0;

struct Scale {
    messages: usize,
    cycles: usize,
    /// Peak live heap budget, about 20% above the measured peak (11.9 MiB long, 3.5 MiB
    /// short, on 2026-11-03).
    max_peak_bytes: usize,
}

fn scale() -> Scale {
    match std::env::var("SOAK").as_deref() {
        Ok("long") => Scale {
            messages: 20_000,
            cycles: 1_000,
            max_peak_bytes: 15 << 20,
        },
        _ => Scale {
            messages: 5_000,
            cycles: 200,
            max_peak_bytes: 4 << 20,
        },
    }
}

fn live_bytes() -> usize {
    dhat::HeapStats::get().curr_bytes
}

/// Least-squares slope of `ys` against their index.
fn slope(ys: &[usize]) -> f64 {
    let n = ys.len() as f64;
    let mean_x = (n - 1.0) / 2.0;
    let mean_y = ys.iter().sum::<usize>() as f64 / n;
    let (mut num, mut den) = (0.0, 0.0);
    for (x, &y) in ys.iter().enumerate() {
        let dx = x as f64 - mean_x;
        num += dx * (y as f64 - mean_y);
        den += dx * dx;
    }
    num / den
}

async fn history_id(pool: &sqlx::SqlitePool) -> u64 {
    accounts::get_account(pool, ACCT)
        .await
        .unwrap()
        .unwrap()
        .history_id
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn heap_levels_off_over_a_long_session() {
    let scale = scale();
    let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("soak");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let _profiler = dhat::Profiler::builder()
        .file_name(out.join("dhat-heap.json"))
        .trim_backtraces(Some(12))
        .build();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let samples = rt.block_on(async {
        // One connection: the app's pool opens more at unpredictable moments, each with its own
        // statement and page caches, which reads as a step in the live heap.
        let db_dir = out.join("db");
        db::init_db(&db_dir).await.unwrap().close().await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(db_dir.join("db.sqlite"))
                    .foreign_keys(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        accounts::insert_account(
            &pool,
            &accounts::DbAccount {
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

        // A mailbox of `messages`, two to a thread, spread over the last 170 days: inside the
        // full-body window, so opening a thread never refreshes bodies in the background.
        let fake = Arc::new(FakeGmail::new());
        let threads = scale.messages / 2;
        for n in 0..scale.messages {
            let labels: &[&str] = match n % 4 {
                0 => &["INBOX", "UNREAD"],
                1 => &["INBOX"],
                2 => &["SENT"],
                _ => &["Label_1"],
            };
            fake.seed(
                FakeMsg::new(&format!("m{n}"), &format!("t{}", n % threads), labels)
                    .days_ago((n * 170 / scale.messages) as i64),
            );
        }

        let engine = SyncEngine::new(
            pool.clone(),
            fake.clone(),
            ACCT,
            Arc::new(NoopEvents),
            Default::default(),
        );
        engine.run_initial_sync().await.unwrap();
        while engine.backfill_step().await.unwrap() == BackfillProgress::More {}
        drop(engine);

        let api: Arc<dyn MailApi> = fake.clone();
        let sync = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone()),
            Arc::new(NoopEvents),
        );
        let mail = MailService::new(pool.clone(), sync.clone(), out.join("cache"));
        let me = [ACCT.to_string()];

        let mut arrived: VecDeque<String> = VecDeque::new();
        let mut samples = Vec::with_capacity(scale.cycles);
        for cycle in 0..scale.cycles {
            // Other devices: new mail (half replies), deletions, label changes.
            for k in 0..CHURN {
                let id = format!("new{cycle}-{k}");
                let thread = if k % 2 == 0 {
                    format!("t{}", (cycle * CHURN + k) % threads)
                } else {
                    id.clone()
                };
                fake.add(FakeMsg::new(&id, &thread, &["INBOX", "UNREAD"]));
                arrived.push_back(id);
                // The same few messages each time: touching new ones would grow the fake.
                let seeded = format!("m{}", (cycle * CHURN + k) % RELABELED);
                // Flip direction each full pass over them, so every visit changes something.
                if (cycle / (RELABELED / CHURN)).is_multiple_of(2) {
                    fake.relabel(&seeded, &["STARRED"], &["UNREAD"]);
                } else {
                    fake.relabel(&seeded, &["UNREAD"], &["STARRED"]);
                }
            }
            while arrived.len() > KEPT_CYCLES * CHURN {
                fake.delete(&arrived.pop_front().unwrap());
            }

            // The user reads the Inbox, opens the newest thread and archives or restores one.
            // The change is queued straight on the outbox: `MailService::modify_threads` would
            // also start a sync in the background, still running when the heap is sampled.
            let page = mail
                .list_threads(&me, "INBOX", None, None, None)
                .await
                .unwrap();
            let newest = page.threads[0].id.clone();
            mail.get_thread(ACCT, &newest).await.unwrap();
            let target = format!("t{}", cycle % threads);
            let inbox = ["INBOX".to_string()];
            let (add, remove): (&[String], &[String]) = if cycle % 2 == 0 {
                (&[], &inbox)
            } else {
                (&inbox, &[])
            };
            outbox::enqueue_modify(&pool, ACCT, &[target], add, remove)
                .await
                .unwrap();

            sync.sync_account(ACCT).await.unwrap();
            fake.forget_history_through(history_id(&pool).await);
            samples.push(live_bytes());
        }
        pool.close().await;
        samples
    });

    let stats = dhat::HeapStats::get();
    // The first quarter warms caches (SQLite pages, prepared statements, pool connections).
    let steady = &samples[scale.cycles / 4..];
    let growth = slope(steady);
    println!(
        "soak: {} messages, {} cycles; live heap {} KiB -> {} KiB, {growth:.0} B/cycle; peak {} KiB",
        scale.messages,
        scale.cycles,
        steady[0] >> 10,
        steady[steady.len() - 1] >> 10,
        stats.max_bytes >> 10,
    );
    assert!(
        growth <= MAX_GROWTH_PER_CYCLE,
        "live heap grows {growth:.0} bytes per sync cycle (limit {MAX_GROWTH_PER_CYCLE}); \
         open {} in dh_view.html to see what holds it",
        out.join("dhat-heap.json").display()
    );
    assert!(
        stats.max_bytes <= scale.max_peak_bytes,
        "peak heap {} KiB is over the {} KiB budget",
        stats.max_bytes >> 10,
        scale.max_peak_bytes >> 10
    );
}
