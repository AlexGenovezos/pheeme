//! Event reminders already shown (`calendar_reminders_fired`, migration 013).

use anyhow::Result;
use sqlx::SqlitePool;

/// One reminder of one occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ReminderKey {
    pub account_id: String,
    pub calendar_id: String,
    pub event_id: String,
    pub start_ms: i64,
    pub minutes: i64,
}

/// Every reminder recorded as shown (the table only holds the last couple of days).
pub async fn fired(pool: &SqlitePool) -> Result<Vec<ReminderKey>> {
    Ok(sqlx::query_as!(
        ReminderKey,
        "SELECT account_id, calendar_id, event_id, start_ms, minutes
         FROM calendar_reminders_fired
         ORDER BY account_id, calendar_id, event_id, start_ms, minutes"
    )
    .fetch_all(pool)
    .await?)
}

/// Record the reminder as shown (or dropped) at `at_ms`. Recording it twice is harmless.
pub async fn mark_fired(pool: &SqlitePool, key: &ReminderKey, at_ms: i64) -> Result<()> {
    sqlx::query!(
        "INSERT OR IGNORE INTO calendar_reminders_fired
             (account_id, calendar_id, event_id, start_ms, minutes, fired_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        key.account_id,
        key.calendar_id,
        key.event_id,
        key.start_ms,
        key.minutes,
        at_ms
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Forget reminders shown before `before_ms`; they can't come due again.
pub async fn prune(pool: &SqlitePool, before_ms: i64) -> Result<u64> {
    Ok(sqlx::query!(
        "DELETE FROM calendar_reminders_fired WHERE fired_at < ?",
        before_ms
    )
    .execute(pool)
    .await?
    .rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn key(event_id: &str) -> ReminderKey {
        ReminderKey {
            account_id: "a".into(),
            calendar_id: "c".into(),
            event_id: event_id.into(),
            start_ms: 1_000,
            minutes: 10,
        }
    }

    #[tokio::test]
    async fn fired_reminders_persist_once_prune_and_go_with_the_account() {
        let db = TestDb::with_account("a").await;
        mark_fired(&db.pool, &key("e1"), 100).await.unwrap();
        mark_fired(&db.pool, &key("e1"), 200).await.unwrap();
        mark_fired(&db.pool, &key("e2"), 300).await.unwrap();
        let reopened = crate::db::init_db(db.dir()).await.unwrap();
        assert_eq!(fired(&reopened).await.unwrap(), vec![key("e1"), key("e2")]);
        assert_eq!(prune(&reopened, 250).await.unwrap(), 1);
        assert_eq!(fired(&reopened).await.unwrap(), vec![key("e2")]);
        sqlx::query("DELETE FROM accounts WHERE id = 'a'")
            .execute(&reopened)
            .await
            .unwrap();
        assert!(fired(&reopened).await.unwrap().is_empty());
    }
}
