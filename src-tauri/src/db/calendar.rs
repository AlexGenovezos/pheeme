//! Calendar cache: `calendars`, `events` and `calendar_access` (migration 010).

use anyhow::Result;
use sqlx::{SqliteExecutor, SqlitePool};
use std::collections::HashSet;

/// One of an account's Google calendars, as listed by `calendarList`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbCalendar {
    pub account_id: String,
    pub id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    pub access_role: String,
    pub primary: bool,
    /// Unticked in Pheeme's sidebar (local only, kept across syncs).
    pub hidden: bool,
    /// JSON array of `{method, minutes}`.
    pub default_reminders: String,
    pub sync_token: Option<String>,
}

/// One cached event: a single event, a repeating series (`recurrence`), or a changed or
/// cancelled occurrence of one (`recurring_event_id`). See migration 010 for the columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbEvent {
    pub account_id: String,
    pub calendar_id: String,
    pub id: String,
    pub ical_uid: Option<String>,
    pub recurring_event_id: Option<String>,
    pub original_start_ms: Option<i64>,
    pub original_start_date: Option<String>,
    pub status: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub time_zone: Option<String>,
    /// JSON array of RRULE/EXDATE/RDATE lines.
    pub recurrence: Option<String>,
    pub recur_until_ms: Option<i64>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer_email: Option<String>,
    pub self_response: Option<String>,
    /// JSON array of attendees.
    pub attendees: String,
    pub conference: Option<String>,
    pub color_id: Option<String>,
    pub transparency: Option<String>,
    pub visibility: Option<String>,
    pub reminders: Option<String>,
    pub html_link: Option<String>,
    pub etag: String,
    pub updated_ms: i64,
    /// The whole Calendar API resource.
    pub raw: String,
}

impl DbEvent {
    pub fn is_all_day(&self) -> bool {
        self.start_date.is_some()
    }
}

/// Whether the account allowed calendar access and how its last sync went, plus its Google
/// Calendar settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbCalendarAccess {
    pub status: String,
    pub detail: Option<String>,
    pub checked_at: i64,
    pub synced_at: Option<i64>,
    pub settings_checked_at: Option<i64>,
    pub time_zone: Option<String>,
    pub week_start: Option<i64>,
}

/// All-day rows are stored at UTC midnight; an all-day event a zone away can still overlap.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Store the account's calendar list: upsert each calendar (keeping Pheeme's `hidden` and the
/// sync token) and delete calendars no longer listed, with their events.
pub async fn replace_calendars(
    pool: &SqlitePool,
    account_id: &str,
    calendars: &[DbCalendar],
) -> Result<()> {
    let mut tx = super::begin_write(pool).await?;
    let existing: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id AS "id!: String" FROM calendars WHERE account_id = ?"#,
        account_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let listed: HashSet<&str> = calendars.iter().map(|c| c.id.as_str()).collect();
    for id in existing.iter().filter(|id| !listed.contains(id.as_str())) {
        sqlx::query!(
            "DELETE FROM calendars WHERE account_id = ? AND id = ?",
            account_id,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    for c in calendars {
        sqlx::query!(
            "INSERT INTO calendars (account_id, id, summary, description, time_zone,
                 background_color, foreground_color, access_role, is_primary, default_reminders)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, id) DO UPDATE SET
                 summary = excluded.summary,
                 description = excluded.description,
                 time_zone = excluded.time_zone,
                 background_color = excluded.background_color,
                 foreground_color = excluded.foreground_color,
                 access_role = excluded.access_role,
                 is_primary = excluded.is_primary,
                 default_reminders = excluded.default_reminders",
            account_id,
            c.id,
            c.summary,
            c.description,
            c.time_zone,
            c.background_color,
            c.foreground_color,
            c.access_role,
            c.primary,
            c.default_reminders
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The account's calendars (every account's with `None`), primary first, then by name.
pub async fn calendars<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: Option<&str>,
) -> Result<Vec<DbCalendar>> {
    Ok(sqlx::query_as!(
        DbCalendar,
        r#"SELECT account_id, id, summary, description, time_zone, background_color,
                  foreground_color, access_role, is_primary AS "primary: bool",
                  hidden AS "hidden: bool", default_reminders, sync_token
           FROM calendars
           WHERE ?1 IS NULL OR account_id = ?1
           ORDER BY account_id, is_primary DESC, summary COLLATE NOCASE"#,
        account_id
    )
    .fetch_all(ex)
    .await?)
}

/// Show or hide a calendar's events (Pheeme's sidebar checkbox).
pub async fn set_hidden<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    calendar_id: &str,
    hidden: bool,
) -> Result<()> {
    sqlx::query!(
        "UPDATE calendars SET hidden = ? WHERE account_id = ? AND id = ?",
        hidden,
        account_id,
        calendar_id
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Apply one sync page (or one write's result) to a calendar in a single transaction:
/// upsert `upserts`, delete `deleted_ids`, and store `sync_token` when given.
pub async fn apply_event_changes(
    pool: &SqlitePool,
    account_id: &str,
    calendar_id: &str,
    upserts: &[DbEvent],
    deleted_ids: &[String],
    sync_token: Option<&str>,
) -> Result<()> {
    let mut tx = super::begin_write(pool).await?;
    for id in deleted_ids {
        sqlx::query!(
            // A deleted series takes its changed and cancelled occurrences with it.
            "DELETE FROM events
             WHERE account_id = ?1 AND calendar_id = ?2 AND (id = ?3 OR recurring_event_id = ?3)",
            account_id,
            calendar_id,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    for e in upserts {
        sqlx::query!(
            "INSERT INTO events (account_id, calendar_id, id, ical_uid, recurring_event_id,
                 original_start_ms, original_start_date, status, start_ms, end_ms, start_date,
                 end_date, time_zone, recurrence, recur_until_ms, summary, location, description,
                 organizer_email, self_response, attendees, conference, color_id, transparency,
                 visibility, reminders, html_link, etag, updated_ms, raw)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, calendar_id, id) DO UPDATE SET
                 ical_uid = excluded.ical_uid,
                 recurring_event_id = excluded.recurring_event_id,
                 original_start_ms = excluded.original_start_ms,
                 original_start_date = excluded.original_start_date,
                 status = excluded.status,
                 start_ms = excluded.start_ms,
                 end_ms = excluded.end_ms,
                 start_date = excluded.start_date,
                 end_date = excluded.end_date,
                 time_zone = excluded.time_zone,
                 recurrence = excluded.recurrence,
                 recur_until_ms = excluded.recur_until_ms,
                 summary = excluded.summary,
                 location = excluded.location,
                 description = excluded.description,
                 organizer_email = excluded.organizer_email,
                 self_response = excluded.self_response,
                 attendees = excluded.attendees,
                 conference = excluded.conference,
                 color_id = excluded.color_id,
                 transparency = excluded.transparency,
                 visibility = excluded.visibility,
                 reminders = excluded.reminders,
                 html_link = excluded.html_link,
                 etag = excluded.etag,
                 updated_ms = excluded.updated_ms,
                 raw = excluded.raw",
            account_id,
            calendar_id,
            e.id,
            e.ical_uid,
            e.recurring_event_id,
            e.original_start_ms,
            e.original_start_date,
            e.status,
            e.start_ms,
            e.end_ms,
            e.start_date,
            e.end_date,
            e.time_zone,
            e.recurrence,
            e.recur_until_ms,
            e.summary,
            e.location,
            e.description,
            e.organizer_email,
            e.self_response,
            e.attendees,
            e.conference,
            e.color_id,
            e.transparency,
            e.visibility,
            e.reminders,
            e.html_link,
            e.etag,
            e.updated_ms,
            e.raw
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(token) = sync_token {
        let updated = sqlx::query!(
            "UPDATE calendars SET sync_token = ? WHERE account_id = ? AND id = ?",
            token,
            account_id,
            calendar_id
        )
        .execute(&mut *tx)
        .await?;
        anyhow::ensure!(
            updated.rows_affected() == 1,
            "no calendar {calendar_id} to store a sync token on"
        );
    }
    tx.commit().await?;
    Ok(())
}

/// Forget a calendar's events and sync token (Google said the token is gone; sync in full).
pub async fn clear_calendar_events(
    pool: &SqlitePool,
    account_id: &str,
    calendar_id: &str,
) -> Result<()> {
    let mut tx = super::begin_write(pool).await?;
    sqlx::query!(
        "DELETE FROM events WHERE account_id = ? AND calendar_id = ?",
        account_id,
        calendar_id
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE calendars SET sync_token = NULL WHERE account_id = ? AND id = ?",
        account_id,
        calendar_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// One cached event (a series, a single event or a stored occurrence) by id.
pub async fn event<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    calendar_id: &str,
    id: &str,
) -> Result<Option<DbEvent>> {
    Ok(sqlx::query_as!(
        DbEvent,
        r#"SELECT e.account_id, e.calendar_id, e.id, e.ical_uid, e.recurring_event_id,
                  e.original_start_ms, e.original_start_date, e.status, e.start_ms, e.end_ms,
                  e.start_date, e.end_date, e.time_zone, e.recurrence, e.recur_until_ms,
                  e.summary, e.location, e.description, e.organizer_email, e.self_response,
                  e.attendees, e.conference, e.color_id, e.transparency, e.visibility,
                  e.reminders, e.html_link, e.etag, e.updated_ms, e.raw
           FROM events e
           WHERE e.account_id = ? AND e.calendar_id = ? AND e.id = ?"#,
        account_id,
        calendar_id,
        id
    )
    .fetch_optional(ex)
    .await?)
}

/// Every cached row of an account sharing an iCalendar UID (the same invitation on
/// several of its calendars, or a series and its changed occurrences).
pub async fn events_by_ical_uid<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    ical_uid: &str,
) -> Result<Vec<DbEvent>> {
    Ok(sqlx::query_as!(
        DbEvent,
        r#"SELECT e.account_id, e.calendar_id, e.id, e.ical_uid, e.recurring_event_id,
                  e.original_start_ms, e.original_start_date, e.status, e.start_ms, e.end_ms,
                  e.start_date, e.end_date, e.time_zone, e.recurrence, e.recur_until_ms,
                  e.summary, e.location, e.description, e.organizer_email, e.self_response,
                  e.attendees, e.conference, e.color_id, e.transparency, e.visibility,
                  e.reminders, e.html_link, e.etag, e.updated_ms, e.raw
           FROM events e
           WHERE e.account_id = ? AND e.ical_uid = ?
           ORDER BY e.calendar_id, e.id"#,
        account_id,
        ical_uid
    )
    .fetch_all(ex)
    .await?)
}

/// Delete a series' changed and cancelled occurrences whose original start is at or after
/// `from_ms` (all-day ones are stored at their date's UTC midnight); returns how many.
pub async fn delete_overrides_from<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    calendar_id: &str,
    master_id: &str,
    from_ms: i64,
) -> Result<u64> {
    let done = sqlx::query!(
        "DELETE FROM events
         WHERE account_id = ? AND calendar_id = ? AND recurring_event_id = ?
           AND original_start_ms >= ?",
        account_id,
        calendar_id,
        master_id,
        from_ms
    )
    .execute(ex)
    .await?;
    Ok(done.rows_affected())
}

/// Rows from shown calendars that may have occurrences in `[from_ms, to_ms)`: events that
/// overlap it (all-day ones padded by a day, for the caller to trim by zone), every series
/// that runs into it, and every changed or cancelled occurrence of those series.
pub async fn events_overlapping(
    pool: &SqlitePool,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<DbEvent>> {
    let mut conn = pool.acquire().await?;
    let mut rows = sqlx::query_as!(
        DbEvent,
        r#"SELECT e.account_id, e.calendar_id, e.id, e.ical_uid, e.recurring_event_id,
                  e.original_start_ms, e.original_start_date, e.status, e.start_ms, e.end_ms,
                  e.start_date, e.end_date, e.time_zone, e.recurrence, e.recur_until_ms,
                  e.summary, e.location, e.description, e.organizer_email, e.self_response,
                  e.attendees, e.conference, e.color_id, e.transparency, e.visibility,
                  e.reminders, e.html_link, e.etag, e.updated_ms, e.raw
           FROM events e
           JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
           WHERE c.hidden = 0 AND e.recurrence IS NOT NULL AND e.status != 'cancelled'
             AND e.start_ms < ?2 + CASE WHEN e.start_date IS NULL THEN 0 ELSE ?3 END
             AND (e.recur_until_ms IS NULL
                  OR e.recur_until_ms > ?1 - CASE WHEN e.start_date IS NULL THEN 0 ELSE ?3 END)"#,
        from_ms,
        to_ms,
        DAY_MS
    )
    .fetch_all(&mut *conn)
    .await?;
    let series: HashSet<(String, String, String)> = rows
        .iter()
        .map(|e| (e.account_id.clone(), e.calendar_id.clone(), e.id.clone()))
        .collect();
    let others = sqlx::query_as!(
        DbEvent,
        r#"SELECT e.account_id, e.calendar_id, e.id, e.ical_uid, e.recurring_event_id,
                  e.original_start_ms, e.original_start_date, e.status, e.start_ms, e.end_ms,
                  e.start_date, e.end_date, e.time_zone, e.recurrence, e.recur_until_ms,
                  e.summary, e.location, e.description, e.organizer_email, e.self_response,
                  e.attendees, e.conference, e.color_id, e.transparency, e.visibility,
                  e.reminders, e.html_link, e.etag, e.updated_ms, e.raw
           FROM events e
           JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
           WHERE c.hidden = 0 AND e.recurrence IS NULL AND (
               (e.status != 'cancelled'
                AND e.start_ms < ?2 + CASE WHEN e.start_date IS NULL THEN 0 ELSE ?3 END
                AND e.end_ms > ?1 - CASE WHEN e.start_date IS NULL THEN 0 ELSE ?3 END)
               OR (e.recurring_event_id IS NOT NULL
                   AND coalesce(e.original_start_ms, e.start_ms) < ?2 + ?3))"#,
        from_ms,
        to_ms,
        DAY_MS
    )
    .fetch_all(&mut *conn)
    .await?;
    rows.extend(others.into_iter().filter(|e| {
        let overlaps = e.status != "cancelled"
            && e.start_ms.is_some_and(|s| s < to_ms + pad(e))
            && e.end_ms.is_some_and(|end| end > from_ms - pad(e));
        overlaps
            || e.recurring_event_id.as_ref().is_some_and(|master| {
                series.contains(&(e.account_id.clone(), e.calendar_id.clone(), master.clone()))
            })
    }));
    Ok(rows)
}

fn pad(e: &DbEvent) -> i64 {
    if e.is_all_day() {
        DAY_MS
    } else {
        0
    }
}

/// The account's calendar access and settings, if it was ever asked for.
pub async fn access<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
) -> Result<Option<DbCalendarAccess>> {
    Ok(sqlx::query_as!(
        DbCalendarAccess,
        r#"SELECT status, detail, checked_at, synced_at, settings_checked_at, time_zone,
                  week_start
           FROM calendar_access WHERE account_id = ?"#,
        account_id
    )
    .fetch_optional(ex)
    .await?)
}

/// Record a sync attempt at `now_ms`; `on` also records it as the last sync that worked.
pub async fn set_access<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    status: &str,
    detail: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO calendar_access (account_id, status, detail, checked_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?2 = 'on' THEN ?4 END)
         ON CONFLICT (account_id) DO UPDATE SET
             status = excluded.status,
             detail = excluded.detail,
             checked_at = excluded.checked_at,
             synced_at = CASE WHEN ?2 = 'on' THEN ?4 ELSE calendar_access.synced_at END",
        account_id,
        status,
        detail,
        now_ms
    )
    .execute(ex)
    .await?;
    Ok(())
}

/// Store the user's Google Calendar settings, read at `now_ms`.
pub async fn set_settings<'e>(
    ex: impl SqliteExecutor<'e>,
    account_id: &str,
    time_zone: Option<&str>,
    week_start: Option<i64>,
    now_ms: i64,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO calendar_access (account_id, status, checked_at, settings_checked_at,
             time_zone, week_start)
         VALUES (?1, 'unknown', ?4, ?4, ?2, ?3)
         ON CONFLICT (account_id) DO UPDATE SET
             settings_checked_at = excluded.settings_checked_at,
             time_zone = excluded.time_zone,
             week_start = excluded.week_start",
        account_id,
        time_zone,
        week_start,
        now_ms
    )
    .execute(ex)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn cal(id: &str) -> DbCalendar {
        DbCalendar {
            account_id: "a".into(),
            id: id.into(),
            summary: format!("Calendar {id}"),
            description: None,
            time_zone: Some("America/New_York".into()),
            background_color: Some("#9fe1e7".into()),
            foreground_color: Some("#000000".into()),
            access_role: "owner".into(),
            primary: id == "me@example.com",
            hidden: false,
            default_reminders: "[]".into(),
            sync_token: None,
        }
    }

    pub(crate) fn event(calendar_id: &str, id: &str, start_ms: i64, end_ms: i64) -> DbEvent {
        DbEvent {
            account_id: "a".into(),
            calendar_id: calendar_id.into(),
            id: id.into(),
            ical_uid: Some(format!("{id}@google.com")),
            recurring_event_id: None,
            original_start_ms: None,
            original_start_date: None,
            status: "confirmed".into(),
            start_ms: Some(start_ms),
            end_ms: Some(end_ms),
            start_date: None,
            end_date: None,
            time_zone: Some("America/New_York".into()),
            recurrence: None,
            recur_until_ms: None,
            summary: Some(id.into()),
            location: None,
            description: None,
            organizer_email: None,
            self_response: None,
            attendees: "[]".into(),
            conference: None,
            color_id: None,
            transparency: None,
            visibility: None,
            reminders: None,
            html_link: None,
            etag: "\"1\"".into(),
            updated_ms: 0,
            raw: "{}".into(),
        }
    }

    const H: i64 = 3_600_000;

    fn ids(events: &[DbEvent]) -> Vec<&str> {
        let mut ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
        ids.sort_unstable();
        ids
    }

    #[tokio::test]
    async fn replace_calendars_keeps_hidden_and_token_and_drops_missing() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("A"), cal("B")])
            .await
            .unwrap();
        set_hidden(pool, "a", "A", true).await.unwrap();
        apply_event_changes(pool, "a", "A", &[], &[], Some("t1"))
            .await
            .unwrap();
        apply_event_changes(pool, "a", "B", &[event("B", "b1", 0, H)], &[], None)
            .await
            .unwrap();

        let mut renamed = cal("A");
        renamed.summary = "Renamed".into();
        replace_calendars(pool, "a", &[renamed]).await.unwrap();

        let cals = calendars(pool, Some("a")).await.unwrap();
        assert_eq!(cals.len(), 1);
        assert_eq!(cals[0].summary, "Renamed");
        assert!(cals[0].hidden);
        assert_eq!(cals[0].sync_token.as_deref(), Some("t1"));
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn events_overlapping_returns_singles_masters_and_overrides() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C"), cal("Hidden")])
            .await
            .unwrap();
        set_hidden(pool, "a", "Hidden", true).await.unwrap();

        let single = event("C", "single", 10 * H, 11 * H);
        let mut open_series = event("C", "open", 0, H);
        open_series.recurrence = Some(r#"["RRULE:FREQ=DAILY"]"#.into());
        let mut ended = event("C", "ended", 0, H);
        ended.recurrence = Some(r#"["RRULE:FREQ=DAILY;COUNT=2"]"#.into());
        ended.recur_until_ms = Some(2 * H);
        let mut cancelled = event("C", "open_x", 0, 0);
        cancelled.status = "cancelled".into();
        cancelled.recurring_event_id = Some("open".into());
        cancelled.original_start_ms = Some(24 * H);
        cancelled.start_ms = None;
        cancelled.end_ms = None;
        apply_event_changes(
            pool,
            "a",
            "C",
            &[single, open_series, ended, cancelled],
            &[],
            None,
        )
        .await
        .unwrap();
        apply_event_changes(
            pool,
            "a",
            "Hidden",
            &[event("Hidden", "secret", 10 * H, 11 * H)],
            &[],
            None,
        )
        .await
        .unwrap();

        let got = events_overlapping(pool, 10 * H + H / 2, 12 * H)
            .await
            .unwrap();
        assert_eq!(ids(&got), vec!["open", "open_x", "single"]);
        let got = events_overlapping(pool, 11 * H, 12 * H).await.unwrap();
        assert_eq!(ids(&got), vec!["open", "open_x"]);
    }

    #[tokio::test]
    async fn all_day_rows_are_found_with_a_days_padding() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C")]).await.unwrap();
        // 2026-11-12 all day, stored at UTC midnight.
        let mut holiday = event("C", "holiday", 1_794_441_600_000, 1_794_528_000_000);
        holiday.start_date = Some("2026-11-12".into());
        holiday.end_date = Some("2026-11-13".into());
        apply_event_changes(pool, "a", "C", &[holiday], &[], None)
            .await
            .unwrap();
        // Morning of Nov 12 in Kiritimati (UTC+14) is Nov 11 10:00Z – 14:00Z, before the UTC
        // midnight the row is stored at: found anyway, and the caller trims by zone.
        let got = events_overlapping(pool, 1_794_391_200_000, 1_794_405_600_000)
            .await
            .unwrap();
        assert_eq!(ids(&got), vec!["holiday"]);
    }

    #[tokio::test]
    async fn apply_event_changes_is_atomic_and_upserts() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C")]).await.unwrap();
        apply_event_changes(
            pool,
            "a",
            "C",
            &[event("C", "e1", 0, H), event("C", "e2", 0, H)],
            &[],
            Some("t1"),
        )
        .await
        .unwrap();
        let mut moved = event("C", "e1", 5 * H, 6 * H);
        moved.etag = "\"2\"".into();
        apply_event_changes(pool, "a", "C", &[moved], &["e2".into()], Some("t2"))
            .await
            .unwrap();

        let got = events_overlapping(pool, 0, 24 * H).await.unwrap();
        assert_eq!(ids(&got), vec!["e1"]);
        assert_eq!(got[0].start_ms, Some(5 * H));
        assert_eq!(got[0].etag, "\"2\"");
        let cals = calendars(pool, Some("a")).await.unwrap();
        assert_eq!(cals[0].sync_token.as_deref(), Some("t2"));

        // A calendar that isn't stored is refused (foreign key), and nothing else changes.
        let err = apply_event_changes(
            pool,
            "a",
            "Gone",
            &[event("Gone", "e3", 0, H)],
            &[],
            Some("t3"),
        )
        .await;
        assert!(err.is_err());
        assert_eq!(
            ids(&events_overlapping(pool, 0, 24 * H).await.unwrap()),
            vec!["e1"]
        );
        let cals = calendars(pool, Some("a")).await.unwrap();
        assert_eq!(cals[0].sync_token.as_deref(), Some("t2"));
    }

    #[tokio::test]
    async fn deleting_a_series_deletes_its_changed_occurrences() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C")]).await.unwrap();
        let mut series = event("C", "s", 0, H);
        series.recurrence = Some(r#"["RRULE:FREQ=DAILY"]"#.into());
        let mut moved = event("C", "s_1", 30 * H, 31 * H);
        moved.recurring_event_id = Some("s".into());
        moved.original_start_ms = Some(24 * H);
        apply_event_changes(pool, "a", "C", &[series, moved], &[], None)
            .await
            .unwrap();

        apply_event_changes(pool, "a", "C", &[], &["s".into()], None)
            .await
            .unwrap();

        assert!(events_overlapping(pool, 0, 48 * H)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn clear_calendar_events_drops_rows_and_token() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C")]).await.unwrap();
        apply_event_changes(pool, "a", "C", &[event("C", "e1", 0, H)], &[], Some("t"))
            .await
            .unwrap();
        clear_calendar_events(pool, "a", "C").await.unwrap();
        assert!(events_overlapping(pool, 0, H).await.unwrap().is_empty());
        assert_eq!(
            calendars(pool, Some("a")).await.unwrap()[0].sync_token,
            None
        );
    }

    #[tokio::test]
    async fn access_and_settings_round_trip() {
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        assert_eq!(access(pool, "a").await.unwrap(), None);
        set_access(pool, "a", "missing_scope", None, 5)
            .await
            .unwrap();
        set_settings(pool, "a", Some("Europe/Paris"), Some(1), 6)
            .await
            .unwrap();
        set_access(pool, "a", "on", None, 7).await.unwrap();
        let got = access(pool, "a").await.unwrap().unwrap();
        assert_eq!(got.status, "on");
        assert_eq!(got.checked_at, 7);
        assert_eq!(got.synced_at, Some(7));
        assert_eq!(got.time_zone.as_deref(), Some("Europe/Paris"));
        assert_eq!(got.week_start, Some(1));
        assert_eq!(got.settings_checked_at, Some(6));
        set_access(pool, "a", "error", Some("boom"), 8)
            .await
            .unwrap();
        let got = access(pool, "a").await.unwrap().unwrap();
        assert_eq!(got.synced_at, Some(7));
        assert_eq!(got.detail.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn delete_overrides_from_keeps_earlier_ones() {
        use super::event as stored;
        let db = TestDb::with_account("a").await;
        let pool = &db.pool;
        replace_calendars(pool, "a", &[cal("C")]).await.unwrap();
        let mut series = event("C", "s", 0, H);
        series.recurrence = Some(r#"["RRULE:FREQ=DAILY"]"#.into());
        let over = |id: &str, at: i64| {
            let mut e = event("C", id, at, at + H);
            e.recurring_event_id = Some("s".into());
            e.original_start_ms = Some(at);
            e
        };
        let mut other = over("t_1", 48 * H);
        other.recurring_event_id = Some("t".into());
        apply_event_changes(
            pool,
            "a",
            "C",
            &[
                series,
                over("s_1", 24 * H),
                over("s_2", 48 * H),
                over("s_3", 72 * H),
                other,
            ],
            &[],
            None,
        )
        .await
        .unwrap();

        let n = delete_overrides_from(pool, "a", "C", "s", 48 * H)
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert!(stored(pool, "a", "C", "s_1").await.unwrap().is_some());
        assert!(stored(pool, "a", "C", "s_2").await.unwrap().is_none());
        assert!(stored(pool, "a", "C", "s_3").await.unwrap().is_none());
        assert!(stored(pool, "a", "C", "t_1").await.unwrap().is_some());
        assert!(stored(pool, "a", "C", "s").await.unwrap().is_some());
        let same = events_by_ical_uid(pool, "a", "s_1@google.com")
            .await
            .unwrap();
        assert_eq!(ids(&same), vec!["s_1"]);
    }
}
