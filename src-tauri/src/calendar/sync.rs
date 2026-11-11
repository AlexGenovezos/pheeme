//! Keeping an account's calendars and events current: the calendar list and settings, then
//! each calendar's events with its sync token (a full sync when there's none, or when Google
//! answers 410 Gone).

use super::convert::{self, EventChange};
use super::CalendarApi;
use crate::db::calendar as cache;
use crate::gmail::GmailError;
use sqlx::SqlitePool;
use tracing::warn;

/// Pages of the calendar list read per sync, so a broken page token can't loop forever.
const MAX_LIST_PAGES: usize = 20;
/// Pages of 2,500 events per calendar per sync.
const MAX_EVENT_PAGES: usize = 400;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Any calendar or event row changed.
    pub changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Api(GmailError),
    #[error("calendar cache: {0}")]
    Db(#[from] anyhow::Error),
}

impl From<GmailError> for SyncError {
    fn from(e: GmailError) -> Self {
        SyncError::Api(e)
    }
}

/// The access status an error means: `missing_scope` (allow calendar access again),
/// `api_disabled` (with the Google Cloud project number when Google gave it) or `error`.
pub fn classify(e: &GmailError) -> (&'static str, Option<String>) {
    if e.is_missing_scope() {
        ("missing_scope", None)
    } else if e.is_api_disabled() {
        ("api_disabled", e.disabled_api_project())
    } else {
        ("error", Some(e.to_string()))
    }
}

/// An error that stops the whole account's sync (rather than one calendar's).
fn is_account_wide(e: &GmailError) -> bool {
    e.is_missing_scope()
        || e.is_api_disabled()
        || !matches!(
            e,
            GmailError::Api {
                status: 403 | 404,
                ..
            }
        )
}

/// Bring the account's calendars and events up to date. The calendar list and settings are
/// read when `refresh_list` is set or nothing is stored yet; then every calendar's events.
pub async fn sync_account(
    db: &SqlitePool,
    api: &dyn CalendarApi,
    account_id: &str,
    now_ms: i64,
    refresh_list: bool,
) -> Result<SyncReport, SyncError> {
    let mut report = SyncReport::default();
    let mut calendars = cache::calendars(db, Some(account_id)).await?;
    if refresh_list || calendars.is_empty() {
        let before: Vec<String> = calendars.iter().map(|c| c.id.clone()).collect();
        sync_calendar_list(db, api, account_id, now_ms).await?;
        calendars = cache::calendars(db, Some(account_id)).await?;
        let after: Vec<String> = calendars.iter().map(|c| c.id.clone()).collect();
        report.changed |= before != after;
    }
    for cal in &calendars {
        match sync_calendar(
            db,
            api,
            account_id,
            &cal.id,
            cal.time_zone.as_deref(),
            cal.sync_token.clone(),
        )
        .await
        {
            Ok(changed) => report.changed |= changed,
            Err(SyncError::Api(e)) if !is_account_wide(&e) => {
                // Unsubscribed or no longer shared: the next list refresh drops it.
                warn!(error = %e, "skipping a calendar Google refused");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(report)
}

async fn sync_calendar_list(
    db: &SqlitePool,
    api: &dyn CalendarApi,
    account_id: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let mut rows = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_LIST_PAGES {
        let page = api.list_calendar_list(page_token.as_deref()).await?;
        rows.extend(
            page.items
                .iter()
                .filter(|c| !c.deleted)
                .map(|c| convert::calendar(account_id, c)),
        );
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    cache::replace_calendars(db, account_id, &rows).await?;
    match api.calendar_settings().await {
        Ok(settings) => {
            cache::set_settings(
                db,
                account_id,
                settings.time_zone.as_deref(),
                settings.week_start.map(i64::from),
                now_ms,
            )
            .await?;
        }
        Err(e) if is_account_wide(&e) && !e.is_missing_scope() => return Err(e.into()),
        // Settings only refine the view (zone, week start); without them, defaults.
        Err(e) => warn!(error = %e, "couldn't read Calendar settings"),
    }
    Ok(())
}

/// Sync one calendar's events; returns whether any row changed.
async fn sync_calendar(
    db: &SqlitePool,
    api: &dyn CalendarApi,
    account_id: &str,
    calendar_id: &str,
    zone: Option<&str>,
    mut sync_token: Option<String>,
) -> Result<bool, SyncError> {
    let mut changed = false;
    let mut restarted = false;
    let mut page_token: Option<String> = None;
    let mut pages = 0;
    loop {
        let page = match api
            .list_events(calendar_id, sync_token.as_deref(), page_token.as_deref())
            .await
        {
            Ok(page) => page,
            Err(e) if e.is_gone() && !restarted => {
                // The token expired: forget the calendar's events and sync it in full.
                cache::clear_calendar_events(db, account_id, calendar_id).await?;
                restarted = true;
                changed = true;
                sync_token = None;
                page_token = None;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let mut upserts = Vec::new();
        let mut deleted = Vec::new();
        for item in &page.items {
            match convert::event(account_id, calendar_id, zone, item) {
                EventChange::Upsert(row) => upserts.push(*row),
                EventChange::Delete(id) => deleted.push(id),
            }
        }
        changed |= !upserts.is_empty() || !deleted.is_empty();
        pages += 1;
        let last = page.next_page_token.is_none() || pages >= MAX_EVENT_PAGES;
        let token = if last {
            page.next_sync_token.as_deref()
        } else {
            None
        };
        cache::apply_event_changes(db, account_id, calendar_id, &upserts, &deleted, token).await?;
        if last {
            return Ok(changed);
        }
        page_token = page.next_page_token;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::{calendar, timed, FakeCalendar};
    use crate::db::calendar as cache;
    use crate::db::test_support::TestDb;
    use crate::gmail::calendar::CalendarSettings;
    use serde_json::json;

    fn ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    async fn all_events(pool: &sqlx::SqlitePool) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> =
            sqlx::query_as("SELECT calendar_id, id FROM events ORDER BY calendar_id, id")
                .fetch_all(pool)
                .await
                .unwrap();
        rows.sort();
        rows
    }

    fn fake_with_two_calendars() -> FakeCalendar {
        let fake = FakeCalendar::default();
        let mut primary = calendar("me@example.com");
        primary.primary = true;
        fake.add_calendar(primary);
        fake.add_calendar(calendar("team"));
        for (id, start) in [("e1", "09"), ("e2", "10"), ("e3", "11")] {
            fake.put(
                "me@example.com",
                timed(
                    id,
                    id,
                    &format!("2026-11-12T{start}:00:00-05:00"),
                    &format!("2026-11-12T{start}:30:00-05:00"),
                ),
            );
        }
        fake.put(
            "team",
            timed(
                "t1",
                "Team",
                "2026-11-13T09:00:00-05:00",
                "2026-11-13T10:00:00-05:00",
            ),
        );
        fake.set_settings(CalendarSettings {
            time_zone: Some("America/New_York".into()),
            week_start: Some(1),
        });
        fake
    }

    #[tokio::test]
    async fn first_sync_stores_calendars_events_and_tokens() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();

        let report = sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();

        assert!(report.changed);
        let cals = cache::calendars(&db.pool, Some("a")).await.unwrap();
        assert_eq!(cals.len(), 2);
        assert!(cals.iter().all(|c| c.sync_token.is_some()));
        assert!(cals[0].primary);
        assert_eq!(
            all_events(&db.pool).await,
            vec![
                ("me@example.com".into(), "e1".into()),
                ("me@example.com".into(), "e2".into()),
                ("me@example.com".into(), "e3".into()),
                ("team".into(), "t1".into()),
            ]
        );
        let e1 = cache::events_overlapping(
            &db.pool,
            ms("2026-11-12T14:00:00Z"),
            ms("2026-11-12T14:10:00Z"),
        )
        .await
        .unwrap();
        assert_eq!(e1[0].start_ms, Some(ms("2026-11-12T09:00:00-05:00")));
        assert_eq!(e1[0].time_zone.as_deref(), Some("America/New_York"));
        let access = cache::access(&db.pool, "a").await.unwrap().unwrap();
        assert_eq!(access.time_zone.as_deref(), Some("America/New_York"));
        assert_eq!(access.week_start, Some(1));
    }

    #[tokio::test]
    async fn incremental_sync_applies_updates_and_deletes() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();

        fake.put(
            "me@example.com",
            timed(
                "e1",
                "Moved",
                "2026-11-12T16:00:00-05:00",
                "2026-11-12T17:00:00-05:00",
            ),
        );
        fake.cancel("me@example.com", "e2");
        let report = sync_account(&db.pool, &fake, "a", 2, false).await.unwrap();

        assert!(report.changed);
        let ids: Vec<String> = all_events(&db.pool)
            .await
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        assert_eq!(ids, vec!["e1", "e3", "t1"]);
        let moved = cache::events_overlapping(
            &db.pool,
            ms("2026-11-12T21:00:00Z"),
            ms("2026-11-12T21:30:00Z"),
        )
        .await
        .unwrap();
        assert_eq!(moved[0].summary.as_deref(), Some("Moved"));

        let report = sync_account(&db.pool, &fake, "a", 3, false).await.unwrap();
        assert!(!report.changed);
    }

    #[tokio::test]
    async fn gone_token_resyncs_and_drops_stale_events() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();

        fake.forget("me@example.com", "e3");
        fake.expire_tokens();
        sync_account(&db.pool, &fake, "a", 2, false).await.unwrap();

        let ids: Vec<String> = all_events(&db.pool)
            .await
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        assert_eq!(ids, vec!["e1", "e2", "t1"]);
        let cals = cache::calendars(&db.pool, Some("a")).await.unwrap();
        assert!(cals.iter().all(|c| c.sync_token.is_some()));
        // And the next sync is incremental again.
        assert!(
            !sync_account(&db.pool, &fake, "a", 3, false)
                .await
                .unwrap()
                .changed
        );
    }

    #[tokio::test]
    async fn calendar_removed_from_list_drops_its_events() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();

        fake.remove_calendar("team");
        let report = sync_account(&db.pool, &fake, "a", 2, true).await.unwrap();

        assert!(report.changed);
        let cals = cache::calendars(&db.pool, Some("a")).await.unwrap();
        assert_eq!(cals.len(), 1);
        assert!(all_events(&db.pool).await.iter().all(|(c, _)| c != "team"));
    }

    #[tokio::test]
    async fn calendar_that_vanished_between_list_and_events_is_skipped() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();
        // Still in our list, but Google now answers 404 for its events.
        fake.remove_calendar("team");
        fake.put(
            "me@example.com",
            timed(
                "e4",
                "New",
                "2026-11-14T09:00:00-05:00",
                "2026-11-14T10:00:00-05:00",
            ),
        );
        let report = sync_account(&db.pool, &fake, "a", 2, false).await.unwrap();
        assert!(report.changed);
        assert!(all_events(&db.pool)
            .await
            .contains(&("me@example.com".into(), "e4".into())));
    }

    #[tokio::test]
    async fn missing_scope_is_returned_for_the_caller() {
        let db = TestDb::with_account("a").await;
        let fake = fake_with_two_calendars();
        fake.fail_with(|| GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        });
        let error = sync_account(&db.pool, &fake, "a", 1, false)
            .await
            .unwrap_err();
        let SyncError::Api(error) = error else {
            panic!("expected an API error");
        };
        assert_eq!(classify(&error), ("missing_scope", None));
    }

    #[test]
    fn classify_maps_permission_errors() {
        let scope = GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        };
        assert_eq!(classify(&scope), ("missing_scope", None));
        let disabled = GmailError::Api {
            status: 403,
            reason: Some("accessNotConfigured".into()),
            message:
                "Google Calendar API has not been used in project 1234 before or it is disabled."
                    .into(),
        };
        assert_eq!(classify(&disabled), ("api_disabled", Some("1234".into())));
        let other = GmailError::Api {
            status: 500,
            reason: None,
            message: "Backend Error".into(),
        };
        assert_eq!(classify(&other).0, "error");
    }

    #[tokio::test]
    async fn override_moved_and_cancelled_are_stored_with_original_start() {
        let db = TestDb::with_account("a").await;
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("me@example.com"));
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../gmail/fixtures/calendar_events.json")).unwrap();
        for item in fixture["items"].as_array().unwrap() {
            fake.put("me@example.com", item.clone());
        }
        // `gone1` arrives cancelled with no series: nothing to store.
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();

        type Row = (String, String, Option<String>, Option<i64>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, status, recurring_event_id, original_start_ms, recurrence FROM events ORDER BY id",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "allday1",
                "series1",
                "series1_20261102T140000Z",
                "series1_20261109T140000Z",
                "timed1"
            ]
        );
        let cancelled = &rows[2];
        assert_eq!(cancelled.1, "cancelled");
        assert_eq!(cancelled.2.as_deref(), Some("series1"));
        assert_eq!(cancelled.3, Some(ms("2026-11-02T09:00:00-05:00")));
        let moved = &rows[3];
        assert_eq!(moved.3, Some(ms("2026-11-09T09:00:00-05:00")));
        assert!(rows[1].4.as_deref().unwrap().contains("RRULE:FREQ=WEEKLY"));

        let timed1: (Option<String>, String, Option<String>) = sqlx::query_as(
            "SELECT self_response, attendees, conference FROM events WHERE id = 'timed1'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(timed1.0.as_deref(), Some("needsAction"));
        let attendees: serde_json::Value = serde_json::from_str(&timed1.1).unwrap();
        assert_eq!(attendees.as_array().unwrap().len(), 4);
        assert!(timed1.2.unwrap().contains("meet.google.com"));

        let all_day: (Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT start_date, end_date, start_ms FROM events WHERE id = 'allday1'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(all_day.0.as_deref(), Some("2026-11-12"));
        assert_eq!(all_day.1.as_deref(), Some("2026-11-13"));
        assert_eq!(all_day.2, Some(ms("2026-11-12T00:00:00Z")));
    }

    #[tokio::test]
    async fn organizer_without_attendees_counts_as_accepted() {
        let db = TestDb::with_account("a").await;
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("me@example.com"));
        let mut own = timed(
            "own",
            "Mine",
            "2026-11-12T09:00:00-05:00",
            "2026-11-12T10:00:00-05:00",
        );
        own["organizer"] = json!({"email": "me@example.com", "self": true});
        fake.put("me@example.com", own);
        sync_account(&db.pool, &fake, "a", 1, false).await.unwrap();
        let response: Option<String> =
            sqlx::query_scalar("SELECT self_response FROM events WHERE id = 'own'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(response.as_deref(), Some("accepted"));
    }
}
