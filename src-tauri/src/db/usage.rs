//! Anonymous usage counts waiting for the daily usage report (`usage_counts`, see
//! `telemetry.rs`). Counts add up per local day, kind and name.
use anyhow::Result;
use sqlx::SqlitePool;

/// One count to add: a screen opened (`count`, `ms` on screen) or a command run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRow {
    pub kind: String,
    pub name: String,
    pub count: i64,
    pub ms: i64,
}

/// Add `rows` to `day`'s counts, in one transaction.
pub async fn add(pool: &SqlitePool, day: &str, rows: &[UsageRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = super::begin_write(pool).await?;
    for row in rows {
        sqlx::query!(
            "INSERT INTO usage_counts (day, kind, name, count, ms) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(day, kind, name) DO UPDATE SET
               count = count + excluded.count,
               ms = ms + excluded.ms",
            day,
            row.kind,
            row.name,
            row.count,
            row.ms
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Days with counts before `today`, oldest first.
pub async fn days_before(pool: &SqlitePool, today: &str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        "SELECT DISTINCT day FROM usage_counts WHERE day < ? ORDER BY day",
        today
    )
    .fetch_all(pool)
    .await?)
}

/// Every count of `day`.
pub async fn rows_of(pool: &SqlitePool, day: &str) -> Result<Vec<UsageRow>> {
    Ok(sqlx::query_as!(
        UsageRow,
        "SELECT kind, name, count, ms FROM usage_counts WHERE day = ? ORDER BY kind, name",
        day
    )
    .fetch_all(pool)
    .await?)
}

pub async fn delete_day(pool: &SqlitePool, day: &str) -> Result<()> {
    sqlx::query!("DELETE FROM usage_counts WHERE day = ?", day)
        .execute(pool)
        .await?;
    Ok(())
}

/// Forget every count (usage stats turned off).
pub async fn clear(pool: &SqlitePool) -> Result<()> {
    sqlx::query!("DELETE FROM usage_counts")
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn row(kind: &str, name: &str, count: i64, ms: i64) -> UsageRow {
        UsageRow {
            kind: kind.into(),
            name: name.into(),
            count,
            ms,
        }
    }

    #[tokio::test]
    async fn counts_add_up_per_day() {
        let db = TestDb::new().await;
        add(
            &db.pool,
            "2026-11-01",
            &[row("screen", "mail.inbox", 1, 500)],
        )
        .await
        .unwrap();
        add(
            &db.pool,
            "2026-11-01",
            &[
                row("screen", "mail.inbox", 2, 250),
                row("key", "go.inbox", 3, 0),
            ],
        )
        .await
        .unwrap();
        add(&db.pool, "2026-11-02", &[row("key", "go.inbox", 1, 0)])
            .await
            .unwrap();

        assert_eq!(
            rows_of(&db.pool, "2026-11-01").await.unwrap(),
            [
                row("key", "go.inbox", 3, 0),
                row("screen", "mail.inbox", 3, 750)
            ]
        );
        assert_eq!(
            days_before(&db.pool, "2026-11-02").await.unwrap(),
            ["2026-11-01"]
        );

        delete_day(&db.pool, "2026-11-01").await.unwrap();
        assert!(rows_of(&db.pool, "2026-11-01").await.unwrap().is_empty());
        clear(&db.pool).await.unwrap();
        assert!(days_before(&db.pool, "2099-01-01")
            .await
            .unwrap()
            .is_empty());
    }
}
