//! Per-account sync bookkeeping: where the background backfill has got to.

use anyhow::Result;
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
