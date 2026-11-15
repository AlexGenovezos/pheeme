//! Recipient suggestion data: `contacts` (kept from mail by a trigger, see migration 009),
//! `google_contacts` and `google_contacts_sync`.

use anyhow::Result;
use sqlx::{SqliteConnection, SqliteExecutor};

#[derive(Debug, Clone)]
pub struct PersonThreadRow {
    pub id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
}

/// Recent conversations involving this exact address, in this account. Search JSON
/// addresses, never substrings in names or bodies. Spam, Trash and drafts stay out.
pub async fn person_threads<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    address: &str,
) -> Result<Vec<PersonThreadRow>> {
    Ok(sqlx::query_as!(PersonThreadRow,
        r#"SELECT t.id, t.subject, t.snippet, coalesce(t.last_message_date, 0) AS "date!: i64"
           FROM threads t WHERE t.account_id = ?1 AND EXISTS (
             SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id
               AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.label_ids) THEN m.label_ids ELSE '[]' END) WHERE value IN ('SPAM', 'TRASH', 'DRAFT'))
               AND (lower(trim(m.from_address)) = ?2 OR EXISTS (
                 SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END) j
                   WHERE lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))) = ?2
               ) OR EXISTS (
                 SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END) j
                   WHERE lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))) = ?2
               ))
           ) AND NOT EXISTS (SELECT 1 FROM thread_labels l WHERE l.account_id = t.account_id AND l.thread_id = t.id AND l.label_id IN ('SPAM', 'TRASH'))
           ORDER BY t.last_message_date DESC, t.id DESC LIMIT 8"#,
        account_id, address
    ).fetch_all(ex).await?)
}

/// Cache a contact only after Google confirms its creation. Call under the refresh gate.
pub async fn save_person<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    address: &str,
    name: Option<&str>,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO google_contacts (account_id, address, name, saved) VALUES (?, ?, ?, 1)
         ON CONFLICT(account_id, saved, address) DO UPDATE SET name = coalesce(excluded.name, google_contacts.name)",
        account_id, address, name
    ).execute(ex).await?;
    Ok(())
}

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

/// One address from a Google Contacts list, with what its contact card shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GoogleContact {
    /// Lowercased.
    pub address: String,
    pub name: Option<String>,
    pub phone: Option<String>,
    pub organization: Option<String>,
    pub photo_url: Option<String>,
}

/// Replace one of the account's Google Contacts lists (`saved`, or Other contacts) with
/// `people`. Run it in a write transaction.
pub async fn replace_google(
    conn: &mut SqliteConnection,
    account_id: &str,
    saved: bool,
    people: &[GoogleContact],
) -> Result<()> {
    sqlx::query!(
        "DELETE FROM google_contacts WHERE account_id = ? AND saved = ?",
        account_id,
        saved
    )
    .execute(&mut *conn)
    .await?;
    for p in people {
        sqlx::query!(
            "INSERT INTO google_contacts (account_id, address, name, saved, phone, organization, photo_url)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, saved, address) DO UPDATE SET
                 name = coalesce(google_contacts.name, excluded.name),
                 phone = coalesce(google_contacts.phone, excluded.phone),
                 organization = coalesce(google_contacts.organization, excluded.organization),
                 photo_url = coalesce(google_contacts.photo_url, excluded.photo_url)",
            account_id,
            p.address,
            p.name,
            saved,
            p.phone,
            p.organization,
            p.photo_url
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// What the address's contact card shows from Google Contacts: the user's own contact first,
/// then Other contacts, field by field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardRow {
    pub phone: Option<String>,
    pub organization: Option<String>,
    pub photo_url: Option<String>,
}

pub async fn card<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    address: &str,
) -> Result<CardRow> {
    let rows = sqlx::query!(
        "SELECT phone, organization, photo_url FROM google_contacts
         WHERE account_id = ? AND address = ? ORDER BY saved DESC",
        account_id,
        address
    )
    .fetch_all(ex)
    .await?;
    let first = |pick: fn(&_) -> &Option<String>| rows.iter().find_map(|r| pick(r).clone());
    Ok(CardRow {
        phone: first(|r| &r.phone),
        organization: first(|r| &r.organization),
        photo_url: first(|r| &r.photo_url),
    })
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
