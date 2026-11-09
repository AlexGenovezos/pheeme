//! AI assistant clients and their activity log (`local_api`).
use anyhow::Result;
use sqlx::SqlitePool;

/// How many activity rows are kept.
pub const ACTIVITY_KEEP: i64 = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbClient {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbActivity {
    pub id: i64,
    pub client_name: String,
    pub tool: String,
    pub summary: String,
    pub arguments: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub at: i64,
}

/// One tool call, for [`add_activity`].
pub struct NewActivity<'a> {
    pub client_id: &'a str,
    pub client_name: &'a str,
    pub tool: &'a str,
    pub summary: &'a str,
    pub arguments: &'a str,
    pub result: Option<&'a str>,
    pub error: Option<&'a str>,
    pub at: i64,
}

pub async fn insert_client(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    token_hash: &str,
    created_at: i64,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO assistant_clients (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
        id,
        name,
        token_hash,
        created_at
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Clients, oldest first.
pub async fn list_clients(pool: &SqlitePool) -> Result<Vec<DbClient>> {
    Ok(sqlx::query_as!(
        DbClient,
        "SELECT id, name, created_at, last_used_at FROM assistant_clients
         ORDER BY created_at, id"
    )
    .fetch_all(pool)
    .await?)
}

pub async fn client_by_token_hash(pool: &SqlitePool, token_hash: &str) -> Result<Option<DbClient>> {
    Ok(sqlx::query_as!(
        DbClient,
        "SELECT id, name, created_at, last_used_at FROM assistant_clients WHERE token_hash = ?",
        token_hash
    )
    .fetch_optional(pool)
    .await?)
}

/// Whether a client was removed.
pub async fn delete_client(pool: &SqlitePool, id: &str) -> Result<bool> {
    let done = sqlx::query!("DELETE FROM assistant_clients WHERE id = ?", id)
        .execute(pool)
        .await?;
    Ok(done.rows_affected() > 0)
}

pub async fn touch_client(pool: &SqlitePool, id: &str, at: i64) -> Result<()> {
    sqlx::query!(
        "UPDATE assistant_clients SET last_used_at = ? WHERE id = ?",
        at,
        id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Record a tool call and keep only the latest [`ACTIVITY_KEEP`] rows.
pub async fn add_activity(pool: &SqlitePool, call: &NewActivity<'_>) -> Result<()> {
    let mut tx = super::begin_write(pool).await?;
    sqlx::query!(
        "INSERT INTO assistant_activity
           (client_id, client_name, tool, summary, arguments, result, error, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        call.client_id,
        call.client_name,
        call.tool,
        call.summary,
        call.arguments,
        call.result,
        call.error,
        call.at
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM assistant_activity WHERE id <= (SELECT MAX(id) FROM assistant_activity) - ?",
        ACTIVITY_KEEP
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The latest `limit` tool calls, newest first.
pub async fn list_activity(pool: &SqlitePool, limit: i64) -> Result<Vec<DbActivity>> {
    Ok(sqlx::query_as!(
        DbActivity,
        "SELECT id, client_name, tool, summary, arguments, result, error, at FROM assistant_activity
         ORDER BY id DESC LIMIT ?",
        limit
    )
    .fetch_all(pool)
    .await?)
}

pub async fn clear_activity(pool: &SqlitePool) -> Result<()> {
    sqlx::query!("DELETE FROM assistant_activity")
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    #[tokio::test]
    async fn clients_round_trip_by_token_hash() {
        let db = TestDb::with_account("a").await;
        insert_client(&db.pool, "c1", "Claude Code", "h1", 10)
            .await
            .unwrap();
        insert_client(&db.pool, "c2", "Other", "h2", 20)
            .await
            .unwrap();
        assert!(insert_client(&db.pool, "c3", "Dup", "h1", 30)
            .await
            .is_err());

        let found = client_by_token_hash(&db.pool, "h2").await.unwrap().unwrap();
        assert_eq!(found.id, "c2");
        assert_eq!(found.last_used_at, None);
        touch_client(&db.pool, "c2", 99).await.unwrap();
        let names: Vec<_> = list_clients(&db.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|c| (c.name, c.last_used_at))
            .collect();
        assert_eq!(
            names,
            [("Claude Code".into(), None), ("Other".into(), Some(99))]
        );

        assert!(delete_client(&db.pool, "c2").await.unwrap());
        assert!(!delete_client(&db.pool, "c2").await.unwrap());
        assert!(client_by_token_hash(&db.pool, "h2")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn activity_is_newest_first_and_trimmed() {
        let db = TestDb::with_account("a").await;
        for n in 0..(ACTIVITY_KEEP + 5) {
            let summary = n.to_string();
            let error = (n == ACTIVITY_KEEP + 4).then_some("nope");
            add_activity(
                &db.pool,
                &NewActivity {
                    client_id: "c",
                    client_name: "Claude",
                    tool: "search_mail",
                    summary: &summary,
                    arguments: r#"{"query":"x"}"#,
                    result: error.is_none().then_some("{}"),
                    error,
                    at: n,
                },
            )
            .await
            .unwrap();
        }
        let all = list_activity(&db.pool, 10_000).await.unwrap();
        assert_eq!(all.len() as i64, ACTIVITY_KEEP);
        assert_eq!(all[0].summary, (ACTIVITY_KEEP + 4).to_string());
        assert_eq!(all[0].error.as_deref(), Some("nope"));
        assert_eq!(all[0].arguments, r#"{"query":"x"}"#);
        assert_eq!(all[0].result, None);
        assert_eq!(all[1].result.as_deref(), Some("{}"));
        assert_eq!(all.last().unwrap().summary, "5");
        assert_eq!(list_activity(&db.pool, 2).await.unwrap().len(), 2);

        clear_activity(&db.pool).await.unwrap();
        assert!(list_activity(&db.pool, 10).await.unwrap().is_empty());
    }
}
