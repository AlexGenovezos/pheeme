use crate::db::{messages, outbox};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbLabel {
    pub id: String,
    pub account_id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    pub label_type: String,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
    pub color_background: Option<String>,
    pub color_text: Option<String>,
    pub messages_total: i64,
    pub messages_unread: i64,
    pub threads_total: i64,
    pub threads_unread: i64,
}

/// Insert or update a label's identity and appearance. Counters are only written on insert;
/// `update_counts` owns them afterwards (`labels.list` doesn't return counters).
pub async fn upsert_label_tx(conn: &mut SqliteConnection, label: &DbLabel) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO labels (
            id, account_id, name, type,
            message_list_visibility, label_list_visibility,
            color_background, color_text,
            messages_total, messages_unread, threads_total, threads_unread
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, account_id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            message_list_visibility = excluded.message_list_visibility,
            label_list_visibility = excluded.label_list_visibility,
            color_background = excluded.color_background,
            color_text = excluded.color_text
        "#,
        label.id,
        label.account_id,
        label.name,
        label.label_type,
        label.message_list_visibility,
        label.label_list_visibility,
        label.color_background,
        label.color_text,
        label.messages_total,
        label.messages_unread,
        label.threads_total,
        label.threads_unread,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_label(pool: &SqlitePool, label: &DbLabel) -> Result<()> {
    let mut conn = pool.acquire().await?;
    upsert_label_tx(&mut conn, label).await
}

/// Make the account's labels exactly `labels`: upsert each, purge the rest from the cache.
/// Returns the threads that lost a label, for the caller to recompute in the same transaction.
pub async fn replace_labels(
    conn: &mut SqliteConnection,
    account_id: &str,
    labels: &[DbLabel],
) -> Result<Vec<String>> {
    for label in labels {
        upsert_label_tx(conn, label).await?;
    }
    let keep = serde_json::to_string(&labels.iter().map(|l| &l.id).collect::<Vec<_>>())?;
    let dropped = sqlx::query_scalar!(
        r#"SELECT id AS "id!" FROM labels
           WHERE account_id = ? AND id NOT IN (SELECT value FROM json_each(?))"#,
        account_id,
        keep
    )
    .fetch_all(&mut *conn)
    .await?;
    purge_labels(conn, account_id, &dropped).await
}

/// Remove deleted labels from everything cached: each message's `label_ids`, the `add`/`remove`
/// of pending modify ops (an op left with neither is deleted), the rollback labels of op
/// messages, and the `labels` rows. Returns the affected thread ids; the caller recomputes
/// them in the same transaction.
pub async fn purge_labels(
    conn: &mut SqliteConnection,
    account_id: &str,
    label_ids: &[String],
) -> Result<Vec<String>> {
    if label_ids.is_empty() {
        return Ok(Vec::new());
    }
    let gone = serde_json::to_string(label_ids)?;

    let affected = sqlx::query!(
        r#"SELECT id AS "id!", thread_id AS "thread_id!", label_ids FROM messages
           WHERE account_id = ?1 AND EXISTS (
               SELECT 1 FROM json_each(messages.label_ids)
               WHERE value IN (SELECT value FROM json_each(?2)))"#,
        account_id,
        gone
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut thread_ids = BTreeSet::new();
    for row in affected {
        let mut labels = messages::parse_labels(row.label_ids.as_deref());
        labels.retain(|l| !label_ids.contains(l));
        messages::set_labels(conn, account_id, &row.id, &labels).await?;
        thread_ids.insert(row.thread_id);
    }

    let ops = sqlx::query!(
        r#"SELECT id, payload FROM outbox
           WHERE account_id = ? AND status = 'pending' AND kind = 'modify'"#,
        account_id
    )
    .fetch_all(&mut *conn)
    .await?;
    for op in ops {
        let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&op.payload) else {
            continue;
        };
        let mut changed = false;
        for key in ["add", "remove"] {
            if let Some(list) = payload.get_mut(key).and_then(|v| v.as_array_mut()) {
                let before = list.len();
                list.retain(|v| v.as_str().is_none_or(|s| !label_ids.iter().any(|l| l == s)));
                changed |= list.len() != before;
            }
        }
        if !changed {
            continue;
        }
        let empty = |key: &str| {
            payload
                .get(key)
                .and_then(|v| v.as_array())
                .is_none_or(|a| a.is_empty())
        };
        if empty("add") && empty("remove") {
            outbox::delete(&mut *conn, &op.id).await?;
        } else {
            let json = serde_json::to_string(&payload)?;
            sqlx::query!("UPDATE outbox SET payload = ? WHERE id = ?", json, op.id)
                .execute(&mut *conn)
                .await?;
        }
    }

    sqlx::query!(
        r#"UPDATE outbox_messages
           SET prior_label_ids = (SELECT json_group_array(value) FROM json_each(prior_label_ids)
                                  WHERE value NOT IN (SELECT value FROM json_each(?1)))
           WHERE account_id = ?2 AND EXISTS (
               SELECT 1 FROM json_each(outbox_messages.prior_label_ids)
               WHERE value IN (SELECT value FROM json_each(?1)))"#,
        gone,
        account_id
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query!(
        "DELETE FROM labels WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))",
        account_id,
        gone
    )
    .execute(&mut *conn)
    .await?;
    Ok(thread_ids.into_iter().collect())
}

/// The user labels on each `(account id, thread id)` of `rows`, as label ids sorted by label
/// name, in one query. Threads with no user label are absent from the map.
pub async fn user_label_ids_for<'e>(
    ex: impl SqliteExecutor<'e>,
    rows: &[(String, String)],
) -> Result<HashMap<(String, String), Vec<String>>> {
    let mut out: HashMap<(String, String), Vec<String>> = HashMap::new();
    if rows.is_empty() {
        return Ok(out);
    }
    let pairs = serde_json::to_string(rows)?;
    let found = sqlx::query!(
        r#"SELECT tl.account_id AS "account_id!", tl.thread_id AS "thread_id!",
                  tl.label_id AS "label_id!"
           FROM json_each(?) p
           JOIN thread_labels tl ON tl.account_id = p.value ->> 0 AND tl.thread_id = p.value ->> 1
           JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id
           WHERE l.type = 'user'
           ORDER BY l.name, l.id"#,
        pairs
    )
    .fetch_all(ex)
    .await?;
    for r in found {
        out.entry((r.account_id, r.thread_id))
            .or_default()
            .push(r.label_id);
    }
    Ok(out)
}

pub async fn update_counts(
    conn: &mut SqliteConnection,
    account_id: &str,
    label_id: &str,
    counts: LabelCounts,
) -> Result<()> {
    sqlx::query!(
        r#"UPDATE labels SET messages_total = ?, messages_unread = ?, threads_total = ?, threads_unread = ?
           WHERE account_id = ? AND id = ?"#,
        counts.messages_total,
        counts.messages_unread,
        counts.threads_total,
        counts.threads_unread,
        account_id,
        label_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LabelCounts {
    pub messages_total: i64,
    pub messages_unread: i64,
    pub threads_total: i64,
    pub threads_unread: i64,
}

pub async fn get_labels<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<Vec<DbLabel>> {
    let labels = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread,
           threads_total, threads_unread
           FROM labels WHERE account_id = ? ORDER BY name"#,
        account_id
    )
    .fetch_all(ex)
    .await?;
    Ok(labels)
}

pub async fn get_label<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    label_id: &str,
) -> Result<Option<DbLabel>> {
    let label = sqlx::query_as!(
        DbLabel,
        r#"SELECT id, account_id, name, type as label_type,
           message_list_visibility, label_list_visibility,
           color_background, color_text, messages_total, messages_unread,
           threads_total, threads_unread
           FROM labels WHERE account_id = ? AND id = ?"#,
        account_id,
        label_id
    )
    .fetch_optional(ex)
    .await?;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::outbox::{DbOp, DbOpMessage};
    use crate::db::test_support::TestDb;
    use crate::db::threads;

    const A: &str = "acct-1";

    fn label(id: &str, name: &str, kind: &str) -> DbLabel {
        DbLabel {
            id: id.into(),
            account_id: A.into(),
            name: name.into(),
            label_type: kind.into(),
            message_list_visibility: None,
            label_list_visibility: None,
            color_background: None,
            color_text: None,
            messages_total: 0,
            messages_unread: 0,
            threads_total: 0,
            threads_unread: 0,
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    async fn put_message(db: &TestDb, id: &str, thread: &str, labels: &[&str]) {
        let m = messages::DbMessage {
            id: id.into(),
            account_id: A.into(),
            thread_id: thread.into(),
            label_ids: Some(serde_json::to_string(labels).unwrap()),
            from_address: None,
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: None,
            date: Some(1),
            size_estimate: None,
            has_attachment: 0,
            is_read: 1,
            is_starred: 0,
            raw_headers: None,
            fully_fetched: 0,
            rfc822_message_id: None,
        };
        messages::upsert_message(&db.pool, &m).await.unwrap();
    }

    async fn seed(db: &TestDb, thread_labels: &[&[&str]]) {
        let mut conn = db.pool.acquire().await.unwrap();
        for l in [
            label("INBOX", "INBOX", "system"),
            label("Label_1", "a", "user"),
            label("Label_2", "b", "user"),
        ] {
            upsert_label_tx(&mut conn, &l).await.unwrap();
        }
        drop(conn);
        for (i, labels) in thread_labels.iter().enumerate() {
            put_message(db, &format!("m{i}"), "t1", labels).await;
        }
        let mut conn = db.pool.acquire().await.unwrap();
        threads::recompute_threads(&mut conn, A, &ids(&["t1"]))
            .await
            .unwrap();
    }

    async fn thread_label_ids(db: &TestDb) -> Vec<String> {
        sqlx::query_scalar("SELECT label_id FROM thread_labels WHERE thread_id = 't1' ORDER BY 1")
            .fetch_all(&db.pool)
            .await
            .unwrap()
    }

    async fn queue(db: &TestDb, op_id: &str, payload: &str, status: &str, prior: &str) {
        let op = DbOp {
            seq: 0,
            id: op_id.into(),
            account_id: A.into(),
            kind: "modify".into(),
            payload: payload.into(),
            status: status.into(),
            attempts: 0,
            next_attempt_at: 0,
            checks_done: 0,
            rfc822_message_id: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        let target = DbOpMessage {
            op_id: op_id.into(),
            account_id: A.into(),
            message_id: "m0".into(),
            thread_id: "t1".into(),
            prior_label_ids: prior.into(),
        };
        let mut conn = db.pool.acquire().await.unwrap();
        outbox::insert(&mut conn, &op, &[target]).await.unwrap();
    }

    #[tokio::test]
    async fn purge_strips_messages_and_recomputes() {
        let db = TestDb::with_account(A).await;
        seed(&db, &[&["INBOX", "Label_1"], &["INBOX", "Label_1"]]).await;
        assert_eq!(thread_label_ids(&db).await, ["INBOX", "Label_1"]);

        let mut conn = db.pool.acquire().await.unwrap();
        let affected = purge_labels(&mut conn, A, &ids(&["Label_1"]))
            .await
            .unwrap();
        assert_eq!(affected, ["t1"]);
        threads::recompute_threads(&mut conn, A, &affected)
            .await
            .unwrap();
        drop(conn);

        for id in ["m0", "m1"] {
            let m = messages::get_message(&db.pool, A, id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(m.labels(), ["INBOX"]);
        }
        assert_eq!(thread_label_ids(&db).await, ["INBOX"]);
        let remaining: Vec<String> = get_labels(&db.pool, A)
            .await
            .unwrap()
            .into_iter()
            .map(|l| l.id)
            .collect();
        assert_eq!(remaining, ["INBOX", "Label_2"]);
    }

    #[tokio::test]
    async fn purge_scrubs_pending_ops() {
        let db = TestDb::with_account(A).await;
        seed(&db, &[&["INBOX"]]).await;
        queue(
            &db,
            "only",
            r#"{"thread_ids":["t1"],"add":["Label_1"]}"#,
            "pending",
            r#"["INBOX","Label_1"]"#,
        )
        .await;
        queue(
            &db,
            "mixed",
            r#"{"thread_ids":["t1"],"add":["Label_1","STARRED"]}"#,
            "pending",
            r#"["INBOX","Label_1"]"#,
        )
        .await;
        queue(
            &db,
            "failed",
            r#"{"thread_ids":["t1"],"add":["Label_1"]}"#,
            "failed",
            "[]",
        )
        .await;

        let mut conn = db.pool.acquire().await.unwrap();
        purge_labels(&mut conn, A, &ids(&["Label_1"]))
            .await
            .unwrap();

        assert!(outbox::get(&mut *conn, "only").await.unwrap().is_none());
        let mixed = outbox::get(&mut *conn, "mixed").await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&mixed.payload).unwrap();
        assert_eq!(payload["add"], serde_json::json!(["STARRED"]));
        assert_eq!(payload["thread_ids"], serde_json::json!(["t1"]));
        let prior = outbox::messages_of(&mut *conn, "mixed").await.unwrap();
        assert_eq!(prior[0].prior_label_ids, r#"["INBOX"]"#);
        assert!(outbox::get(&mut *conn, "failed").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn replace_labels_purges_dropped() {
        let db = TestDb::with_account(A).await;
        seed(&db, &[&["INBOX", "Label_1", "Label_2"]]).await;
        let mut conn = db.pool.acquire().await.unwrap();
        let keep = [
            label("INBOX", "INBOX", "system"),
            label("Label_1", "a", "user"),
        ];
        let affected = replace_labels(&mut conn, A, &keep).await.unwrap();
        assert_eq!(affected, ["t1"]);
        drop(conn);
        let m = messages::get_message(&db.pool, A, "m0")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(m.labels(), ["INBOX", "Label_1"]);

        let mut conn = db.pool.acquire().await.unwrap();
        assert!(replace_labels(&mut conn, A, &keep)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn user_label_ids_for_returns_user_labels_only() {
        let db = TestDb::with_account(A).await;
        seed(&db, &[&["INBOX", "Label_2", "Label_1"]]).await;
        let got = user_label_ids_for(
            &db.pool,
            &[
                (A.to_string(), "t1".to_string()),
                (A.to_string(), "t9".to_string()),
            ],
        )
        .await
        .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[&(A.to_string(), "t1".to_string())],
            ["Label_1", "Label_2"]
        );
    }
}
