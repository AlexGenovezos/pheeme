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
        for expected in ["accounts", "attachments", "labels", "messages", "threads"] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing table {expected}, got: {names:?}"
            );
        }
    }

    #[tokio::test]
    async fn accounts_cascade_deletes_children() {
        use accounts::{insert_account, DbAccount};
        use labels::{upsert_label, DbLabel};

        let pool = fresh_pool().await;

        insert_account(
            &pool,
            &DbAccount {
                id: "acct-1".into(),
                email: "test@example.com".into(),
                display_name: None,
                profile_photo_url: None,
                client_id: "client-1".into(),
                access_token_encrypted: None,
                refresh_token_encrypted: None,
                token_expiry: None,
                history_id: None,
                created_at: 0,
                updated_at: 0,
            },
        )
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

        sqlx::query!("DELETE FROM accounts WHERE id = ?", "acct-1")
            .execute(&pool)
            .await
            .unwrap();

        let remaining: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM labels")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining.0, 0, "labels should cascade on account delete");
    }
}
