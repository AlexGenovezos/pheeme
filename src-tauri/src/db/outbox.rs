//! The outbox: a durable, ordered queue of local mutations waiting for Gmail.

use anyhow::Result;
use sqlx::{SqliteConnection, SqliteExecutor};

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct DbOp {
    pub seq: i64,
    pub id: String,
    pub account_id: String,
    pub kind: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub checks_done: i64,
    pub rfc822_message_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct DbOpMessage {
    pub op_id: String,
    pub account_id: String,
    pub message_id: String,
    pub thread_id: String,
    /// JSON array of the message's labels before the op.
    pub prior_label_ids: String,
}

/// Fields of an op that change as it's processed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpProgress<'a> {
    pub status: &'a str,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub checks_done: i64,
    pub last_error: Option<&'a str>,
}

/// Insert a new op (its `seq` is assigned here) with the messages it targets.
pub async fn insert(conn: &mut SqliteConnection, op: &DbOp, targets: &[DbOpMessage]) -> Result<()> {
    sqlx::query!(
        r#"INSERT INTO outbox (id, account_id, kind, payload, status, attempts, next_attempt_at,
                               checks_done, rfc822_message_id, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        op.id,
        op.account_id,
        op.kind,
        op.payload,
        op.status,
        op.attempts,
        op.next_attempt_at,
        op.checks_done,
        op.rfc822_message_id,
        op.last_error,
        op.created_at,
        op.updated_at,
    )
    .execute(&mut *conn)
    .await?;
    for t in targets {
        sqlx::query!(
            r#"INSERT INTO outbox_messages (op_id, account_id, message_id, thread_id, prior_label_ids)
               VALUES (?, ?, ?, ?, ?)"#,
            t.op_id,
            t.account_id,
            t.message_id,
            t.thread_id,
            t.prior_label_ids,
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Record one more message as a target of an op (no-op if it already is).
pub async fn add_target<'e>(ex: impl SqliteExecutor<'e>, t: &DbOpMessage) -> Result<()> {
    sqlx::query!(
        r#"INSERT INTO outbox_messages (op_id, account_id, message_id, thread_id, prior_label_ids)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(op_id, message_id) DO NOTHING"#,
        t.op_id,
        t.account_id,
        t.message_id,
        t.thread_id,
        t.prior_label_ids,
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Replace a target's rollback labels.
pub async fn set_prior<'e>(ex: impl SqliteExecutor<'e>, t: &DbOpMessage) -> Result<()> {
    sqlx::query!(
        "UPDATE outbox_messages SET prior_label_ids = ? WHERE op_id = ? AND message_id = ?",
        t.prior_label_ids,
        t.op_id,
        t.message_id,
    )
    .execute(ex)
    .await?;
    Ok(())
}

pub async fn get<'e>(ex: impl SqliteExecutor<'e>, op_id: &str) -> Result<Option<DbOp>> {
    Ok(sqlx::query_as!(
        DbOp,
        r#"SELECT seq AS "seq!", id, account_id, kind, payload, status, attempts, next_attempt_at,
                  checks_done, rfc822_message_id, last_error, created_at, updated_at
           FROM outbox WHERE id = ?"#,
        op_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Every op of the account, oldest first.
pub async fn for_account<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<Vec<DbOp>> {
    Ok(sqlx::query_as!(
        DbOp,
        r#"SELECT seq AS "seq!", id, account_id, kind, payload, status, attempts, next_attempt_at,
                  checks_done, rfc822_message_id, last_error, created_at, updated_at
           FROM outbox WHERE account_id = ? ORDER BY seq"#,
        account_id
    )
    .fetch_all(ex)
    .await?)
}

/// Pending label/trash ops that target messages in `thread_ids`, oldest first.
pub async fn pending_touching_threads(
    conn: &mut SqliteConnection,
    account_id: &str,
    thread_ids: &[String],
) -> Result<Vec<DbOp>> {
    let threads = serde_json::to_string(thread_ids)?;
    Ok(sqlx::query_as!(
        DbOp,
        r#"SELECT o.seq AS "seq!", o.id, o.account_id, o.kind, o.payload, o.status, o.attempts,
                  o.next_attempt_at, o.checks_done, o.rfc822_message_id, o.last_error,
                  o.created_at, o.updated_at
           FROM outbox o
           WHERE o.account_id = ?1 AND o.status = 'pending' AND o.kind IN ('modify', 'trash')
             AND EXISTS (SELECT 1 FROM outbox_messages m
                         WHERE m.op_id = o.id AND m.account_id = ?1
                           AND m.thread_id IN (SELECT value FROM json_each(?2)))
           ORDER BY o.seq"#,
        account_id,
        threads
    )
    .fetch_all(&mut *conn)
    .await?)
}

pub async fn messages_of<'e>(ex: impl SqliteExecutor<'e>, op_id: &str) -> Result<Vec<DbOpMessage>> {
    Ok(sqlx::query_as!(
        DbOpMessage,
        r#"SELECT op_id, account_id, message_id, thread_id, prior_label_ids
           FROM outbox_messages WHERE op_id = ? ORDER BY message_id"#,
        op_id
    )
    .fetch_all(ex)
    .await?)
}

/// Remove an op (done, or rolled back); its target rows cascade.
pub async fn delete<'e>(ex: impl SqliteExecutor<'e>, op_id: &str) -> Result<()> {
    sqlx::query!("DELETE FROM outbox WHERE id = ?", op_id)
        .execute(ex)
        .await?;
    Ok(())
}

pub async fn update_progress<'e>(
    ex: impl SqliteExecutor<'e>,
    op_id: &str,
    p: &OpProgress<'_>,
    now_ms: i64,
) -> Result<()> {
    sqlx::query!(
        r#"UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, checks_done = ?,
                             last_error = ?, updated_at = ?
           WHERE id = ?"#,
        p.status,
        p.attempts,
        p.next_attempt_at,
        p.checks_done,
        p.last_error,
        now_ms,
        op_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Make every change that failed and is waiting out its backoff due at `now_ms` (the connection
/// came back). Sends still in their undo window (no attempt yet) keep their time.
pub async fn retry_waiting<'e>(ex: impl SqliteExecutor<'e>, now_ms: i64) -> Result<()> {
    sqlx::query!(
        r#"UPDATE outbox SET next_attempt_at = ?
           WHERE status = 'pending' AND attempts > 0 AND next_attempt_at > ?"#,
        now_ms,
        now_ms
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Move a send from `pending` to `p` (normally `checking`) as it leaves. False when it is no
/// longer pending (cancelled by undo send meanwhile), in which case it must not be sent.
pub async fn claim_send<'e>(
    ex: impl SqliteExecutor<'e>,
    op_id: &str,
    p: &OpProgress<'_>,
    now_ms: i64,
) -> Result<bool> {
    let done = sqlx::query!(
        r#"UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, checks_done = ?,
                             last_error = ?, updated_at = ?
           WHERE id = ? AND kind = 'send' AND status = 'pending'"#,
        p.status,
        p.attempts,
        p.next_attempt_at,
        p.checks_done,
        p.last_error,
        now_ms,
        op_id
    )
    .execute(ex)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Drop a send that certainly hasn't reached Gmail (`pending` or `failed`). False otherwise.
pub async fn delete_unsent<'e>(ex: impl SqliteExecutor<'e>, op_id: &str) -> Result<bool> {
    let done = sqlx::query!(
        "DELETE FROM outbox WHERE id = ? AND kind = 'send' AND status IN ('pending', 'failed')",
        op_id
    )
    .execute(ex)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Sends whose delivery isn't confirmed yet, matched against incoming mail by Message-ID.
pub async fn sends_awaiting_confirmation<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Vec<DbOp>> {
    Ok(sqlx::query_as!(
        DbOp,
        r#"SELECT seq AS "seq!", id, account_id, kind, payload, status, attempts, next_attempt_at,
                  checks_done, rfc822_message_id, last_error, created_at, updated_at
           FROM outbox
           WHERE account_id = ? AND kind = 'send' AND status IN ('checking', 'unconfirmed')
           ORDER BY seq"#,
        account_id
    )
    .fetch_all(ex)
    .await?)
}
