//! Instruction-count benchmarks of the paths that grow with the mailbox, run under Valgrind by
//! gungraun. `cargo bench --features bench`; see docs/performance.md.
//!
//! Each benchmark builds its state with Valgrind's instrumentation off, then counts only the
//! measured call, on every thread: SQLite runs on sqlx's worker thread, which gungraun's default
//! per-function toggle would miss.

use gungraun::client_requests::callgrind;
use gungraun::{
    library_benchmark, library_benchmark_group, main, Callgrind, EntryPoint, LibraryBenchmarkConfig,
};
use pheeme_lib::db::{self, accounts, messages, threads};
use pheeme_lib::mail::{MailService, ThreadDetailDto};
use pheeme_lib::sync::engine::SyncEngine;
use pheeme_lib::sync::fake::{FakeGmail, FakeMsg};
use pheeme_lib::sync::manager::SyncManager;
use pheeme_lib::sync::{MailApi, NoopEvents};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::runtime::Runtime;

const ACCT: &str = "a1";
/// Threads in the seeded mailbox; each has one message, except [`LONG_THREAD`].
const THREADS: usize = 50_000;
const LONG_THREAD: &str = "long";
const LONG_THREAD_MESSAGES: usize = 200;
/// Threads whose labels change in the recompute benchmark.
const RELABELED: usize = 200;
/// Messages arriving between two syncs in the incremental benchmark.
const NEW_MESSAGES: usize = 500;
const PAGE: i64 = 50;
/// Fixed clock so every run seeds identical rows.
const BASE_MS: i64 = 1_700_000_000_000;
const MINUTE_MS: i64 = 60_000;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_TARGET_TMPDIR")).join("bench-mailbox")
}

fn runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn thread_id(i: usize) -> String {
    format!("t{i:05}")
}

fn date(i: usize) -> i64 {
    BASE_MS - i as i64 * MINUTE_MS
}

/// Three in five threads are in the Inbox (spread over the category tabs), the rest Sent or
/// a user label; a third are unread.
fn labels(i: usize) -> Vec<String> {
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

fn message(id: String, thread: String, labels: Vec<String>, date: i64) -> messages::DbMessage {
    let is_read = (!labels.iter().any(|l| l == "UNREAD")).into();
    messages::DbMessage {
        rfc822_message_id: Some(format!("<{id}@example.com>")),
        snippet: Some(format!(
            "Snippet of {id}, long enough to look like a real preview line"
        )),
        body_text: Some(format!("Body of {id}. ").repeat(40)),
        from_address: Some(format!("{thread}@example.com")),
        from_name: Some(format!("Sender {thread}")),
        subject: Some(format!("Subject {thread}")),
        label_ids: Some(serde_json::to_string(&labels).unwrap()),
        id,
        account_id: ACCT.into(),
        thread_id: thread,
        to_addresses: Some(r#"["me@example.com"]"#.into()),
        cc_addresses: None,
        body_html: None,
        date: Some(date),
        size_estimate: Some(1_000),
        has_attachment: 0,
        is_read,
        is_starred: 0,
        raw_headers: None,
        fully_fetched: 1,
    }
}

async fn insert_account(pool: &SqlitePool) {
    accounts::insert_account(
        pool,
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
}

/// Seed the shared 50k-thread mailbox, natively and once per run (`main!` setup).
fn seed_fixture() {
    let dir = fixture_dir();
    let _ = std::fs::remove_dir_all(&dir);
    runtime().block_on(async {
        let pool = db::init_db(&dir).await.unwrap();
        insert_account(&pool).await;
        let mut tx = db::begin_write(&pool).await.unwrap();
        let mut ids: Vec<String> = Vec::with_capacity(THREADS + 1);
        for i in 0..THREADS {
            let m = message(format!("m{i:05}"), thread_id(i), labels(i), date(i));
            messages::upsert_message_tx(&mut tx, &m).await.unwrap();
            ids.push(thread_id(i));
        }
        for j in 0..LONG_THREAD_MESSAGES {
            let m = message(
                format!("long{j:03}"),
                LONG_THREAD.into(),
                vec!["INBOX".into()],
                BASE_MS - (LONG_THREAD_MESSAGES - j) as i64 * MINUTE_MS,
            );
            messages::upsert_message_tx(&mut tx, &m).await.unwrap();
        }
        ids.push(LONG_THREAD.into());
        for chunk in ids.chunks(1_000) {
            threads::recompute_threads(&mut tx, ACCT, chunk)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        pool.close().await;
    });
}

/// The cache in `dir`, migrated, through a one-connection pool. The app's pool hands
/// connections back on a spawned task, so a query sometimes opens a new connection (with a
/// cold statement cache) instead of reusing the idle one; with one connection every run takes
/// the same path.
async fn open(dir: &Path) -> SqlitePool {
    db::init_db(dir).await.unwrap().close().await;
    let options = SqliteConnectOptions::new()
        .filename(dir.join("db.sqlite"))
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

/// Count only `fut`, on every thread.
fn measured<T>(rt: &Runtime, fut: impl Future<Output = T>) -> T {
    callgrind::start_instrumentation();
    let out = rt.block_on(fut);
    callgrind::stop_instrumentation();
    out
}

struct Ctx {
    rt: Runtime,
    pool: SqlitePool,
    _dir: Option<tempfile::TempDir>,
}

/// The seeded mailbox, opened in place (read-only benchmarks).
fn open_fixture() -> Ctx {
    let rt = runtime();
    let pool = rt.block_on(open(&fixture_dir()));
    Ctx {
        rt,
        pool,
        _dir: None,
    }
}

/// A private copy of the seeded mailbox (benchmarks that write).
fn copy_fixture() -> Ctx {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::copy(
        fixture_dir().join("db.sqlite"),
        dir.path().join("db.sqlite"),
    )
    .unwrap();
    let rt = runtime();
    let pool = rt.block_on(open(dir.path()));
    Ctx {
        rt,
        pool,
        _dir: Some(dir),
    }
}

fn empty_db() -> Ctx {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let rt = runtime();
    let pool = rt.block_on(async {
        let pool = open(dir.path()).await;
        insert_account(&pool).await;
        pool
    });
    Ctx {
        rt,
        pool,
        _dir: Some(dir),
    }
}

async fn list_inbox(
    pool: &SqlitePool,
    before: Option<&threads::ThreadCursor>,
) -> threads::ThreadPage {
    threads::list_threads(
        pool,
        &threads::ThreadQuery {
            account_ids: &[ACCT.to_string()],
            label_id: "INBOX",
            also_label_id: None,
            exclude_label_ids: &[],
            read_filter: None,
            before,
            limit: PAGE,
        },
    )
    .await
    .unwrap()
}

/// The cursor of an Inbox thread 90% of the way down the list.
fn deep_cursor() -> threads::ThreadCursor {
    let i = (THREADS * 9 / 10 / 5) * 5;
    assert!(labels(i).iter().any(|l| l == "INBOX"));
    threads::ThreadCursor {
        last_message_date: date(i),
        account_id: ACCT.into(),
        thread_id: thread_id(i),
    }
}

/// The seeded mailbox with the list query already prepared and its pages cached, as after
/// the app's first list.
fn warm_list(before: Option<threads::ThreadCursor>) -> (Ctx, Option<threads::ThreadCursor>) {
    let ctx = open_fixture();
    ctx.rt.block_on(list_inbox(&ctx.pool, before.as_ref()));
    (ctx, before)
}

fn first_page() -> (Ctx, Option<threads::ThreadCursor>) {
    warm_list(None)
}

fn deep_page() -> (Ctx, Option<threads::ThreadCursor>) {
    warm_list(Some(deep_cursor()))
}

#[library_benchmark]
#[bench::first_page(setup = first_page)]
#[bench::deep_page(setup = deep_page)]
fn list_threads((ctx, before): (Ctx, Option<threads::ThreadCursor>)) -> threads::ThreadPage {
    let page = measured(&ctx.rt, list_inbox(&ctx.pool, before.as_ref()));
    assert_eq!(page.threads.len(), PAGE as usize);
    page
}

/// [`RELABELED`] Inbox threads whose messages were archived and starred, with the thread rows
/// not yet recomputed.
fn relabeled() -> (Ctx, Vec<String>) {
    let ctx = copy_fixture();
    let ids: Vec<String> = (0..RELABELED).map(|n| thread_id(n * 5)).collect();
    ctx.rt.block_on(async {
        let mut tx = db::begin_write(&ctx.pool).await.unwrap();
        let archived = ["STARRED".to_string(), "Label_1".to_string()];
        for n in 0..RELABELED {
            let msg = format!("m{:05}", n * 5);
            assert!(messages::set_labels(&mut tx, ACCT, &msg, &archived)
                .await
                .unwrap());
        }
        tx.commit().await.unwrap();
    });
    (ctx, ids)
}

#[library_benchmark]
#[bench::batch(setup = relabeled)]
fn recompute_threads((ctx, ids): (Ctx, Vec<String>)) -> threads::RecomputeResult {
    let result = measured(&ctx.rt, async {
        let mut tx = db::begin_write(&ctx.pool).await.unwrap();
        let result = threads::recompute_threads(&mut tx, ACCT, &ids)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        result
    });
    assert_eq!(result.updated.len(), RELABELED);
    result
}

fn engine(ctx: &Ctx, fake: &Arc<FakeGmail>) -> SyncEngine {
    SyncEngine::new(
        ctx.pool.clone(),
        fake.clone(),
        ACCT,
        Arc::new(NoopEvents),
        Default::default(),
    )
}

/// A Gmail account with 100 Inbox threads of three messages each, never synced.
fn account() -> (Ctx, Arc<FakeGmail>, SyncEngine) {
    let ctx = empty_db();
    let fake = Arc::new(FakeGmail::new());
    for t in 0..100 {
        for m in 0..3 {
            let n = t * 3 + m;
            fake.seed(
                FakeMsg::new(&format!("m{n}"), &format!("t{t}"), &["INBOX", "UNREAD"]).at(date(n)),
            );
        }
    }
    let engine = engine(&ctx, &fake);
    (ctx, fake, engine)
}

fn unsynced() -> (Ctx, SyncEngine) {
    let (ctx, _, engine) = account();
    (ctx, engine)
}

/// A synced account, then [`NEW_MESSAGES`] new messages (half replies to cached threads) and
/// as many label changes made on other devices.
fn behind() -> (Ctx, SyncEngine) {
    let (ctx, fake, engine) = account();
    ctx.rt.block_on(engine.run_initial_sync()).unwrap();
    for n in 0..NEW_MESSAGES {
        let thread = if n.is_multiple_of(2) {
            format!("t{}", n % 100)
        } else {
            format!("new{n}")
        };
        fake.add(
            FakeMsg::new(&format!("new{n}"), &thread, &["INBOX", "UNREAD"]).at(BASE_MS + n as i64),
        );
        fake.relabel(&format!("m{}", n % 300), &[], &["UNREAD"]);
        fake.relabel(&format!("m{}", n % 300), &["UNREAD"], &[]);
    }
    (ctx, engine)
}

#[library_benchmark]
#[bench::inbox(setup = unsynced)]
fn initial_sync((ctx, engine): (Ctx, SyncEngine)) {
    measured(&ctx.rt, engine.run_initial_sync()).unwrap();
}

#[library_benchmark]
#[bench::new_mail(setup = behind)]
fn incremental_sync((ctx, engine): (Ctx, SyncEngine)) -> bool {
    measured(&ctx.rt, engine.run_incremental_sync()).unwrap()
}

/// The mail service over the seeded mailbox, the long thread read once already.
fn long_thread() -> (Ctx, MailService) {
    let ctx = open_fixture();
    let fake: Arc<dyn MailApi> = Arc::new(FakeGmail::new());
    let _rt = ctx.rt.enter();
    let sync = SyncManager::new(
        ctx.pool.clone(),
        Arc::new(move |_| fake.clone()),
        Arc::new(NoopEvents),
    );
    let mail = MailService::new(ctx.pool.clone(), sync, fixture_dir());
    ctx.rt.block_on(mail.get_thread(ACCT, LONG_THREAD)).unwrap();
    (ctx, mail)
}

#[library_benchmark]
#[bench::long_conversation(setup = long_thread)]
fn get_thread((ctx, mail): (Ctx, MailService)) -> ThreadDetailDto {
    let thread = measured(&ctx.rt, mail.get_thread(ACCT, LONG_THREAD)).unwrap();
    assert_eq!(thread.messages.len(), LONG_THREAD_MESSAGES);
    thread
}

library_benchmark_group!(
    name = hot_paths,
    benchmarks = [
        list_threads,
        recompute_threads,
        initial_sync,
        incremental_sync,
        get_thread
    ]
);

main!(
    config = LibraryBenchmarkConfig::default()
        .tool(Callgrind::with_args(["--instr-atstart=no"]).entry_point(EntryPoint::None))
        // glibc's fastbin consolidation runs or not depending on earlier allocations, which
        // moved counts by up to 5% between identical runs; without fastbins it's under 2%.
        .env("GLIBC_TUNABLES", "glibc.malloc.mxfast=0");
    setup = seed_fixture();
    library_benchmark_groups = hot_paths
);
