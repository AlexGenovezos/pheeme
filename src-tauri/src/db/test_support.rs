//! A throwaway on-disk database for tests, opened and migrated the way production does
//! ([`super::init_db`]). The directory is deleted when the [`TestDb`] is dropped.

use super::accounts::{insert_account, DbAccount};
use sqlx::SqlitePool;
use std::path::Path;

pub(crate) struct TestDb {
    dir: tempfile::TempDir,
    pub pool: SqlitePool,
}

impl TestDb {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = super::init_db(dir.path()).await.unwrap();
        Self { dir, pool }
    }

    /// [`TestDb::new`] with one account, `me@example.com`.
    pub async fn with_account(id: &str) -> Self {
        let db = Self::new().await;
        insert_account(
            &db.pool,
            &DbAccount {
                id: id.into(),
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
        db
    }

    /// The data directory, to reopen the database as after a restart.
    pub fn dir(&self) -> &Path {
        self.dir.path()
    }
}
