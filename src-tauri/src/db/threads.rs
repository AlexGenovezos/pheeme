use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbThread {
    pub id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub history_id: Option<String>,
    pub last_message_date: Option<i64>,
    pub message_count: i64,
    pub unread_count: i64,
    pub has_attachment: i64,
}

/// Upserts the thread row and replaces its label set (`thread_labels`) in one
/// transaction. Never use `INSERT OR REPLACE` on `threads`: the implicit delete
/// would cascade away the thread's `thread_labels` rows.
pub async fn upsert_thread(
    pool: &SqlitePool,
    thread: &DbThread,
    label_ids: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query!(
        r#"
        INSERT INTO threads (
            id, account_id, subject, snippet, history_id,
            last_message_date, message_count, unread_count, has_attachment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            subject = excluded.subject,
            snippet = excluded.snippet,
            history_id = excluded.history_id,
            last_message_date = excluded.last_message_date,
            message_count = excluded.message_count,
            unread_count = excluded.unread_count,
            has_attachment = excluded.has_attachment
        "#,
        thread.id,
        thread.account_id,
        thread.subject,
        thread.snippet,
        thread.history_id,
        thread.last_message_date,
        thread.message_count,
        thread.unread_count,
        thread.has_attachment,
    )
    .execute(&mut *tx)
    .await?;

    replace_thread_labels(
        &mut tx,
        &thread.account_id,
        &thread.id,
        thread.last_message_date,
        label_ids,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Deletes and re-inserts the thread's label rows inside the caller's
/// transaction, stamping each with the thread's `last_message_date`.
async fn replace_thread_labels(
    tx: &mut sqlx::SqliteConnection,
    account_id: &str,
    thread_id: &str,
    last_message_date: Option<i64>,
    label_ids: &[String],
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?",
        account_id,
        thread_id
    )
    .execute(&mut *tx)
    .await?;

    for label_id in label_ids {
        sqlx::query!(
            r#"
            INSERT INTO thread_labels (account_id, thread_id, label_id, last_message_date)
            VALUES (?, ?, ?, COALESCE(?, 0))
            ON CONFLICT(account_id, thread_id, label_id) DO NOTHING
            "#,
            account_id,
            thread_id,
            label_id,
            last_message_date
        )
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

pub async fn get_thread(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<Option<DbThread>> {
    let thread = sqlx::query_as!(
        DbThread,
        r#"
        SELECT id, account_id, subject, snippet, history_id,
               last_message_date, message_count, unread_count, has_attachment
        FROM threads WHERE account_id = ? AND id = ?
        "#,
        account_id,
        thread_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(thread)
}

pub async fn delete_thread(pool: &SqlitePool, account_id: &str, thread_id: &str) -> Result<()> {
    sqlx::query!(
        "DELETE FROM threads WHERE account_id = ? AND id = ?",
        account_id,
        thread_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Replaces the thread's label set, keeping each row's `last_message_date`
/// in step with the thread. A no-op for a thread that doesn't exist.
pub async fn update_thread_labels(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
    label_ids: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        "SELECT last_message_date FROM threads WHERE account_id = ? AND id = ?",
        account_id,
        thread_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = row {
        replace_thread_labels(
            &mut tx,
            account_id,
            thread_id,
            row.last_message_date,
            label_ids,
        )
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Label ids of a thread, sorted ascending.
pub async fn get_thread_label_ids(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<String>> {
    let rows = sqlx::query!(
        r#"
        SELECT label_id FROM thread_labels
        WHERE account_id = ? AND thread_id = ?
        ORDER BY label_id ASC
        "#,
        account_id,
        thread_id
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.label_id).collect())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadCursor {
    pub last_message_date: i64,
    pub account_id: String,
    pub thread_id: String,
}

pub struct ThreadQuery<'a> {
    /// One id is a per-account view; all ids is All Inboxes.
    pub account_ids: &'a [String],
    /// Drives the index, e.g. "INBOX" or "CATEGORY_PRIMARY".
    pub label_id: &'a str,
    /// Intersection, e.g. Primary tab = CATEGORY_PRIMARY + INBOX.
    pub also_label_id: Option<&'a str>,
    pub before: Option<&'a ThreadCursor>,
    pub limit: i64,
}

pub struct ThreadPage {
    pub threads: Vec<DbThread>,
    /// `Some` only when the page is full, i.e. there may be more rows.
    pub next: Option<ThreadCursor>,
}

struct ThreadRow {
    id: String,
    account_id: String,
    subject: Option<String>,
    snippet: Option<String>,
    history_id: Option<String>,
    last_message_date: Option<i64>,
    message_count: i64,
    unread_count: i64,
    has_attachment: i64,
    cursor_date: i64,
}

/// Lists threads newest first (`last_message_date DESC, account_id DESC,
/// thread_id DESC`) straight off `idx_thread_labels_listing`, paged by keyset.
pub async fn list_threads(pool: &SqlitePool, q: &ThreadQuery<'_>) -> Result<ThreadPage> {
    let page_limit: usize = q
        .limit
        .try_into()
        .map_err(|_| anyhow::anyhow!("thread list limit must be positive"))?;
    if page_limit == 0 {
        anyhow::bail!("thread list limit must be positive");
    }
    let fetch_limit = q.limit.saturating_add(1);

    let account_ids = serde_json::to_string(q.account_ids)?;

    // Two queries rather than `?3 IS NULL OR (...) < (...)`: the plain row-value
    // comparison lets SQLite seek into `idx_thread_labels_listing` at the cursor.
    let rows = match q.before {
        None => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?3))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?4
        "#,
                q.label_id,
                account_ids,
                q.also_label_id,
                fetch_limit,
            )
            .fetch_all(pool)
            .await?
        }
        Some(c) => {
            sqlx::query_as!(
                ThreadRow,
                r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               tl.last_message_date AS "cursor_date!"
        FROM thread_labels tl
        JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
        WHERE tl.label_id = ?1
          AND tl.account_id IN (SELECT value FROM json_each(?2))
          AND (tl.last_message_date, tl.account_id, tl.thread_id) < (?3, ?4, ?5)
          AND (?6 IS NULL OR EXISTS (
                SELECT 1 FROM thread_labels x
                WHERE x.account_id = tl.account_id AND x.thread_id = tl.thread_id
                  AND x.label_id = ?6))
        ORDER BY tl.last_message_date DESC, tl.account_id DESC, tl.thread_id DESC
        LIMIT ?7
        "#,
                q.label_id,
                account_ids,
                c.last_message_date,
                c.account_id,
                c.thread_id,
                q.also_label_id,
                fetch_limit,
            )
            .fetch_all(pool)
            .await?
        }
    };

    let has_more = rows.len() > page_limit;
    let mut rows = rows;
    if has_more {
        rows.truncate(page_limit);
    }

    let next = if has_more {
        rows.last().map(|r| ThreadCursor {
            last_message_date: r.cursor_date,
            account_id: r.account_id.clone(),
            thread_id: r.id.clone(),
        })
    } else {
        None
    };
    let threads = rows
        .into_iter()
        .map(|r| DbThread {
            id: r.id,
            account_id: r.account_id,
            subject: r.subject,
            snippet: r.snippet,
            history_id: r.history_id,
            last_message_date: r.last_message_date,
            message_count: r.message_count,
            unread_count: r.unread_count,
            has_attachment: r.has_attachment,
        })
        .collect();
    Ok(ThreadPage { threads, next })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::accounts::{insert_account, DbAccount};
    use sqlx::sqlite::SqlitePoolOptions;

    fn labels(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn account(id: &str) -> DbAccount {
        DbAccount {
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

    fn thread(account_id: &str, id: &str, date: Option<i64>) -> DbThread {
        DbThread {
            id: id.into(),
            account_id: account_id.into(),
            subject: None,
            snippet: None,
            history_id: None,
            last_message_date: date,
            message_count: 1,
            unread_count: 0,
            has_attachment: 0,
        }
    }

    /// In-memory pool with accounts `a1` and `a2`.
    async fn seeded_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        for id in ["a1", "a2"] {
            insert_account(&pool, &account(id)).await.unwrap();
        }
        pool
    }

    async fn seed(pool: &SqlitePool, account_id: &str, id: &str, date: Option<i64>, l: &[&str]) {
        upsert_thread(pool, &thread(account_id, id, date), &labels(l))
            .await
            .unwrap();
    }

    fn query<'a>(
        account_ids: &'a [String],
        before: Option<&'a ThreadCursor>,
        limit: i64,
    ) -> ThreadQuery<'a> {
        ThreadQuery {
            account_ids,
            label_id: "INBOX",
            also_label_id: None,
            before,
            limit,
        }
    }

    #[tokio::test]
    async fn list_threads_orders_newest_first_across_accounts() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(300), &["INBOX"]).await;
        seed(&pool, "a1", "t2", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t3", Some(200), &["INBOX"]).await;

        let accounts = labels(&["a1", "a2"]);
        let page = list_threads(&pool, &query(&accounts, None, 50))
            .await
            .unwrap();

        let dates: Vec<_> = page.threads.iter().map(|t| t.last_message_date).collect();
        assert_eq!(dates, vec![Some(300), Some(200), Some(100)]);
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn list_threads_same_thread_id_in_two_accounts() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t1", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1", "a2"]);
        let first = list_threads(&pool, &query(&accounts, None, 1))
            .await
            .unwrap();
        assert_eq!(first.threads.len(), 1);
        let cursor = first.next.clone().expect("full page has a cursor");
        let second = list_threads(&pool, &query(&accounts, Some(&cursor), 1))
            .await
            .unwrap();
        assert_eq!(second.threads.len(), 1);

        let mut seen: Vec<_> = first
            .threads
            .iter()
            .chain(&second.threads)
            .map(|t| (t.account_id.clone(), t.id.clone()))
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![("a1".into(), "t1".into()), ("a2".into(), "t1".into())]
        );
    }

    #[tokio::test]
    async fn list_threads_keyset_pages_ties_without_gaps() {
        let pool = seeded_pool().await;
        for i in 0..25 {
            seed(&pool, "a1", &format!("t{i:02}"), Some(500), &["INBOX"]).await;
        }

        let accounts = labels(&["a1"]);
        let mut sizes = vec![];
        let mut all = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        loop {
            let page = list_threads(&pool, &query(&accounts, cursor.as_ref(), 10))
                .await
                .unwrap();
            sizes.push(page.threads.len());
            all.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(sizes, vec![10, 10, 5]);
        let mut unique = all.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 25);
        assert_eq!(all.len(), 25);
    }

    #[tokio::test]
    async fn list_threads_includes_undated_threads_last() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 2))
            .await
            .unwrap();

        let order: Vec<_> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(order, vec!["dated", "undated"]);
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn list_threads_cursor_for_undated_row_uses_zero_date() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated-a", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-b", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 2))
            .await
            .unwrap();

        assert_eq!(page.threads.len(), 2);
        assert_eq!(page.threads[0].id, "dated");
        assert_eq!(page.next.as_ref().map(|c| c.last_message_date), Some(0));
    }

    #[tokio::test]
    async fn list_threads_pages_through_undated_threads() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "undated-a", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-b", None, &["INBOX"]).await;
        seed(&pool, "a1", "undated-c", None, &["INBOX"]).await;
        seed(&pool, "a1", "dated", Some(100), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let mut seen = vec![];
        let mut cursor: Option<ThreadCursor> = None;
        let mut pages = 0;
        loop {
            let page = list_threads(&pool, &query(&accounts, cursor.as_ref(), 1))
                .await
                .unwrap();
            pages += 1;
            assert!(pages <= 4, "paging did not terminate");
            seen.extend(page.threads.into_iter().map(|t| t.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(seen, vec!["dated", "undated-c", "undated-b", "undated-a"]);
    }

    #[tokio::test]
    async fn list_threads_includes_maximum_timestamp_on_first_page() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "max", Some(i64::MAX), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 1))
            .await
            .unwrap();

        assert_eq!(
            page.threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["max"]
        );
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn list_threads_rejects_non_positive_limit() {
        let pool = seeded_pool().await;
        let accounts = labels(&["a1"]);

        let error = match list_threads(&pool, &query(&accounts, None, 0)).await {
            Ok(_) => panic!("zero limit should be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("limit must be positive"));
    }

    #[tokio::test]
    async fn list_threads_intersects_also_label() {
        let pool = seeded_pool().await;
        seed(
            &pool,
            "a1",
            "inbox",
            Some(200),
            &["INBOX", "CATEGORY_PRIMARY"],
        )
        .await;
        seed(&pool, "a1", "archived", Some(300), &["CATEGORY_PRIMARY"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(
            &pool,
            &ThreadQuery {
                account_ids: &accounts,
                label_id: "CATEGORY_PRIMARY",
                also_label_id: Some("INBOX"),
                before: None,
                limit: 50,
            },
        )
        .await
        .unwrap();

        let order: Vec<_> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(order, vec!["inbox"]);
    }

    #[tokio::test]
    async fn list_threads_respects_account_filter() {
        let pool = seeded_pool().await;
        seed(&pool, "a1", "t1", Some(100), &["INBOX"]).await;
        seed(&pool, "a2", "t2", Some(200), &["INBOX"]).await;

        let accounts = labels(&["a1"]);
        let page = list_threads(&pool, &query(&accounts, None, 50))
            .await
            .unwrap();

        assert!(page.threads.iter().all(|t| t.account_id == "a1"));
        assert_eq!(page.threads.len(), 1);
    }
}
