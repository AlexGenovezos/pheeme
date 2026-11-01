pub mod accounts;
pub mod attachments;
pub mod labels;
pub mod messages;
pub mod threads;

use anyhow::Result;
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::path::Path;
use std::str::FromStr;
use tracing::info;

pub async fn init_db(data_dir: &Path) -> Result<SqlitePool> {
    tokio::fs::create_dir_all(data_dir).await?;

    let db_path = data_dir.join("db.sqlite");
    info!("Opening database at {}", db_path.display());

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePool::connect_with(options).await?;

    run_migrations(&pool).await?;

    Ok(pool)
}

async fn run_migrations(pool: &SqlitePool) -> Result<()> {
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
        let row: (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
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
        }
    }

    fn labels(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
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
}
