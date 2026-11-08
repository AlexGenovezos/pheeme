//! Recipient suggestion data: `contacts` (kept from mail by a trigger, see migration 009),
//! `google_contacts` and `google_contacts_sync`.

use anyhow::Result;
use sqlx::{SqliteConnection, SqliteExecutor};

/// One address the account could write to, its mail and Google Contacts rows merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactRow {
    pub address: String,
    /// The saved contact's name first, then the newest name from mail, then Other contacts'.
    pub name: Option<String>,
    pub sent_count: i64,
    pub received_count: i64,
    pub last_sent: i64,
    pub last_received: i64,
    /// In the user's own Google Contacts.
    pub saved: bool,
    /// In Google's "Other contacts".
    pub other: bool,
}

/// Every address the account has exchanged mail with or has in Google Contacts.
pub async fn all<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<Vec<ContactRow>> {
    let rows = sqlx::query!(
        r#"
        SELECT address AS "address!: String",
               coalesce(max(CASE WHEN src = 2 THEN name END),
                        max(CASE WHEN src = 0 THEN name END),
                        max(name)) AS "name?: String",
               max(sent_count) AS "sent_count!: i64",
               max(received_count) AS "received_count!: i64",
               max(last_sent) AS "last_sent!: i64",
               max(last_received) AS "last_received!: i64",
               max(src = 2) AS "saved!: bool",
               max(src = 1) AS "other!: bool"
        FROM (
            SELECT address, name, sent_count, received_count, last_sent, last_received, 0 AS src
            FROM contacts WHERE account_id = ?1
            UNION ALL
            SELECT address, name, 0, 0, 0, 0, CASE saved WHEN 1 THEN 2 ELSE 1 END
            FROM google_contacts WHERE account_id = ?1
        )
        GROUP BY address
        "#,
        account_id
    )
    .fetch_all(ex)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ContactRow {
            address: r.address,
            name: r.name,
            sent_count: r.sent_count,
            received_count: r.received_count,
            last_sent: r.last_sent,
            last_received: r.last_received,
            saved: r.saved,
            other: r.other,
        })
        .collect())
}

/// Replace one of the account's Google Contacts lists (`saved`, or Other contacts) with
/// `people` (lowercased address, name). Run it in a write transaction.
pub async fn replace_google(
    conn: &mut SqliteConnection,
    account_id: &str,
    saved: bool,
    people: &[(String, Option<String>)],
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM google_contacts WHERE account_id = ? AND saved = ?",
        account_id,
        saved
    )
    .execute(&mut *conn)
    .await?;
    for (address, name) in people {
        sqlx::query!(
            "INSERT INTO google_contacts (account_id, address, name, saved) VALUES (?, ?, ?, ?)
             ON CONFLICT (account_id, saved, address) DO UPDATE SET
                 name = coalesce(google_contacts.name, excluded.name)",
            account_id,
            address,
            name,
            saved
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleSyncRow {
    pub status: String,
    pub detail: Option<String>,
    pub checked_at: i64,
    pub synced_at: Option<i64>,
}

/// How the account's last Google Contacts download went; `None` before the first.
pub async fn google_sync<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Option<GoogleSyncRow>> {
    Ok(sqlx::query_as!(
        GoogleSyncRow,
        r#"SELECT status, detail, checked_at, synced_at
           FROM google_contacts_sync WHERE account_id = ?"#,
        account_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Record a download attempt at `now`; `synced` when it succeeded.
pub async fn set_google_sync<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    status: &str,
    detail: Option<&str>,
    now: i64,
    synced: bool,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO google_contacts_sync (account_id, status, detail, checked_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 THEN ?4 END)
         ON CONFLICT (account_id) DO UPDATE SET
             status = excluded.status,
             detail = excluded.detail,
             checked_at = excluded.checked_at,
             synced_at = CASE WHEN ?5 THEN ?4 ELSE google_contacts_sync.synced_at END",
        account_id,
        status,
        detail,
        now,
        synced
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Addresses the account has in Google Contacts (either list).
pub async fn google_count<'e>(ex: impl SqliteExecutor<'e>, account_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar!(
        r#"SELECT count(DISTINCT address) AS "n!: i64" FROM google_contacts WHERE account_id = ?"#,
        account_id
    )
    .fetch_one(ex)
    .await?)
}
