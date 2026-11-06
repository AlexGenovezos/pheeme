//! Local search over cached mail (FTS5 `messages_fts`), and recent searches.

use crate::db::threads::{DbThread, ThreadCursor, ThreadPage};
use anyhow::Result;
use sqlx::SqlitePool;

/// Recent searches kept.
pub const RECENT_LIMIT: i64 = 20;

/// A search the cache can run; built from [`crate::search::LocalQuery`].
pub struct ThreadSearch<'a> {
    pub account_ids: &'a [String],
    pub fts: Option<&'a str>,
    /// One inner list per label condition, each listing the labels that satisfy it as
    /// `"<account id>\u{1f}<label id>"`. A message needs one label from every list.
    pub label_groups: &'a [Vec<String>],
    pub include_spam_trash: bool,
    pub has_attachment: bool,
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    pub after: Option<i64>,
    pub before: Option<i64>,
    pub larger: Option<i64>,
    pub smaller: Option<i64>,
    pub from_me: bool,
    pub to_me: bool,
    pub cursor: Option<&'a ThreadCursor>,
    pub limit: i64,
}

/// Separates account and label ids in [`ThreadSearch::label_groups`].
pub const LABEL_KEY_SEP: char = '\u{1f}';

struct Row {
    id: String,
    account_id: String,
    subject: Option<String>,
    snippet: Option<String>,
    history_id: Option<String>,
    last_message_date: Option<i64>,
    message_count: i64,
    unread_count: i64,
    has_attachment: i64,
    from_name: Option<String>,
    from_address: Option<String>,
    is_starred: i64,
    cursor_date: i64,
}

/// Threads with at least one message matching `s`, newest first, keyset-paged like
/// [`crate::db::threads::list_threads`].
///
/// Walks threads newest first and stops at a full page, so a broad search (the first letter
/// typed) costs a page of threads rather than every match: on a 228k-message mailbox, "g"
/// took 1.6 s when the matches were collected and sorted first. A search that matches
/// little still walks every thread, which costs about 0.1 s at that size.
pub async fn search_threads(pool: &SqlitePool, s: &ThreadSearch<'_>) -> Result<ThreadPage> {
    if s.limit <= 0 {
        anyhow::bail!("search limit must be positive");
    }
    let accounts = serde_json::to_string(s.account_ids)?;
    let label_groups = (!s.label_groups.is_empty())
        .then(|| serde_json::to_string(s.label_groups))
        .transpose()?;
    let include_spam_trash = i64::from(s.include_spam_trash);
    let has_attachment = i64::from(s.has_attachment);
    let is_read = s.unread.map(|u| i64::from(!u));
    let is_starred = s.starred.map(i64::from);
    let from_me = i64::from(s.from_me);
    let to_me = i64::from(s.to_me);
    let (c_date, c_account, c_thread) = match s.cursor {
        Some(c) => (
            Some(c.last_message_date),
            Some(c.account_id.as_str()),
            Some(c.thread_id.as_str()),
        ),
        None => (None, None, None),
    };
    let fetch = s.limit.saturating_add(1);
    let rows = sqlx::query_as!(
        Row,
        r#"
        SELECT t.id AS "id!", t.account_id AS "account_id!", t.subject, t.snippet,
               t.history_id, t.last_message_date, t.message_count AS "message_count!",
               t.unread_count AS "unread_count!", t.has_attachment AS "has_attachment!",
               t.from_name, t.from_address, t.is_starred AS "is_starred!",
               COALESCE(t.last_message_date, 0) AS "cursor_date!: i64"
        FROM threads t INDEXED BY idx_threads_all_date
        WHERE t.account_id IN (SELECT value FROM json_each(?1))
          AND (?14 IS NULL
               OR (COALESCE(t.last_message_date, 0), t.account_id, t.id) < (?14, ?15, ?16))
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.account_id = t.account_id AND m.thread_id = t.id
              -- The unary + keeps the FTS matches a lookup set built once per query. Without
              -- it SQLite drives this lookup from the matches, visiting every one per thread.
              AND (?2 IS NULL OR +m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?2))
              AND (?3 IS NULL OR NOT EXISTS (
                    SELECT 1 FROM json_each(?3) g
                    WHERE NOT EXISTS (
                      SELECT 1 FROM json_each(g.value) c, json_each(m.label_ids) l
                      WHERE c.value = m.account_id || char(31) || l.value)))
              AND (?4 OR NOT EXISTS (
                    SELECT 1 FROM json_each(m.label_ids) l WHERE l.value IN ('TRASH', 'SPAM')))
              AND (NOT ?5 OR m.has_attachment = 1)
              AND (?6 IS NULL OR m.is_read = ?6)
              AND (?7 IS NULL OR m.is_starred = ?7)
              AND (?8 IS NULL OR m.date >= ?8)
              AND (?9 IS NULL OR m.date < ?9)
              AND (?10 IS NULL OR m.size_estimate > ?10)
              AND (?11 IS NULL OR m.size_estimate < ?11)
              AND (NOT ?12 OR lower(m.from_address) =
                    (SELECT lower(a.email) FROM accounts a WHERE a.id = m.account_id))
              AND (NOT ?13 OR EXISTS (
                    SELECT 1 FROM accounts a, json_each(m.to_addresses) r
                    WHERE a.id = m.account_id
                      AND lower(json_extract(r.value, '$.address')) = lower(a.email)
                    UNION ALL
                    SELECT 1 FROM accounts a, json_each(m.cc_addresses) r
                    WHERE a.id = m.account_id
                      AND lower(json_extract(r.value, '$.address')) = lower(a.email))))
        ORDER BY COALESCE(t.last_message_date, 0) DESC, t.account_id DESC, t.id DESC
        LIMIT ?17
        "#,
        accounts,
        s.fts,
        label_groups,
        include_spam_trash,
        has_attachment,
        is_read,
        is_starred,
        s.after,
        s.before,
        s.larger,
        s.smaller,
        from_me,
        to_me,
        c_date,
        c_account,
        c_thread,
        fetch,
    )
    .fetch_all(pool)
    .await?;

    let mut rows = rows;
    let has_more = rows.len() as i64 > s.limit;
    rows.truncate(s.limit as usize);
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
            from_name: r.from_name,
            from_address: r.from_address,
            is_starred: r.is_starred,
        })
        .collect();
    Ok(ThreadPage { threads, next })
}

/// Remember a search (moving it to the top), keeping the newest [`RECENT_LIMIT`].
pub async fn add_recent(pool: &SqlitePool, query: &str, now_ms: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "INSERT INTO recent_searches (query, used_at) VALUES (?, ?)
         ON CONFLICT(query) DO UPDATE SET used_at = excluded.used_at",
        query,
        now_ms
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM recent_searches WHERE query NOT IN
           (SELECT query FROM recent_searches ORDER BY used_at DESC, rowid DESC LIMIT ?)",
        RECENT_LIMIT
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Newest first.
pub async fn list_recent(pool: &SqlitePool) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT query AS "query!" FROM recent_searches
           ORDER BY used_at DESC, rowid DESC LIMIT ?"#,
        RECENT_LIMIT
    )
    .fetch_all(pool)
    .await?)
}

/// Forget one search, or all of them when `query` is `None`.
pub async fn remove_recent(pool: &SqlitePool, query: Option<&str>) -> Result<()> {
    sqlx::query!(
        "DELETE FROM recent_searches WHERE ?1 IS NULL OR query = ?1",
        query
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::accounts::{self, DbAccount};
    use crate::db::messages::{self, DbMessage};
    use crate::db::threads;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        for id in ["a1", "a2"] {
            add_account(&pool, id).await;
        }
        pool
    }

    async fn add_account(pool: &SqlitePool, id: &str) {
        accounts::insert_account(
            pool,
            &DbAccount {
                id: id.into(),
                email: format!("{id}@example.com"),
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

    fn msg(account: &str, id: &str, thread: &str, date: i64, labels: &[&str]) -> DbMessage {
        DbMessage {
            id: id.into(),
            account_id: account.into(),
            thread_id: thread.into(),
            label_ids: Some(serde_json::to_string(labels).unwrap()),
            from_address: Some(format!("{id}@sender.test")),
            from_name: Some(format!("Sender {id}")),
            to_addresses: Some(r#"[{"name":null,"address":"bob@example.com"}]"#.into()),
            cc_addresses: Some("[]".into()),
            subject: Some(format!("subject {id}")),
            snippet: Some(String::new()),
            body_html: None,
            body_text: None,
            date: Some(date),
            size_estimate: Some(1000),
            has_attachment: 0,
            is_read: (!labels.contains(&"UNREAD")).into(),
            is_starred: labels.contains(&"STARRED").into(),
            raw_headers: None,
            fully_fetched: 0,
            rfc822_message_id: None,
        }
    }

    async fn put(pool: &SqlitePool, m: &DbMessage) {
        messages::upsert_message(pool, m).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        threads::recompute_threads(&mut conn, &m.account_id, std::slice::from_ref(&m.thread_id))
            .await
            .unwrap();
    }

    async fn fts_hits(pool: &SqlitePool, q: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
             WHERE messages_fts MATCH ? ORDER BY m.id",
        )
        .bind(q)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn integrity(pool: &SqlitePool) {
        sqlx::query("INSERT INTO messages_fts (messages_fts, rank) VALUES ('integrity-check', 1)")
            .execute(pool)
            .await
            .expect("index matches messages");
    }

    fn search<'a>(accounts: &'a [String]) -> ThreadSearch<'a> {
        ThreadSearch {
            account_ids: accounts,
            fts: None,
            label_groups: &[],
            include_spam_trash: false,
            has_attachment: false,
            unread: None,
            starred: None,
            after: None,
            before: None,
            larger: None,
            smaller: None,
            from_me: false,
            to_me: false,
            cursor: None,
            limit: 50,
        }
    }

    async fn ids(pool: &SqlitePool, s: &ThreadSearch<'_>) -> Vec<String> {
        search_threads(pool, s)
            .await
            .unwrap()
            .threads
            .into_iter()
            .map(|t| t.id)
            .collect()
    }

    #[tokio::test]
    async fn index_follows_message_writes() {
        let pool = pool().await;
        let mut m = msg("a1", "m1", "t1", 1, &["INBOX"]);
        m.subject = Some("Quarterly report".into());
        put(&pool, &m).await;
        assert_eq!(fts_hits(&pool, "quarterly").await, ["m1"]);
        assert_eq!(fts_hits(&pool, "recipients: bob").await, ["m1"]);
        assert!(
            fts_hits(&pool, "address OR name OR null").await.is_empty(),
            "JSON keys aren't indexed"
        );
        integrity(&pool).await;

        // Upsert with new text replaces the old terms.
        m.subject = Some("Annual summary".into());
        put(&pool, &m).await;
        assert!(fts_hits(&pool, "quarterly").await.is_empty());
        assert_eq!(fts_hits(&pool, "annual").await, ["m1"]);

        // Label-only changes leave the index alone; a body fetch adds the body.
        let mut conn = pool.acquire().await.unwrap();
        messages::set_labels(&mut conn, "a1", "m1", &["STARRED".into()])
            .await
            .unwrap();
        m.body_text = Some("the café menu".into());
        m.fully_fetched = 1;
        messages::set_body(&mut conn, &m).await.unwrap();
        drop(conn);
        assert_eq!(fts_hits(&pool, "cafe").await, ["m1"], "diacritics folded");
        integrity(&pool).await;

        // A metadata-only upsert keeps the cached body, and its index entry.
        let mut meta = m.clone();
        meta.body_text = None;
        meta.fully_fetched = 0;
        put(&pool, &meta).await;
        assert_eq!(fts_hits(&pool, "menu").await, ["m1"]);
        integrity(&pool).await;

        messages::delete_message(&pool, "a1", "m1").await.unwrap();
        assert!(fts_hits(&pool, "annual").await.is_empty());
        put(&pool, &msg("a2", "m2", "t2", 1, &["INBOX"])).await;
        accounts::delete_account(&pool, "a2").await.unwrap();
        assert!(
            fts_hits(&pool, "m2").await.is_empty(),
            "account removal cascades"
        );
        integrity(&pool).await;
    }

    #[tokio::test]
    async fn migration_indexes_mail_cached_before_it() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let all = sqlx::migrate!("src/db/migrations");
        let mut before = sqlx::migrate!("src/db/migrations");
        before.migrations = all
            .migrations
            .iter()
            .filter(|m| !m.description.contains("search"))
            .cloned()
            .collect::<Vec<_>>()
            .into();
        before.run(&pool).await.unwrap();
        add_account(&pool, "a1").await;
        messages::upsert_message(&pool, &msg("a1", "old", "t", 1, &["INBOX"]))
            .await
            .unwrap();
        all.run(&pool).await.unwrap();
        assert_eq!(fts_hits(&pool, "old").await, ["old"]);
        integrity(&pool).await;
    }

    #[tokio::test]
    async fn search_filters_and_pages() {
        let pool = pool().await;
        let mut starred = msg(
            "a1",
            "m1",
            "t1",
            10,
            &["INBOX", "UNREAD", "STARRED", "Label_1"],
        );
        starred.subject = Some("invoice March".into());
        put(&pool, &starred).await;
        let mut big = msg("a1", "m2", "t2", 20, &["INBOX"]);
        big.subject = Some("invoice April".into());
        big.size_estimate = Some(5_000_000);
        big.has_attachment = 1;
        put(&pool, &big).await;
        let mut trashed = msg("a1", "m3", "t3", 30, &["TRASH"]);
        trashed.subject = Some("invoice May".into());
        put(&pool, &trashed).await;
        let mut other = msg("a2", "m4", "t4", 40, &["INBOX", "Label_1"]);
        other.subject = Some("invoice June".into());
        other.from_address = Some("a2@example.com".into());
        put(&pool, &other).await;

        let both: Vec<String> = vec!["a1".into(), "a2".into()];
        let a1 = &both[..1];
        let fts = Some("\"invoice\"*");
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    fts,
                    ..search(&both)
                }
            )
            .await,
            ["t4", "t2", "t1"]
        );
        assert_eq!(
            ids(&pool, &ThreadSearch { fts, ..search(a1) }).await,
            ["t2", "t1"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    fts,
                    include_spam_trash: true,
                    ..search(a1)
                }
            )
            .await,
            ["t3", "t2", "t1"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    unread: Some(true),
                    ..search(&both)
                }
            )
            .await,
            ["t1"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    unread: Some(false),
                    ..search(a1)
                }
            )
            .await,
            ["t2"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    starred: Some(true),
                    ..search(&both)
                }
            )
            .await,
            ["t1"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    has_attachment: true,
                    ..search(&both)
                }
            )
            .await,
            ["t2"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    larger: Some(1_000_000),
                    ..search(&both)
                }
            )
            .await,
            ["t2"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    smaller: Some(2000),
                    ..search(a1)
                }
            )
            .await,
            ["t1"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    after: Some(15),
                    before: Some(40),
                    ..search(&both)
                }
            )
            .await,
            ["t2"]
        );
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    from_me: true,
                    ..search(&both)
                }
            )
            .await,
            ["t4"]
        );
        assert!(ids(
            &pool,
            &ThreadSearch {
                to_me: true,
                ..search(&both)
            }
        )
        .await
        .is_empty());

        // Label keys are per account: a1's Label_1 doesn't match a2's.
        let groups = vec![vec![format!("a1{LABEL_KEY_SEP}Label_1")]];
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    label_groups: &groups,
                    ..search(&both)
                }
            )
            .await,
            ["t1"]
        );
        let two = vec![
            vec![format!("a1{LABEL_KEY_SEP}INBOX")],
            vec![
                format!("a1{LABEL_KEY_SEP}Label_1"),
                format!("a2{LABEL_KEY_SEP}Label_1"),
            ],
        ];
        assert_eq!(
            ids(
                &pool,
                &ThreadSearch {
                    label_groups: &two,
                    ..search(&both)
                }
            )
            .await,
            ["t1"]
        );

        // Keyset paging.
        let first = search_threads(
            &pool,
            &ThreadSearch {
                fts,
                limit: 2,
                ..search(&both)
            },
        )
        .await
        .unwrap();
        assert_eq!(first.threads.len(), 2);
        let cursor = first.next.expect("more");
        let rest = ids(
            &pool,
            &ThreadSearch {
                fts,
                limit: 2,
                cursor: Some(&cursor),
                ..search(&both)
            },
        )
        .await;
        assert_eq!(rest, ["t1"]);
    }

    #[tokio::test]
    async fn recent_searches_keep_the_newest_twenty() {
        let pool = pool().await;
        for i in 0..22 {
            add_recent(&pool, &format!("q{i}"), i).await.unwrap();
        }
        let list = list_recent(&pool).await.unwrap();
        assert_eq!(list.len(), 20);
        assert_eq!((list[0].as_str(), list[19].as_str()), ("q21", "q2"));

        add_recent(&pool, "q5", 100).await.unwrap();
        assert_eq!(
            list_recent(&pool).await.unwrap()[0],
            "q5",
            "reuse moves it to the top"
        );
        assert_eq!(list_recent(&pool).await.unwrap().len(), 20);

        remove_recent(&pool, Some("q5")).await.unwrap();
        assert!(!list_recent(&pool)
            .await
            .unwrap()
            .contains(&"q5".to_string()));
        remove_recent(&pool, None).await.unwrap();
        assert!(list_recent(&pool).await.unwrap().is_empty());
    }
}
