use super::*;
use crate::storage::test_key;

const SECRET: &str = "confidentialmailcanary";

fn assert_no_plaintext(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3\0"));
    assert!(!bytes.windows(SECRET.len()).any(|b| b == SECRET.as_bytes()));
}

#[tokio::test]
async fn database_and_wal_are_encrypted_and_every_connection_needs_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let key = test_key();
    let pool = init_db(dir.path(), &key).await.unwrap();
    sqlx::query("CREATE TABLE secret (body TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO secret VALUES (?)")
        .bind(SECRET)
        .execute(&pool)
        .await
        .unwrap();
    assert_no_plaintext(&path);
    assert_no_plaintext(&dir.path().join("db.sqlite-wal"));
    let mut first = pool.acquire().await.unwrap();
    let mut second = pool.acquire().await.unwrap();
    for connection in [&mut *first, &mut *second] {
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT body FROM secret")
                .fetch_one(connection)
                .await
                .unwrap(),
            SECRET
        );
    }
    drop(first);
    drop(second);
    pool.close().await;

    let unkeyed = SqliteConnectOptions::new().filename(&path).read_only(true);
    if let Ok(mut connection) = SqliteConnection::connect_with(&unkeyed).await {
        assert!(sqlx::query("SELECT * FROM secret")
            .fetch_all(&mut connection)
            .await
            .is_err());
    }
    let wrong = unkeyed.pragma("key", "'incorrect-key'");
    if let Ok(mut connection) = SqliteConnection::connect_with(&wrong).await {
        assert!(sqlx::query("SELECT * FROM secret")
            .fetch_all(&mut connection)
            .await
            .is_err());
    }
    let reopened = init_db(dir.path(), &key).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT body FROM secret")
            .fetch_one(&reopened)
            .await
            .unwrap(),
        SECRET
    );
    reopened.close().await;
}

#[tokio::test]
async fn migration_recovers_plaintext_wal_preserves_drafts_settings_and_search_rowids() {
    let legacy_dir = tempfile::tempdir().unwrap();
    let legacy_path = legacy_dir.path().join("db.sqlite");
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&legacy_path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .pragma("wal_autocheckpoint", "0"),
    )
    .await
    .unwrap();
    run_migrations(&pool).await.unwrap();
    accounts::insert_account(
        &pool,
        &accounts::DbAccount {
            id: "a".into(),
            email: "private@example.com".into(),
            display_name: None,
            profile_photo_url: None,
            client_id: "client".into(),
            history_id: None,
            created_at: 0,
            updated_at: 0,
        },
    )
    .await
    .unwrap();
    // Gaps in implicit rowids exercise FTS rebuilding after SQLCipher export.
    for (rowid, id, body) in [
        (3, "draft", SECRET),
        (7, "message", "searchablemailcontent"),
    ] {
        sqlx::query("INSERT INTO messages (rowid,id,account_id,thread_id,body_text,label_ids,fully_fetched) VALUES (?,?, 'a', ?, ?, ?, 1)")
            .bind(rowid).bind(id).bind(id).bind(body).bind(if id == "draft" { "[\"DRAFT\"]" } else { "[\"INBOX\"]" })
            .execute(&pool).await.unwrap();
    }
    settings::set_telemetry(&pool, false).await.unwrap();
    // Copy just main+WAL to model a terminated old app with uncheckpointed mail.
    let dir = tempfile::tempdir().unwrap();
    for file in ["db.sqlite", "db.sqlite-wal"] {
        std::fs::copy(legacy_dir.path().join(file), dir.path().join(file)).unwrap();
    }
    pool.close().await;
    std::fs::write(
        dir.path().join("db.sqlite.encrypted"),
        b"interrupted export",
    )
    .unwrap();
    let key = test_key();
    let migrated = init_db(dir.path(), &key).await.unwrap();
    let bodies: Vec<String> = sqlx::query_scalar("SELECT body_text FROM messages ORDER BY id")
        .fetch_all(&migrated)
        .await
        .unwrap();
    assert_eq!(bodies, [SECRET, "searchablemailcontent"]);
    assert!(!settings::telemetry(&migrated).await.unwrap());
    let hits: Vec<String> = sqlx::query_scalar("SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH 'searchablemailcontent'")
        .fetch_all(&migrated).await.unwrap();
    assert_eq!(hits, ["message"]);
    // Migrated triggers remain live, rather than leaving a snapshot-only search index.
    sqlx::query("UPDATE messages SET body_text = 'updatedsearchcontent' WHERE id = 'draft'")
        .execute(&migrated)
        .await
        .unwrap();
    let hit: String = sqlx::query_scalar("SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH 'updatedsearchcontent'")
        .fetch_one(&migrated).await.unwrap();
    assert_eq!(hit, "draft");
    assert_no_plaintext(&dir.path().join("db.sqlite"));
    assert_no_plaintext(&dir.path().join("db.sqlite-wal"));
    assert!(!dir.path().join("db.sqlite.encrypted").exists());
    migrated.close().await;
    assert!(!dir.path().join("db.sqlite-wal").exists());
    let reopened = init_db(dir.path(), &key).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM messages")
            .fetch_one(&reopened)
            .await
            .unwrap(),
        2
    );
    reopened.close().await;
}

#[tokio::test]
async fn failed_verification_leaves_original_readable_and_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let mut plain = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(false),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1);")
        .execute(&mut plain).await.unwrap();
    plain.close().await.unwrap();
    assert!(init_db(dir.path(), &test_key()).await.is_err());
    assert!(crate::storage::is_plaintext_database(&path).unwrap());
    let mut plain = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM child")
            .fetch_one(&mut plain)
            .await
            .unwrap(),
        1
    );
    sqlx::query("INSERT INTO parent VALUES (1)")
        .execute(&mut plain)
        .await
        .unwrap();
    plain.close().await.unwrap();
    let pool = init_db(dir.path(), &test_key()).await.unwrap();
    assert!(!crate::storage::is_plaintext_database(&path).unwrap());
    pool.close().await;
}

/// Without the planner stability guarantee, SQLite 3.47+ prepares a statement again on every
/// run when it binds `LIMIT ?` (each list page paid a full recompile).
#[tokio::test]
async fn every_connection_pins_its_query_plans() {
    let dir = tempfile::tempdir().unwrap();
    let pool = init_db(dir.path(), &test_key()).await.unwrap();
    let mut first = pool.acquire().await.unwrap();
    let mut second = pool.acquire().await.unwrap();
    for connection in [&mut *first, &mut *second] {
        let mut handle = connection.lock_handle().await.unwrap();
        let mut on: std::ffi::c_int = -1;
        // SAFETY: a live connection handle; -1 reads the setting into `on`.
        let rc = unsafe {
            libsqlite3_sys::sqlite3_db_config(
                handle.as_raw_handle().as_ptr(),
                libsqlite3_sys::SQLITE_DBCONFIG_ENABLE_QPSG,
                -1 as std::ffi::c_int,
                &mut on as *mut std::ffi::c_int,
            )
        };
        assert_eq!(rc, libsqlite3_sys::SQLITE_OK);
        assert_eq!(on, 1);
    }
}
