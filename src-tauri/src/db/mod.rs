pub mod accounts;
pub mod assistant;
pub mod attachments;
pub mod calendar;
pub mod contacts;
pub mod desktop;
pub mod labels;
pub mod messages;
pub mod outbox;
pub mod reminders;
pub mod search;
pub mod settings;
pub mod sync_state;
pub mod tasks;
pub mod threads;

#[cfg(test)]
mod encryption_tests;
#[cfg(test)]
pub(crate) mod test_support;

use crate::storage::StorageKey;
use anyhow::{ensure, Context, Result};
use sqlx::{
    sqlite::SqliteConnectOptions, ConnectOptions, Connection, SqliteConnection, SqlitePool,
};
use std::path::Path;
use tracing::info;

/// Turns on SQLite's query planner stability guarantee (QPSG) for every connection this
/// process opens from now on. Without it, SQLite 3.47 and later plan a statement for the
/// values bound to its `LIMIT ?` and so prepare it again on every run: each list page paid
/// a full recompile, about 40% more work. The queries here pin their plans (`INDEXED BY`, no
/// `ANALYZE` statistics), so plans that depend on bound values buy nothing.
pub(crate) fn stable_query_plans() {
    static REGISTER: std::sync::Once = std::sync::Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `enable_qpsg` has the signature SQLite calls extension entry points with.
        let rc = unsafe { libsqlite3_sys::sqlite3_auto_extension(Some(enable_qpsg)) };
        if rc != libsqlite3_sys::SQLITE_OK {
            tracing::warn!(rc, "couldn't pin SQLite query plans");
        }
    });
}

/// Runs inside `sqlite3_open` for each new connection (see [`stable_query_plans`]).
unsafe extern "C" fn enable_qpsg(
    db: *mut libsqlite3_sys::sqlite3,
    _error: *mut *mut std::ffi::c_char,
    _api: *const libsqlite3_sys::sqlite3_api_routines,
) -> std::ffi::c_int {
    // SAFETY: `db` is the connection SQLite is opening; a null out-pointer is allowed.
    unsafe {
        libsqlite3_sys::sqlite3_db_config(
            db,
            libsqlite3_sys::SQLITE_DBCONFIG_ENABLE_QPSG,
            1 as std::ffi::c_int,
            std::ptr::null_mut::<std::ffi::c_int>(),
        );
    }
    libsqlite3_sys::SQLITE_OK
}

/// How long a write waits for another connection's write to finish before it fails with
/// "database is locked". SQLite has one writer at a time, and sync commits whole batches of
/// mail in one transaction: sqlx's default of 5 s made the user's own click fail behind one.
/// Nothing here holds the write lock across a network call, so the wait is for local work only.
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub async fn init_db(data_dir: &Path, key: &StorageKey) -> Result<SqlitePool> {
    crate::storage::private_dir(data_dir)?;

    let db_path = data_dir.join("db.sqlite");
    info!(
        "Opening database at {}",
        crate::support::scrub::display_path(&db_path)
    );

    encrypt_legacy_database(&db_path, key).await?;
    let options = key
        .database_options(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(BUSY_TIMEOUT);
    // Tests open hundreds of throwaway databases, and flushing every commit to disk made each
    // take ~0.4 s on Linux and much longer on Windows (Rust tests ran 163 s there, 19 s on
    // Linux). Only a power cut can lose an unflushed commit, which no test survives anyway.
    #[cfg(test)]
    let options = options.synchronous(sqlx::sqlite::SqliteSynchronous::Off);

    let pool = SqlitePool::connect_with(options).await?;

    // Unknown pragmas are silently ignored by ordinary SQLite. Refuse to run if a build
    // accidentally loses SQLCipher, rather than accepting `key` and storing plaintext.
    let cipher: Option<String> = sqlx::query_scalar("PRAGMA cipher_version")
        .fetch_optional(&pool)
        .await?;
    ensure!(
        cipher.is_some_and(|v| !v.is_empty()),
        "This build is missing SQLCipher encryption support"
    );

    run_migrations(&pool).await?;

    Ok(pool)
}

/// The original remains authoritative until a fully verified encrypted export replaces it.
/// Retrying after interruption discards only the incomplete encrypted export. There is no
/// plaintext backup, rename gap, or window in which old WAL pages can attach to the new DB.
async fn encrypt_legacy_database(path: &Path, key: &StorageKey) -> Result<()> {
    if !path.exists() || !crate::storage::is_plaintext_database(path)? {
        return Ok(());
    }
    let exported = path.with_file_name("db.sqlite.encrypted");
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let file = path.with_file_name(format!("db.sqlite.encrypted{suffix}"));
        match tokio::fs::remove_file(file).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        // SQLite inherits this flag for ATTACH, which must create the encrypted export.
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
        .foreign_keys(false)
        .pragma("temp_store", "MEMORY")
        .disable_statement_logging();
    let mut source = SqliteConnection::connect_with(&options).await?;
    let cipher: Option<String> = sqlx::query_scalar("PRAGMA cipher_version")
        .fetch_optional(&mut source)
        .await?;
    ensure!(
        cipher.is_some_and(|v| !v.is_empty()),
        "This build is missing SQLCipher encryption support"
    );
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut source)
        .await?;
    sqlx::query("ATTACH DATABASE ? AS encrypted KEY ?")
        .bind(
            exported
                .to_str()
                .context("Database path is not valid UTF-8")?,
        )
        .bind(&*key.database_key())
        .execute(&mut source)
        .await?;
    sqlx::query("BEGIN EXCLUSIVE").execute(&mut source).await?;
    sqlx::query("SELECT sqlcipher_export('encrypted')")
        .execute(&mut source)
        .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA encrypted.user_version = {user_version}"
    )))
    .execute(&mut source)
    .await?;
    sqlx::query("COMMIT").execute(&mut source).await?;
    sqlx::query("DETACH DATABASE encrypted")
        .execute(&mut source)
        .await?;
    source.close().await?;

    let options = key.database_options(&exported).foreign_keys(true);
    let mut verified = SqliteConnection::connect_with(&options).await?;
    // Export can renumber implicit rowids; rebuild the external-content FTS index so
    // search continues pointing to the right messages, including after deleted rows.
    let has_fts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'messages_fts'")
            .fetch_one(&mut verified)
            .await?;
    if has_fts != 0 {
        sqlx::query("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
            .execute(&mut verified)
            .await?;
        sqlx::query("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)")
            .execute(&mut verified)
            .await?;
    }
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut verified)
        .await?;
    ensure!(
        integrity == ["ok"],
        "Encrypted database did not pass integrity verification; the original is untouched"
    );
    let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut verified)
        .await?;
    ensure!(
        foreign_keys.is_empty(),
        "Encrypted database has invalid relationships; the original is untouched"
    );
    verified.close().await?;
    std::fs::File::options()
        .read(true)
        .write(true)
        .open(&exported)?
        .sync_all()?;
    // DELETE journal mode above checkpoints and removes the old plaintext WAL/SHM.
    for suffix in ["-wal", "-shm", "-journal"] {
        ensure!(
            !path.with_file_name(format!("db.sqlite{suffix}")).exists(),
            "An old database journal is still in use; close other Pheeme instances and retry"
        );
    }
    std::fs::rename(&exported, path)
        .context("Couldn't replace the old database with its encrypted copy")?;
    crate::storage::sync_dir(path.parent().context("Database has no parent directory")?)?;
    info!("Local mail database encrypted");
    Ok(())
}

/// A write transaction that takes SQLite's write lock up front (`BEGIN IMMEDIATE`), so it
/// waits its turn behind other writers instead of failing when it upgrades from a read.
pub async fn begin_write(pool: &SqlitePool) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
    Ok(pool.begin_with("BEGIN IMMEDIATE").await?)
}

pub(crate) async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::migrate!("src/db/migrations").run(pool).await?;
    info!("Database migrations applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        run_migrations(&pool)
            .await
            .expect("migrations apply on fresh db");
        pool
    }

    /// `.cargo/config.toml` builds SQLite without SQLITE_ENABLE_MEMORY_MANAGEMENT, whose
    /// shared page cache makes the pool's connections read one at a time.
    #[tokio::test]
    async fn sqlite_page_caches_are_per_connection() {
        let pool = fresh_pool().await;
        let options: Vec<String> = sqlx::query_scalar("PRAGMA compile_options")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            !options.iter().any(|o| o == "ENABLE_MEMORY_MANAGEMENT"),
            "built with a shared page cache: {options:?}"
        );
    }

    #[tokio::test]
    async fn writers_wait_out_a_long_write_instead_of_failing() {
        let db = test_support::TestDb::with_account("a").await;
        let timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(timeout_ms, BUSY_TIMEOUT.as_millis() as i64);
        assert!(timeout_ms >= 30_000);

        // A second writer queues behind an open write transaction and goes through once it ends.
        let held = begin_write(&db.pool).await.unwrap();
        let pool = db.pool.clone();
        let waiting = tokio::spawn(async move {
            let tx = begin_write(&pool).await?;
            tx.commit().await?;
            anyhow::Ok(())
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!waiting.is_finished(), "waits for the first writer");
        held.commit().await.unwrap();
        waiting.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn migrations_create_all_tables() {
        let pool = fresh_pool().await;

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_sqlx%' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        let names: Vec<String> = tables.into_iter().map(|(n,)| n).collect();
        for expected in [
            "accounts",
            "attachments",
            "labels",
            "messages",
            "outbox",
            "outbox_messages",
            "sync_state",
            "thread_labels",
            "threads",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing table {expected}, got: {names:?}"
            );
        }
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        let row: (i64,) =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(pool)
                .await
                .unwrap();
        row.0
    }

    fn test_account(id: &str) -> accounts::DbAccount {
        accounts::DbAccount {
            id: id.into(),
            email: format!("{id}@example.com"),
            display_name: None,
            profile_photo_url: None,
            client_id: "client-1".into(),
            history_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn test_thread(account_id: &str, id: &str, date: i64) -> threads::DbThread {
        threads::DbThread {
            id: id.into(),
            account_id: account_id.into(),
            subject: None,
            snippet: None,
            history_id: None,
            last_message_date: Some(date),
            message_count: 1,
            unread_count: 0,
            has_attachment: 0,
            from_name: None,
            from_address: None,
            is_starred: 0,
        }
    }

    fn test_message(account_id: &str, id: &str, thread_id: &str) -> messages::DbMessage {
        messages::DbMessage {
            id: id.into(),
            account_id: account_id.into(),
            thread_id: thread_id.into(),
            label_ids: None,
            from_address: None,
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: None,
            date: None,
            size_estimate: None,
            has_attachment: 1,
            is_read: 1,
            is_starred: 0,
            raw_headers: None,
            fully_fetched: 0,
            rfc822_message_id: None,
        }
    }

    fn test_attachment(account_id: &str, message_id: &str, id: &str) -> attachments::DbAttachment {
        attachments::DbAttachment {
            id: id.into(),
            message_id: message_id.into(),
            account_id: account_id.into(),
            filename: Some("a.txt".into()),
            mime_type: Some("text/plain".into()),
            size: Some(1),
            attachment_id: None,
            content_id: None,
            is_inline: 0,
        }
    }

    fn labels(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn migration_003_refetches_messages_that_have_attachments() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let all = sqlx::migrate!("src/db/migrations");
        let through_002 = sqlx::migrate::Migrator {
            migrations: all
                .migrations
                .iter()
                .filter(|m| m.version <= 2)
                .cloned()
                .collect::<Vec<_>>()
                .into(),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        through_002.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO accounts (id, email, client_id, created_at, updated_at) VALUES ('a', 'a@x', 'c', 0, 0)")
            .execute(&pool)
            .await
            .unwrap();
        for (id, body) in [("with-att", "hello"), ("plain", "hi")] {
            sqlx::query("INSERT INTO messages (id, account_id, thread_id, body_text, fully_fetched) VALUES (?, 'a', 't', ?, 1)")
                .bind(id)
                .bind(body)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO attachments (id, message_id, account_id, filename) VALUES ('0', 'with-att', 'a', 'a.pdf')")
            .execute(&pool)
            .await
            .unwrap();

        all.run(&pool).await.unwrap();

        let rows: Vec<(String, i64, Option<String>)> =
            sqlx::query_as("SELECT id, fully_fetched, body_text FROM messages ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            [
                ("plain".into(), 1, Some("hi".into())),
                ("with-att".into(), 0, Some("hello".into())),
            ],
            "only the message with attachment rows is queued for a re-fetch; bodies stay"
        );
        let (inline, cid): (i64, Option<String>) =
            sqlx::query_as("SELECT is_inline, content_id FROM attachments")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((inline, cid), (0, None));
    }

    #[tokio::test]
    async fn attachments_are_found_by_content_id_and_row_id() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        threads::upsert_thread(&pool, &test_thread("acct-1", "t1", 100), &labels(&[]))
            .await
            .unwrap();
        messages::upsert_message(&pool, &test_message("acct-1", "m1", "t1"))
            .await
            .unwrap();
        let mut logo = test_attachment("acct-1", "m1", "0");
        logo.content_id = Some("logo@x".into());
        logo.is_inline = 1;
        attachments::insert_attachment(&pool, &logo).await.unwrap();
        attachments::insert_attachment(&pool, &test_attachment("acct-1", "m1", "1"))
            .await
            .unwrap();

        let by_cid = attachments::get_by_content_id(&pool, "acct-1", "m1", "logo@x")
            .await
            .unwrap()
            .unwrap();
        assert_eq!((by_cid.id.as_str(), by_cid.is_inline), ("0", 1));
        assert!(
            attachments::get_by_content_id(&pool, "acct-1", "m1", "nope")
                .await
                .unwrap()
                .is_none()
        );
        let one = attachments::get_one(&pool, "acct-1", "m1", "1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(one.content_id, None);
        assert!(attachments::get_one(&pool, "acct-2", "m1", "1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn accounts_cascade_deletes_children() {
        use accounts::insert_account;
        use attachments::insert_attachment;
        use labels::{upsert_label, DbLabel};
        use messages::upsert_message;
        use threads::upsert_thread;

        let pool = fresh_pool().await;

        insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();

        upsert_label(
            &pool,
            &DbLabel {
                id: "INBOX".into(),
                account_id: "acct-1".into(),
                name: "Inbox".into(),
                label_type: "system".into(),
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
        upsert_thread(
            &pool,
            &test_thread("acct-1", "t1", 100),
            &labels(&["INBOX"]),
        )
        .await
        .unwrap();
        upsert_message(&pool, &test_message("acct-1", "m1", "t1"))
            .await
            .unwrap();
        insert_attachment(&pool, &test_attachment("acct-1", "m1", "att1"))
            .await
            .unwrap();

        assert_eq!(count(&pool, "thread_labels").await, 1);
        assert_eq!(count(&pool, "attachments").await, 1);

        sqlx::query!("DELETE FROM accounts WHERE id = ?", "acct-1")
            .execute(&pool)
            .await
            .unwrap();

        for table in [
            "labels",
            "threads",
            "thread_labels",
            "messages",
            "attachments",
        ] {
            assert_eq!(
                count(&pool, table).await,
                0,
                "{table} should cascade on account delete"
            );
        }
    }

    #[tokio::test]
    async fn deleting_message_cascades_attachments() {
        use accounts::insert_account;
        use attachments::{get_attachments_for_message, insert_attachment};
        use messages::upsert_message;

        let pool = fresh_pool().await;
        insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        for m in ["m1", "m2"] {
            upsert_message(&pool, &test_message("acct-1", m, "t1"))
                .await
                .unwrap();
            insert_attachment(&pool, &test_attachment("acct-1", m, "att1"))
                .await
                .unwrap();
        }

        sqlx::query!(
            "DELETE FROM messages WHERE account_id = ? AND id = ?",
            "acct-1",
            "m1"
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(get_attachments_for_message(&pool, "acct-1", "m1")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            get_attachments_for_message(&pool, "acct-1", "m2")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn upsert_thread_replaces_labels() {
        use accounts::insert_account;
        use threads::{get_thread_label_ids, upsert_thread};

        let pool = fresh_pool().await;
        insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        let thread = test_thread("acct-1", "t1", 100);

        upsert_thread(&pool, &thread, &labels(&["INBOX", "CATEGORY_PRIMARY"]))
            .await
            .unwrap();
        assert_eq!(
            get_thread_label_ids(&pool, "acct-1", "t1").await.unwrap(),
            labels(&["CATEGORY_PRIMARY", "INBOX"])
        );

        upsert_thread(&pool, &thread, &labels(&["CATEGORY_PRIMARY"]))
            .await
            .unwrap();
        assert_eq!(
            get_thread_label_ids(&pool, "acct-1", "t1").await.unwrap(),
            labels(&["CATEGORY_PRIMARY"])
        );
    }

    #[tokio::test]
    async fn update_thread_labels_replaces_set() {
        use accounts::insert_account;
        use threads::{get_thread_label_ids, update_thread_labels, upsert_thread};

        let pool = fresh_pool().await;
        insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        upsert_thread(
            &pool,
            &test_thread("acct-1", "t1", 100),
            &labels(&["INBOX"]),
        )
        .await
        .unwrap();

        update_thread_labels(&pool, "acct-1", "t1", &labels(&["STARRED", "SENT"]))
            .await
            .unwrap();
        assert_eq!(
            get_thread_label_ids(&pool, "acct-1", "t1").await.unwrap(),
            labels(&["SENT", "STARRED"])
        );

        let dates: Vec<(i64,)> = sqlx::query_as("SELECT last_message_date FROM thread_labels")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(dates.iter().all(|(d,)| *d == 100));
    }

    #[tokio::test]
    async fn upsert_thread_updates_label_dates() {
        use accounts::insert_account;
        use threads::upsert_thread;

        let pool = fresh_pool().await;
        insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();

        upsert_thread(
            &pool,
            &test_thread("acct-1", "t1", 100),
            &labels(&["INBOX", "UNREAD"]),
        )
        .await
        .unwrap();
        upsert_thread(
            &pool,
            &test_thread("acct-1", "t1", 200),
            &labels(&["INBOX", "UNREAD"]),
        )
        .await
        .unwrap();

        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT last_message_date FROM thread_labels WHERE account_id = 'acct-1' AND thread_id = 't1'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|(d,)| *d == 200), "got {rows:?}");
    }

    #[tokio::test]
    async fn accounts_table_has_no_token_columns() {
        let pool = fresh_pool().await;
        let cols: Vec<(String,)> = sqlx::query_as("SELECT name FROM pragma_table_info('accounts')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(!cols.is_empty());
        for (name,) in cols {
            assert!(
                !name.contains("token"),
                "accounts must not store secrets, found column {name}"
            );
        }
    }

    fn msg_with(
        account_id: &str,
        id: &str,
        thread_id: &str,
        date: i64,
        labels: &[&str],
    ) -> messages::DbMessage {
        let mut m = test_message(account_id, id, thread_id);
        m.has_attachment = 0;
        m.date = Some(date);
        m.subject = Some(format!("subject {id}"));
        m.from_name = Some(format!("from {id}"));
        m.label_ids = Some(serde_json::to_string(labels).unwrap());
        m.is_read = (!labels.contains(&"UNREAD")).into();
        m.is_starred = labels.contains(&"STARRED").into();
        m
    }

    async fn put(pool: &SqlitePool, m: &messages::DbMessage) {
        messages::upsert_message(pool, m).await.unwrap();
    }

    async fn recompute(
        pool: &SqlitePool,
        account: &str,
        threads: &[&str],
    ) -> threads::RecomputeResult {
        let mut conn = pool.acquire().await.unwrap();
        threads::recompute_threads(&mut conn, account, &labels(threads))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn recompute_threads_derives_labels_and_deletes_empty() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        put(
            &pool,
            &msg_with("acct-1", "m1", "t1", 100, &["INBOX", "UNREAD"]),
        )
        .await;
        put(&pool, &msg_with("acct-1", "m2", "t1", 200, &["SENT"])).await;

        let r = recompute(&pool, "acct-1", &["t1"]).await;
        assert_eq!(r.created, labels(&["t1"]));
        assert_eq!(
            threads::get_thread_label_ids(&pool, "acct-1", "t1")
                .await
                .unwrap(),
            labels(&["INBOX", "SENT", "UNREAD"])
        );
        let t = threads::get_thread(&pool, "acct-1", "t1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(t.unread_count, 1);
        assert_eq!(t.message_count, 2);
        assert_eq!(t.subject.as_deref(), Some("subject m1"));
        assert_eq!(t.from_name.as_deref(), Some("from m2"));
        assert_eq!(t.last_message_date, Some(200));

        for m in ["m1", "m2"] {
            messages::delete_message(&pool, "acct-1", m).await.unwrap();
        }
        let r = recompute(&pool, "acct-1", &["t1"]).await;
        assert_eq!(r.removed, labels(&["t1"]));
        assert!(threads::get_thread(&pool, "acct-1", "t1")
            .await
            .unwrap()
            .is_none());
        assert_eq!(count(&pool, "thread_labels").await, 0);
    }

    #[tokio::test]
    async fn trashed_message_only_contributes_trash() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        put(&pool, &msg_with("acct-1", "m1", "t1", 100, &["INBOX"])).await;
        put(
            &pool,
            &msg_with("acct-1", "m2", "t1", 200, &["INBOX", "TRASH", "UNREAD"]),
        )
        .await;
        recompute(&pool, "acct-1", &["t1"]).await;
        assert_eq!(
            threads::get_thread_label_ids(&pool, "acct-1", "t1")
                .await
                .unwrap(),
            labels(&["INBOX", "TRASH"])
        );
        let t = threads::get_thread(&pool, "acct-1", "t1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!((t.unread_count, t.message_count), (0, 1));

        messages::delete_message(&pool, "acct-1", "m1")
            .await
            .unwrap();
        recompute(&pool, "acct-1", &["t1"]).await;
        assert_eq!(
            threads::get_thread_label_ids(&pool, "acct-1", "t1")
                .await
                .unwrap(),
            labels(&["TRASH"])
        );
    }

    #[tokio::test]
    async fn unread_counts_across_accounts() {
        let pool = fresh_pool().await;
        for a in ["acct-1", "acct-2"] {
            accounts::insert_account(&pool, &test_account(a))
                .await
                .unwrap();
        }
        put(
            &pool,
            &msg_with(
                "acct-1",
                "m1",
                "t1",
                1,
                &["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
            ),
        )
        .await;
        put(
            &pool,
            &msg_with(
                "acct-2",
                "m2",
                "t2",
                2,
                &["INBOX", "CATEGORY_SOCIAL", "UNREAD"],
            ),
        )
        .await;
        put(
            &pool,
            &msg_with("acct-2", "m3", "t3", 3, &["INBOX", "CATEGORY_SOCIAL"]),
        )
        .await;
        put(
            &pool,
            &msg_with("acct-2", "m4", "t4", 4, &["CATEGORY_SOCIAL", "UNREAD"]),
        )
        .await;
        recompute(&pool, "acct-1", &["t1"]).await;
        recompute(&pool, "acct-2", &["t2", "t3", "t4"]).await;

        let every_tab = |ids: &[String]| {
            ids.iter()
                .map(|a| (a.clone(), crate::mail::primary_excludes(&[])))
                .collect::<std::collections::HashMap<_, _>>()
        };
        let both = labels(&["acct-1", "acct-2"]);
        let counts = threads::unread_counts(&pool, &both, &every_tab(&both))
            .await
            .unwrap();
        assert_eq!(
            counts,
            vec![
                ("CATEGORY_PERSONAL".to_owned(), 1),
                ("CATEGORY_SOCIAL".to_owned(), 1),
                ("INBOX".to_owned(), 2),
            ]
        );
        let acct1 = labels(&["acct-1"]);
        let one = threads::unread_counts(&pool, &acct1, &every_tab(&acct1))
            .await
            .unwrap();
        assert_eq!(
            one,
            vec![("CATEGORY_PERSONAL".to_owned(), 1), ("INBOX".to_owned(), 1)]
        );
    }

    #[tokio::test]
    async fn set_labels_updates_flags() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        put(&pool, &msg_with("acct-1", "m1", "t1", 1, &["INBOX"])).await;
        let mut conn = pool.acquire().await.unwrap();
        assert!(
            messages::set_labels(&mut conn, "acct-1", "m1", &labels(&["STARRED"]))
                .await
                .unwrap()
        );
        let m = messages::get_message(&mut *conn, "acct-1", "m1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!((m.is_read, m.is_starred), (1, 1));
        assert!(
            messages::set_labels(&mut conn, "acct-1", "m1", &labels(&["UNREAD"]))
                .await
                .unwrap()
        );
        let m = messages::get_message(&mut *conn, "acct-1", "m1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!((m.is_read, m.is_starred), (0, 0));
        assert!(
            !messages::set_labels(&mut conn, "acct-1", "m1", &labels(&["UNREAD"]))
                .await
                .unwrap(),
            "the same labels again are no change"
        );
        assert!(
            !messages::set_labels(&mut conn, "acct-1", "nope", &labels(&[]))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn metadata_upsert_keeps_cached_body() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        let mut full = msg_with("acct-1", "m1", "t1", 1, &["INBOX"]);
        full.body_text = Some("hello".into());
        full.fully_fetched = 1;
        put(&pool, &full).await;
        let mut meta = msg_with("acct-1", "m1", "t1", 1, &[]);
        meta.fully_fetched = 0;
        put(&pool, &meta).await;
        let m = messages::get_message(&pool, "acct-1", "m1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (m.body_text.as_deref(), m.fully_fetched),
            (Some("hello"), 1)
        );
    }

    #[tokio::test]
    async fn outbox_cascades_messages_and_orders_by_seq() {
        let pool = fresh_pool().await;
        accounts::insert_account(&pool, &test_account("acct-1"))
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        for id in ["op-b", "op-a"] {
            let op = outbox::DbOp {
                seq: 0,
                id: id.into(),
                account_id: "acct-1".into(),
                kind: "modify".into(),
                payload: "{}".into(),
                status: "pending".into(),
                attempts: 0,
                next_attempt_at: 0,
                checks_done: 0,
                rfc822_message_id: None,
                last_error: None,
                created_at: 0,
                updated_at: 0,
            };
            let target = outbox::DbOpMessage {
                op_id: id.into(),
                account_id: "acct-1".into(),
                message_id: "m1".into(),
                thread_id: "t1".into(),
                prior_label_ids: "[]".into(),
            };
            outbox::insert(&mut conn, &op, &[target]).await.unwrap();
        }
        let ops = outbox::for_account(&mut *conn, "acct-1").await.unwrap();
        assert_eq!(
            ops.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            ["op-b", "op-a"]
        );
        let touching = outbox::pending_touching_threads(&mut conn, "acct-1", &labels(&["t1"]))
            .await
            .unwrap();
        assert_eq!(touching.len(), 2);
        outbox::delete(&mut *conn, "op-b").await.unwrap();
        assert_eq!(count(&pool, "outbox_messages").await, 1);
    }
}
