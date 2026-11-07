//! Keeps the message cache from growing for as long as the app is used. Backfill caches
//! bodies for the last [`FULL_BODY_DAYS`] of mail, and opening older mail caches its body
//! too. Without a trim, every body ever cached would stay. So a periodic pass drops the
//! bodies of mail older than that window once they were downloaded more than
//! [`KEEP_OPENED_DAYS`] ago. Those messages go back to metadata only: lists, labels and
//! header search are unchanged, and opening one downloads its body again.
//!
//! SQLite reuses the freed pages for new mail rather than shrinking the file, so the
//! database stops growing instead of getting smaller.

use crate::db::{self, messages};
use crate::sync::engine::{now_ms, FULL_BODY_DAYS};
use sqlx::SqlitePool;
use std::time::Duration;

/// How long an older email's body stays cached after it was downloaded (usually opened).
pub const KEEP_OPENED_DAYS: i64 = 30;
/// How often a running app trims. Short enough that a laptop that sleeps a lot (the timer
/// doesn't advance while it sleeps) still trims about daily.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Messages per write transaction, so sync never waits long behind a trim.
const BATCH: i64 = 200;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Drop the bodies that are due at `now` (ms); returns how many messages were trimmed.
pub async fn trim(db: &SqlitePool, now: i64) -> anyhow::Result<u64> {
    let sent_before = now - FULL_BODY_DAYS * DAY_MS;
    let fetched_before = now - KEEP_OPENED_DAYS * DAY_MS;
    let mut total = 0;
    loop {
        let mut tx = db::begin_write(db).await?;
        let trimmed =
            messages::trim_old_bodies(&mut *tx, sent_before, fetched_before, BATCH).await?;
        tx.commit().await?;
        total += trimmed;
        if trimmed < BATCH as u64 {
            return Ok(total);
        }
    }
}

/// Trim at launch, then every [`INTERVAL`] while the app runs.
pub async fn run(db: SqlitePool) {
    loop {
        match trim(&db, now_ms()).await {
            Ok(0) => {}
            Ok(trimmed) => tracing::info!(trimmed, "dropped old cached email bodies"),
            Err(error) => tracing::warn!(%error, "couldn't trim old cached email bodies"),
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::messages::{
        get_message, set_body, unfetched_in_thread, upsert_message, DbMessage,
    };
    use crate::db::test_support::TestDb;

    const NOW: i64 = 1_800_000_000_000;

    fn message(id: &str, days_old: i64) -> DbMessage {
        DbMessage {
            id: id.into(),
            account_id: "a1".into(),
            thread_id: format!("t-{id}"),
            label_ids: Some(r#"["INBOX"]"#.into()),
            from_address: Some("sender@example.com".into()),
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: Some(format!("subject {id}")),
            snippet: Some("snippet".into()),
            body_html: Some("<p>zebra</p>".into()),
            body_text: Some("zebra".into()),
            date: Some(NOW - days_old * DAY_MS),
            size_estimate: None,
            has_attachment: 0,
            is_read: 1,
            is_starred: 0,
            raw_headers: Some("[]".into()),
            fully_fetched: 1,
            rfc822_message_id: None,
        }
    }

    async fn set_fetched(db: &TestDb, id: &str, days_ago: i64) {
        sqlx::query("UPDATE messages SET body_fetched_at = ? WHERE id = ?")
            .bind(NOW - days_ago * DAY_MS)
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
    }

    async fn has_body(db: &TestDb, id: &str) -> bool {
        let m = get_message(&db.pool, "a1", id).await.unwrap().unwrap();
        m.body_html.is_some() || m.body_text.is_some() || m.fully_fetched == 1
    }

    #[tokio::test]
    async fn drops_old_mail_bodies_not_downloaded_recently() {
        let db = TestDb::with_account("a1").await;
        // (id, message age, body downloaded this many days ago, body kept?)
        let cases = [
            ("old-stale", 400, 200, false),
            ("old-opened-recently", 400, 3, true),
            ("recent-mail", 20, 200, true),
            ("window-edge", FULL_BODY_DAYS - 1, 60, true),
        ];
        for (id, age, fetched, _) in cases {
            upsert_message(&db.pool, &message(id, age)).await.unwrap();
            set_fetched(&db, id, fetched).await;
        }

        assert_eq!(trim(&db.pool, NOW).await.unwrap(), 1);
        for (id, _, _, kept) in cases {
            assert_eq!(has_body(&db, id).await, kept, "{id}");
        }

        // The trimmed message keeps its metadata, and opening its thread fetches it again.
        let trimmed = get_message(&db.pool, "a1", "old-stale")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(trimmed.subject.as_deref(), Some("subject old-stale"));
        assert!(trimmed.raw_headers.is_none());
        assert_eq!(
            unfetched_in_thread(&db.pool, "a1", "t-old-stale")
                .await
                .unwrap(),
            vec!["old-stale".to_owned()]
        );
        // Running again finds nothing more to do.
        assert_eq!(trim(&db.pool, NOW).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn trimmed_bodies_leave_the_search_index() {
        let db = TestDb::with_account("a1").await;
        upsert_message(&db.pool, &message("m1", 400)).await.unwrap();
        set_fetched(&db, "m1", 200).await;
        let matches = |pool: SqlitePool| async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'body_text:zebra'",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        assert_eq!(matches(db.pool.clone()).await, 1);
        trim(&db.pool, NOW).await.unwrap();
        assert_eq!(matches(db.pool.clone()).await, 0);
    }

    #[tokio::test]
    async fn trims_in_batches_until_done() {
        let db = TestDb::with_account("a1").await;
        let count = BATCH * 2 + 7;
        for i in 0..count {
            let id = format!("m{i}");
            upsert_message(&db.pool, &message(&id, 400)).await.unwrap();
        }
        sqlx::query("UPDATE messages SET body_fetched_at = 0")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(trim(&db.pool, NOW).await.unwrap(), count as u64);
    }

    #[tokio::test]
    async fn downloading_a_body_restarts_its_clock() {
        let db = TestDb::with_account("a1").await;
        // Metadata only: no body, so nothing to trim and no download time.
        let mut meta = message("m1", 400);
        meta.fully_fetched = 0;
        meta.body_html = None;
        meta.body_text = None;
        meta.raw_headers = None;
        upsert_message(&db.pool, &meta).await.unwrap();
        let fetched_at = |pool: SqlitePool| async move {
            sqlx::query_scalar::<_, Option<i64>>(
                "SELECT body_fetched_at FROM messages WHERE id = 'm1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        assert_eq!(fetched_at(db.pool.clone()).await, None);

        // Opening it stores the body now.
        let before = now_ms();
        let mut conn = db.pool.acquire().await.unwrap();
        set_body(&mut conn, &message("m1", 400)).await.unwrap();
        drop(conn);
        let stamped = fetched_at(db.pool.clone()).await.unwrap();
        assert!(stamped >= before - 1000, "{stamped} < {before}");

        // A later metadata-only update keeps the body and its download time.
        upsert_message(&db.pool, &meta).await.unwrap();
        assert_eq!(fetched_at(db.pool.clone()).await, Some(stamped));
        assert!(has_body(&db, "m1").await);
    }
}
