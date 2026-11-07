//! Per-account sync bookkeeping: where the background backfill has got to.

use anyhow::Result;
use serde::Serialize;
use sqlx::{SqliteConnection, SqliteExecutor};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DbSyncState {
    pub backfill_page_token: Option<String>,
    pub backfill_complete: bool,
    /// Backfill has passed the full-body window; later pages fetch metadata only.
    pub backfill_bodies_done: bool,
    pub backfill_generation: i64,
    pub last_synced_at: Option<i64>,
}

/// The account's state; defaults (backfill not started) when there's no row yet.
pub async fn get<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<DbSyncState> {
    let row = sqlx::query!(
        r#"SELECT backfill_page_token, backfill_complete, backfill_bodies_done,
                  backfill_generation, last_synced_at
           FROM sync_state WHERE account_id = ?"#,
        account_id
    )
    .fetch_optional(ex)
    .await?;
    Ok(row
        .map(|r| DbSyncState {
            backfill_page_token: r.backfill_page_token,
            backfill_complete: r.backfill_complete != 0,
            backfill_bodies_done: r.backfill_bodies_done != 0,
            backfill_generation: r.backfill_generation,
            last_synced_at: r.last_synced_at,
        })
        .unwrap_or_default())
}

/// Start the backfill over from the newest message.
pub async fn reset_backfill(conn: &mut SqliteConnection, account_id: &str) -> Result<()> {
    sqlx::query!(
        r#"INSERT INTO sync_state (account_id) VALUES (?)
           ON CONFLICT(account_id) DO UPDATE SET
             backfill_page_token = NULL, backfill_complete = 0, backfill_bodies_done = 0,
             backfill_generation = backfill_generation + 1"#,
        account_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn save_backfill(
    conn: &mut SqliteConnection,
    account_id: &str,
    page_token: Option<&str>,
    bodies_done: bool,
    complete: bool,
) -> Result<()> {
    let bodies_done = i64::from(bodies_done);
    let complete = i64::from(complete);
    sqlx::query!(
        r#"INSERT INTO sync_state (account_id, backfill_page_token, backfill_bodies_done, backfill_complete)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(account_id) DO UPDATE SET
             backfill_page_token = ?2, backfill_bodies_done = ?3, backfill_complete = ?4"#,
        account_id,
        page_token,
        bodies_done,
        complete
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn touch(conn: &mut SqliteConnection, account_id: &str, now_ms: i64) -> Result<()> {
    sqlx::query!(
        r#"INSERT INTO sync_state (account_id, last_synced_at) VALUES (?1, ?2)
           ON CONFLICT(account_id) DO UPDATE SET last_synced_at = ?2"#,
        account_id,
        now_ms
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn mailbox_total<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar!(
        "SELECT mailbox_messages_total FROM sync_state WHERE account_id = ?",
        account_id
    )
    .fetch_optional(ex)
    .await?
    .flatten())
}

pub async fn set_mailbox_total(
    conn: &mut SqliteConnection,
    account_id: &str,
    total: u64,
) -> Result<()> {
    let total = i64::try_from(total)?;
    sqlx::query!(
        "INSERT INTO sync_state (account_id, mailbox_messages_total) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET mailbox_messages_total = excluded.mailbox_messages_total",
        account_id,
        total
    )
    .execute(conn)
    .await?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub account_id: String,
    pub synced_messages: i64,
    pub total_messages: Option<i64>,
    pub downloaded_messages: i64,
    pub complete: bool,
}

/// Read only committed cache rows, including successful fetches from a retried page.
/// A completed backfill's current cache size is more useful than its old profile count.
pub async fn progress(pool: &sqlx::SqlitePool) -> Result<Vec<SyncProgress>> {
    Ok(sqlx::query_as!(
        SyncProgress,
        r#"SELECT a.id AS account_id, COUNT(m.id) AS "synced_messages!: i64",
                CASE WHEN s.backfill_complete = 1 THEN COUNT(m.id)
                     ELSE MAX(s.mailbox_messages_total, COUNT(m.id)) END AS "total_messages?: i64",
                COALESCE(SUM(m.fully_fetched != 0), 0) AS "downloaded_messages!: i64",
                COALESCE(s.backfill_complete, 0) AS "complete!: bool"
         FROM accounts a
         LEFT JOIN sync_state s ON s.account_id = a.id
         LEFT JOIN messages m ON m.account_id = a.id
         GROUP BY a.id"#,
    )
    .fetch_all(pool)
    .await?)
}
