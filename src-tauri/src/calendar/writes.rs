//! Calendar writes: create, edit, delete, move and copy events, plus their plumbing (what an
//! event id points at, whether a calendar can be changed, caching Google's answer). Nothing
//! is cached until Google confirms a change. Changes to repeating events ("this", "this
//! and following", "all") are in `repeating.rs`.

use super::convert::{self, EventChange};
use super::edit::{self, EventEdit, OriginalStart, TimeInput};
use super::error::CalendarError;
use super::recurrence;
use super::repeating::Resolved;
use super::service::{unstored_occurrence, CalendarService};
use crate::db;
use crate::db::calendar::{DbCalendar, DbEvent};
use crate::gmail::calendar::{ApiEvent, SendUpdates, WriteOptions};
use crate::gmail::GmailError;
use crate::sync::SyncEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which events of a series a change applies to. Any scope on a single event is that event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditScope {
    This,
    Following,
    All,
}

/// Fields of an event resource a copy must not carry: Google's ids and bookkeeping, and the
/// original's conference (a copy gets its own Meet).
pub(super) const NOT_COPIED: [&str; 13] = [
    "id",
    "iCalUID",
    "etag",
    "htmlLink",
    "created",
    "updated",
    "creator",
    "organizer",
    "sequence",
    "recurringEventId",
    "originalStartTime",
    "hangoutLink",
    "conferenceData",
];

/// Where a written event lives, returned by commands so the UI can select it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRef {
    pub account_id: String,
    pub calendar_id: String,
    pub id: String,
}

/// What an event id addresses.
#[derive(Debug, Clone)]
pub(super) enum Target {
    /// A cached row: a single event, a series, or a changed occurrence.
    Stored(Box<DbEvent>),
    /// An occurrence of a series that Google has no row for yet (never changed).
    Occurrence {
        master: Box<DbEvent>,
        at: OriginalStart,
    },
}

/// Whether the role allows changing events.
pub(super) fn can_write(calendar: &DbCalendar) -> bool {
    matches!(calendar.access_role.as_str(), "owner" | "writer")
}

/// Whether this account may change the event's details (not just its RSVP): the calendar is
/// writable and the account organizes the event, or the organizer lets guests modify it.
/// `flags` is the resource carrying `organizer` and `guestsCanModify` (an occurrence's series).
pub(super) fn can_edit(calendar: &DbCalendar, flags: &Value) -> bool {
    let organizer: Option<crate::gmail::calendar::ApiPerson> = flags
        .get("organizer")
        .and_then(|o| serde_json::from_value(o.clone()).ok());
    let guests_can_modify = flags
        .get("guestsCanModify")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    can_write(calendar) && (organizer.is_none_or(|o| o.is_self) || guests_can_modify)
}

/// A new event id made here, so a retried insert can't create the event twice.
pub(super) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn raw(e: &DbEvent) -> Value {
    serde_json::from_str(&e.raw).unwrap_or_default()
}

/// The calendar's zone for times given without one.
pub(super) fn zone_of(calendar: &DbCalendar) -> &str {
    calendar.time_zone.as_deref().unwrap_or("UTC")
}

/// Whether the event (or its series) has a Google Meet.
fn has_meet(raw: &Value) -> bool {
    let conference = &raw["conferenceData"];
    raw["hangoutLink"].is_string()
        || conference["conferenceSolution"]["key"]["type"] == "hangoutsMeet"
        || conference["createRequest"]["conferenceSolutionKey"]["type"] == "hangoutsMeet"
}

impl CalendarService {
    /// Resolves `id`: a cached row, or an instance id of a cached series (checked against the
    /// series' rule). Cancelled rows and anything else are `NotFound`.
    pub(super) async fn target(
        &self,
        account_id: &str,
        calendar_id: &str,
        id: &str,
    ) -> Result<Target, CalendarError> {
        if let Some(e) = db::calendar::event(&self.db, account_id, calendar_id, id).await? {
            return if e.status == "cancelled" {
                Err(CalendarError::NotFound)
            } else {
                Ok(Target::Stored(Box::new(e)))
            };
        }
        let (master_id, at) = edit::parse_instance_id(id).ok_or(CalendarError::NotFound)?;
        let master = db::calendar::event(&self.db, account_id, calendar_id, &master_id)
            .await?
            .filter(|m| m.recurrence.is_some() && m.status != "cancelled")
            .ok_or(CalendarError::NotFound)?;
        if master.is_all_day() != matches!(at, OriginalStart::Date(_)) {
            return Err(CalendarError::NotFound);
        }
        let lines = recurrence::recurrence_lines(&master);
        if recurrence::position(&master, &lines, &at).is_some_and(|p| !p.is_occurrence) {
            return Err(CalendarError::NotFound);
        }
        Ok(Target::Occurrence {
            master: Box::new(master),
            at,
        })
    }

    /// The calendar, if its role lets this account change events.
    pub(super) async fn writable(
        &self,
        account_id: &str,
        calendar_id: &str,
    ) -> Result<DbCalendar, CalendarError> {
        let calendar = self.calendar(account_id, calendar_id).await?;
        if can_write(&calendar) {
            Ok(calendar)
        } else {
            Err(CalendarError::ReadOnly(
                "You can't change events on this calendar.".into(),
            ))
        }
    }

    pub(super) async fn calendar(
        &self,
        account_id: &str,
        calendar_id: &str,
    ) -> Result<DbCalendar, CalendarError> {
        db::calendar::calendars(&self.db, Some(account_id))
            .await?
            .into_iter()
            .find(|c| c.id == calendar_id)
            .ok_or(CalendarError::NotFound)
    }

    /// Caches Google's confirmed version of an event, tells the UI, and asks for a sync soon.
    pub(super) async fn save(
        &self,
        account_id: &str,
        calendar_id: &str,
        api_event: ApiEvent,
    ) -> Result<EventRef, CalendarError> {
        let id = api_event.id.clone();
        self.save_all(account_id, calendar_id, vec![api_event])
            .await?;
        Ok(EventRef {
            account_id: account_id.to_owned(),
            calendar_id: calendar_id.to_owned(),
            id,
        })
    }

    /// [`Self::save`] for several events of one calendar, telling the UI once.
    pub(super) async fn save_all(
        &self,
        account_id: &str,
        calendar_id: &str,
        api_events: Vec<ApiEvent>,
    ) -> Result<(), CalendarError> {
        let calendar = self.calendar(account_id, calendar_id).await?;
        let (mut upserts, mut deleted) = (Vec::new(), Vec::new());
        for api_event in &api_events {
            match convert::event(
                account_id,
                calendar_id,
                calendar.time_zone.as_deref(),
                api_event,
            ) {
                EventChange::Upsert(e) => upserts.push(*e),
                EventChange::Delete(id) => deleted.push(id),
            }
        }
        db::calendar::apply_event_changes(
            &self.db,
            account_id,
            calendar_id,
            &upserts,
            &deleted,
            None,
        )
        .await?;
        self.events.emit(SyncEvent::CalendarUpdated {
            account_id: account_id.to_owned(),
        });
        self.trigger(Some(account_id.to_owned()));
        Ok(())
    }

    /// After a 412: fetch Google's current version and cache it. Errors are ignored; the
    /// command reports the conflict either way.
    pub(super) async fn refresh_after_conflict(
        &self,
        account_id: &str,
        calendar_id: &str,
        id: &str,
    ) {
        let api = (self.api_for)(account_id);
        if let Ok(e) = api.get_event(calendar_id, id).await {
            let _ = self.save(account_id, calendar_id, e).await;
        }
    }

    /// Turns Google's answer into the command's: after a 412 the current version is cached
    /// first (`id`, when the write had an etag), and an unconfirmed write, or one Google has
    /// no event for, asks for a sync so the calendar soon shows what Google has.
    pub(super) async fn settle<T>(
        &self,
        account_id: &str,
        calendar_id: &str,
        id: Option<&str>,
        result: Result<T, GmailError>,
    ) -> Result<T, CalendarError> {
        match result.map_err(CalendarError::from) {
            Err(CalendarError::Conflict) => {
                if let Some(id) = id {
                    self.refresh_after_conflict(account_id, calendar_id, id)
                        .await;
                }
                Err(CalendarError::Conflict)
            }
            Err(e @ (CalendarError::Unconfirmed | CalendarError::NotFound)) => {
                self.trigger(Some(account_id.to_owned()));
                Err(e)
            }
            other => other,
        }
    }

    /// Removes an event (a series with its occurrences) from the cache after Google
    /// confirmed it is gone from this calendar.
    pub(super) async fn uncache(
        &self,
        account_id: &str,
        calendar_id: &str,
        id: &str,
    ) -> Result<(), CalendarError> {
        db::calendar::apply_event_changes(
            &self.db,
            account_id,
            calendar_id,
            &[],
            &[id.to_owned()],
            None,
        )
        .await?;
        Ok(())
    }

    /// Creates an event on a calendar this account can write to.
    pub async fn create_event(
        &self,
        account_id: &str,
        calendar_id: &str,
        edit: EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        let calendar = self.writable(account_id, calendar_id).await?;
        edit::validate(&edit, true)?;
        let mut body = edit::body(&edit, None, zone_of(&calendar));
        body["id"] = Value::String(new_id());
        let opts = WriteOptions {
            send_updates: send,
            if_match: None,
            conference: edit::touches_conference(&edit, None),
        };
        let api = (self.api_for)(account_id);
        let result = api.insert_event(calendar_id, body, opts).await;
        let event = self.settle(account_id, calendar_id, None, result).await?;
        self.save(account_id, calendar_id, event).await
    }

    /// Changes an event. A single event ignores `scope`; for a repeating one it says which
    /// occurrences change.
    pub async fn update_event(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        scope: EditScope,
        edit: EventEdit,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        let calendar = self.writable(account_id, calendar_id).await?;
        let target = self.target(account_id, calendar_id, event_id).await?;
        let event = match self.resolve(account_id, calendar_id, target, scope).await? {
            Resolved::Single(e) => e,
            Resolved::Series(s) => {
                return self.update_in_series(&calendar, s, scope, edit, send).await
            }
        };
        let existing = raw(&event);
        if !can_edit(&calendar, &existing) {
            return Err(CalendarError::ReadOnly(
                "Only the organizer can change this event.".into(),
            ));
        }
        edit::validate(&edit, false)?;
        let zone = event
            .time_zone
            .as_deref()
            .unwrap_or_else(|| zone_of(&calendar));
        let body = edit::body(&edit, Some(&existing), zone);
        let opts = WriteOptions {
            send_updates: send,
            if_match: Some(&event.etag),
            conference: edit::touches_conference(&edit, Some(&existing)),
        };
        let api = (self.api_for)(account_id);
        let result = api.patch_event(calendar_id, &event.id, body, opts).await;
        let saved = self
            .settle(account_id, calendar_id, Some(&event.id), result)
            .await?;
        self.save(account_id, calendar_id, saved).await
    }

    /// Deletes an event. A single event ignores `scope`; for a repeating one it says which
    /// occurrences go.
    pub async fn delete_event(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        scope: EditScope,
        send: SendUpdates,
    ) -> Result<(), CalendarError> {
        let calendar = self.writable(account_id, calendar_id).await?;
        let target = self.target(account_id, calendar_id, event_id).await?;
        match self.resolve(account_id, calendar_id, target, scope).await? {
            Resolved::Single(e) => self.delete_stored(account_id, calendar_id, &e, send).await,
            Resolved::Series(s) => self.delete_in_series(&calendar, s, scope, send).await,
        }
    }

    /// Deletes a stored event (a series with its occurrences), then uncaches it.
    pub(super) async fn delete_stored(
        &self,
        account_id: &str,
        calendar_id: &str,
        event: &DbEvent,
        send: SendUpdates,
    ) -> Result<(), CalendarError> {
        let opts = WriteOptions {
            send_updates: send,
            if_match: Some(&event.etag),
            conference: false,
        };
        let api = (self.api_for)(account_id);
        let result = api.delete_event(calendar_id, &event.id, opts).await;
        self.settle(account_id, calendar_id, Some(&event.id), result)
            .await?;
        self.uncache(account_id, calendar_id, &event.id).await?;
        self.events.emit(SyncEvent::CalendarUpdated {
            account_id: account_id.to_owned(),
        });
        self.trigger(Some(account_id.to_owned()));
        Ok(())
    }

    /// Moves an event, or a whole series, to another calendar of the same account (Google
    /// makes that calendar the organizer). The event keeps its id.
    pub async fn move_event(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        destination_calendar_id: &str,
        send: SendUpdates,
    ) -> Result<EventRef, CalendarError> {
        let source = self.writable(account_id, calendar_id).await?;
        let event = match self.target(account_id, calendar_id, event_id).await? {
            Target::Stored(e) if e.recurring_event_id.is_none() => e,
            _ => {
                return Err(CalendarError::Invalid(
                    "Only a whole repeating series can move to another calendar.".into(),
                ))
            }
        };
        if !can_edit(&source, &raw(&event)) {
            return Err(CalendarError::ReadOnly(
                "Only the organizer can change this event.".into(),
            ));
        }
        if destination_calendar_id == calendar_id {
            return Err(CalendarError::Invalid(
                "The event is already on that calendar.".into(),
            ));
        }
        self.writable(account_id, destination_calendar_id).await?;
        let api = (self.api_for)(account_id);
        let result = api
            .move_event(calendar_id, &event.id, destination_calendar_id, send)
            .await;
        let moved = self.settle(account_id, calendar_id, None, result).await?;
        // The series' changed occurrences leave the source with it; sync brings them back
        // under the destination.
        self.uncache(account_id, calendar_id, &event.id).await?;
        self.save(account_id, destination_calendar_id, moved).await
    }

    /// Copies an event to a calendar of any account (Duplicate is a copy to the same
    /// calendar). An occurrence becomes a single event at its times; a series stays a
    /// series. A Meet on the original gets the copy a Meet of its own. Guests aren't emailed.
    pub async fn copy_event(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        to_account_id: &str,
        to_calendar_id: &str,
    ) -> Result<EventRef, CalendarError> {
        self.calendar(account_id, calendar_id).await?;
        let destination = self.writable(to_account_id, to_calendar_id).await?;
        let zone = zone_of(&destination);
        let (mut body, times) = match self.target(account_id, calendar_id, event_id).await? {
            Target::Stored(e) => (raw(&e), None),
            Target::Occurrence { master, at } => {
                let (occ, _) = unstored_occurrence(&master, event_id, &at);
                let time = |ms: Option<i64>, date: Option<String>| TimeInput {
                    ms: date.is_none().then_some(ms).flatten(),
                    date,
                    time_zone: master.time_zone.clone(),
                };
                let times = EventEdit {
                    start: Some(time(occ.start_ms, occ.start_date)),
                    end: Some(time(occ.end_ms, occ.end_date)),
                    ..Default::default()
                };
                (raw(&master), Some(times))
            }
        };
        let meet = has_meet(&body);
        let Some(fields) = body.as_object_mut() else {
            return Err(CalendarError::NotFound);
        };
        for key in NOT_COPIED {
            fields.remove(key);
        }
        if let Some(times) = times {
            fields.remove("recurrence");
            if let Value::Object(t) = edit::body(&times, None, zone) {
                fields.extend(t);
            }
        }
        let extra = EventEdit {
            conference: meet.then_some(true),
            ..Default::default()
        };
        if let Value::Object(c) = edit::body(&extra, None, zone) {
            fields.extend(c);
        }
        fields.insert("id".into(), Value::String(new_id()));
        let opts = WriteOptions {
            send_updates: SendUpdates::None,
            if_match: None,
            conference: meet,
        };
        let api = (self.api_for)(to_account_id);
        let result = api.insert_event(to_calendar_id, body, opts).await;
        let copy = self
            .settle(to_account_id, to_calendar_id, None, result)
            .await?;
        self.save(to_account_id, to_calendar_id, copy).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::edit::{EventEdit, TimeInput};
    use crate::calendar::fake::{calendar, timed};
    use crate::calendar::service::tests::{guest_event, harness, ms, standup_series, Harness};
    use crate::gmail::calendar::SendUpdates;
    use crate::gmail::GmailError;
    use crate::sync::engine::now_ms;
    use serde_json::json;

    const CAL: &str = "a@example.com";

    fn at(ms: i64) -> TimeInput {
        TimeInput {
            ms: Some(ms),
            date: None,
            time_zone: None,
        }
    }

    fn day(d: &str) -> TimeInput {
        TimeInput {
            ms: None,
            date: Some(d.into()),
            time_zone: None,
        }
    }

    fn lunch() -> EventEdit {
        EventEdit {
            summary: Some("Lunch".into()),
            start: Some(at(ms("2026-11-12T17:00:00Z"))),
            end: Some(at(ms("2026-11-12T18:00:00Z"))),
            ..Default::default()
        }
    }

    fn summary(s: &str) -> EventEdit {
        EventEdit {
            summary: Some(s.into()),
            ..Default::default()
        }
    }

    fn planning() -> serde_json::Value {
        timed(
            "e",
            "Old",
            "2026-11-10T10:00:00-05:00",
            "2026-11-10T11:00:00-05:00",
        )
    }

    /// Account `a` with the single event `e` ("Old") synced.
    async fn with_event() -> Harness {
        let h = harness(&["a"]).await;
        h.fake("a").put(CAL, planning());
        h.grant("a").await;
        h.events.take();
        h
    }

    async fn cached(h: &Harness, account: &str, cal: &str, id: &str) -> Option<DbEvent> {
        db::calendar::event(&h.service.db, account, cal, id)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn create_event_saves_googles_copy() {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        h.events.take();
        let r = h
            .service
            .create_event("a", CAL, lunch(), SendUpdates::None)
            .await
            .unwrap();
        assert_eq!((r.account_id.as_str(), r.calendar_id.as_str()), ("a", CAL));
        assert_eq!(r.id.len(), 32, "a client-made id: {}", r.id);
        assert!(r.id.bytes().all(|b| b.is_ascii_hexdigit()));

        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].method, "insert");
        assert_eq!(writes[0].body["id"], r.id.as_str());
        assert_eq!(writes[0].send_updates, Some(SendUpdates::None));
        assert_eq!(writes[0].if_match, None);
        assert!(!writes[0].conference);
        assert_eq!(writes[0].body["start"]["timeZone"], "America/New_York");

        let google = h.fake("a").event(CAL, &r.id).unwrap();
        let row = cached(&h, "a", CAL, &r.id).await.unwrap();
        assert_eq!(row.summary.as_deref(), Some("Lunch"));
        assert_eq!(serde_json::Value::String(row.etag.clone()), google["etag"]);
        assert_eq!(row.start_ms, Some(ms("2026-11-12T17:00:00Z")));
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn create_with_lost_reply_is_unconfirmed_and_shows_once() {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        h.fake("a").lose_reply(0);
        let err = h
            .service
            .create_event("a", CAL, lunch(), SendUpdates::None)
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Unconfirmed), "{err:?}");
        let count = || async {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE summary = 'Lunch'")
                .fetch_one(&h.service.db)
                .await
                .unwrap()
        };
        assert_eq!(count().await, 0, "nothing cached before Google confirms");

        h.service.tick(now_ms()).await;
        assert_eq!(count().await, 1);
    }

    #[tokio::test]
    async fn update_sends_if_match_and_none_by_default() {
        let h = with_event().await;
        let r = h
            .service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                summary("New"),
                SendUpdates::None,
            )
            .await
            .unwrap();
        assert_eq!(r.id, "e");
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "patch");
        assert_eq!(w.event_id.as_deref(), Some("e"));
        assert_eq!(w.if_match.as_deref(), Some("\"e\""));
        assert_eq!(w.send_updates, Some(SendUpdates::None));
        assert_eq!(w.body, json!({"summary": "New"}));
        assert!(!w.conference);

        let row = cached(&h, "a", CAL, "e").await.unwrap();
        assert_eq!(row.summary.as_deref(), Some("New"));
        assert_eq!(
            json!(row.etag),
            h.fake("a").event(CAL, "e").unwrap()["etag"]
        );
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn update_send_all_when_chosen() {
        let h = with_event().await;
        h.service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::All,
                summary("New"),
                SendUpdates::All,
            )
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.send_updates, Some(SendUpdates::All));
        assert_eq!(
            w.method, "patch",
            "any scope on a single event is that event"
        );
    }

    #[tokio::test]
    async fn stale_etag_refreshes_and_reports_conflict() {
        let h = with_event().await;
        let mut theirs = planning();
        theirs["summary"] = json!("Theirs");
        theirs["etag"] = json!("\"e2\"");
        h.fake("a").put(CAL, theirs);

        let err = h
            .service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                summary("Mine"),
                SendUpdates::None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Conflict), "{err:?}");
        let row = cached(&h, "a", CAL, "e").await.unwrap();
        assert_eq!(row.summary.as_deref(), Some("Theirs"));
        assert_eq!(row.etag, "\"e2\"");
        assert_eq!(h.fake("a").event(CAL, "e").unwrap()["summary"], "Theirs");
        assert_eq!(h.fake("a").writes().len(), 1, "not retried");
    }

    #[tokio::test]
    async fn rejected_edit_leaves_cache_unchanged() {
        let h = with_event().await;
        let before = cached(&h, "a", CAL, "e").await.unwrap();
        h.fake("a").fail_write(0, || GmailError::Api {
            status: 400,
            reason: Some("invalid".into()),
            message: "Bad Request".into(),
        });
        let err = h
            .service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                summary("New"),
                SendUpdates::None,
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "api");
        assert_eq!(
            err.to_string(),
            "Google Calendar refused the change: Bad Request"
        );
        assert_eq!(cached(&h, "a", CAL, "e").await.unwrap(), before);
        assert!(h.events.names().is_empty());
    }

    #[tokio::test]
    async fn offline_edit_reports_offline() {
        let h = with_event().await;
        let before = cached(&h, "a", CAL, "e").await.unwrap();
        h.fake("a")
            .fail_write(0, || GmailError::Offline("no route".into()));
        let err = h
            .service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                summary("New"),
                SendUpdates::None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Offline), "{err:?}");
        assert_eq!(err.code(), "network");
        assert_eq!(cached(&h, "a", CAL, "e").await.unwrap(), before);
    }

    #[tokio::test]
    async fn guest_cannot_edit_organizers_event() {
        let h = harness(&["a"]).await;
        h.fake("a").put(CAL, guest_event());
        h.grant("a").await;
        let err = h
            .service
            .update_event(
                "a",
                CAL,
                "review",
                EditScope::This,
                summary("Mine"),
                SendUpdates::None,
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "read_only");
        assert_eq!(err.to_string(), "Only the organizer can change this event.");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn reader_calendar_refuses_create() {
        let h = harness(&["a"]).await;
        let mut ro = calendar("holidays");
        ro.access_role = "reader".into();
        h.fake("a").add_calendar(ro);
        h.grant("a").await;
        let err = h
            .service
            .create_event("a", "holidays", lunch(), SendUpdates::None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "read_only");
        assert_eq!(err.to_string(), "You can't change events on this calendar.");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn invalid_create_reaches_no_google() {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        let mut edit = lunch();
        edit.end = Some(at(ms("2026-11-12T16:00:00Z")));
        let err = h
            .service
            .create_event("a", CAL, edit, SendUpdates::None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn timed_to_all_day_edit_round_trips() {
        let h = with_event().await;
        let to_all_day = EventEdit {
            start: Some(day("2026-11-10")),
            end: Some(day("2026-11-11")),
            ..Default::default()
        };
        h.service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                to_all_day,
                SendUpdates::None,
            )
            .await
            .unwrap();
        let google = h.fake("a").event(CAL, "e").unwrap();
        assert_eq!(google["start"]["date"], "2026-11-10");
        assert!(google["start"]["dateTime"].is_null());
        let row = cached(&h, "a", CAL, "e").await.unwrap();
        assert!(row.is_all_day());
        assert_eq!(row.start_date.as_deref(), Some("2026-11-10"));
        assert_eq!(row.end_date.as_deref(), Some("2026-11-11"));

        let to_timed = EventEdit {
            start: Some(TimeInput {
                time_zone: Some("Europe/Paris".into()),
                ..at(ms("2026-11-10T09:00:00Z"))
            }),
            end: Some(at(ms("2026-11-10T10:00:00Z"))),
            ..Default::default()
        };
        h.service
            .update_event("a", CAL, "e", EditScope::This, to_timed, SendUpdates::None)
            .await
            .unwrap();
        let google = h.fake("a").event(CAL, "e").unwrap();
        assert_eq!(google["start"]["dateTime"], "2026-11-10T10:00:00+01:00");
        assert_eq!(google["start"]["timeZone"], "Europe/Paris");
        assert!(google["start"]["date"].is_null());
        let row = cached(&h, "a", CAL, "e").await.unwrap();
        assert!(!row.is_all_day());
        assert_eq!(row.start_ms, Some(ms("2026-11-10T09:00:00Z")));
        assert_eq!(row.end_ms, Some(ms("2026-11-10T10:00:00Z")));
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let h = with_event().await;
        h.service
            .delete_event("a", CAL, "e", EditScope::This, SendUpdates::None)
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "delete");
        assert_eq!(w.if_match.as_deref(), Some("\"e\""));
        assert_eq!(w.send_updates, Some(SendUpdates::None));
        assert_eq!(h.fake("a").event(CAL, "e").unwrap()["status"], "cancelled");
        assert!(cached(&h, "a", CAL, "e").await.is_none());
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn failed_delete_keeps_row() {
        let h = with_event().await;
        h.fake("a")
            .fail_write(0, || GmailError::Offline("no route".into()));
        let err = h
            .service
            .delete_event("a", CAL, "e", EditScope::This, SendUpdates::None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "network");
        assert!(cached(&h, "a", CAL, "e").await.is_some());
    }

    #[tokio::test]
    async fn move_moves_cache_rows() {
        let h = harness(&["a"]).await;
        h.fake("a").add_calendar(calendar("work"));
        h.fake("a").put(CAL, standup_series());
        let mut moved = timed(
            "standup_20261102T140000Z",
            "Standup (late)",
            "2026-11-02T10:00:00-05:00",
            "2026-11-02T10:15:00-05:00",
        );
        moved["recurringEventId"] = json!("standup");
        moved["originalStartTime"] =
            json!({"dateTime": "2026-11-02T09:00:00-05:00", "timeZone": "America/New_York"});
        h.fake("a").put(CAL, moved);
        h.grant("a").await;
        assert!(cached(&h, "a", CAL, "standup_20261102T140000Z")
            .await
            .is_some());

        // An occurrence can't leave its series.
        for id in ["standup_20261102T140000Z", "standup_20261109T140000Z"] {
            let err = h
                .service
                .move_event("a", CAL, id, "work", SendUpdates::None)
                .await
                .unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{id}");
            assert_eq!(
                err.to_string(),
                "Only a whole repeating series can move to another calendar."
            );
        }
        assert!(h.fake("a").writes().is_empty());

        h.events.take();
        let r = h
            .service
            .move_event("a", CAL, "standup", "work", SendUpdates::None)
            .await
            .unwrap();
        assert_eq!(r.calendar_id, "work");
        assert_eq!(r.id, "standup");
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "move");
        assert_eq!(w.body, json!({"destination": "work"}));
        assert_eq!(w.send_updates, Some(SendUpdates::None));
        assert!(cached(&h, "a", CAL, "standup").await.is_none());
        assert!(cached(&h, "a", CAL, "standup_20261102T140000Z")
            .await
            .is_none());
        let row = cached(&h, "a", "work", "standup").await.unwrap();
        assert!(row.recurrence.is_some());
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
    }

    #[tokio::test]
    async fn move_needs_a_writable_destination() {
        let h = with_event().await;
        let mut ro = calendar("holidays");
        ro.access_role = "reader".into();
        h.fake("a").add_calendar(ro);
        h.grant("a").await;
        let err = h
            .service
            .move_event("a", CAL, "e", "holidays", SendUpdates::None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "read_only");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn copy_strips_ids_and_requests_new_meet() {
        let h = harness(&["a", "b"]).await;
        let mut e = planning();
        e["htmlLink"] = json!("https://calendar.google.com/e");
        e["created"] = json!("2026-10-01T00:00:00Z");
        e["creator"] = json!({"email": "a@example.com", "self": true});
        e["organizer"] = json!({"email": "a@example.com", "self": true});
        e["sequence"] = json!(3);
        e["hangoutLink"] = json!("https://meet.google.com/abc");
        e["conferenceData"] = json!({
            "conferenceId": "abc",
            "conferenceSolution": {"key": {"type": "hangoutsMeet"}},
            "entryPoints": [{"entryPointType": "video", "uri": "https://meet.google.com/abc"}]
        });
        e["attendees"] = json!([{"email": "bo@example.com", "responseStatus": "accepted"}]);
        e["location"] = json!("Room 1");
        h.fake("a").put(CAL, e);
        h.grant("a").await;
        h.grant("b").await;

        let r = h
            .service
            .copy_event("a", CAL, "e", "b", "b@example.com")
            .await
            .unwrap();
        assert_eq!(
            (r.account_id.as_str(), r.calendar_id.as_str()),
            ("b", "b@example.com")
        );
        assert!(h.fake("a").writes().is_empty(), "the source is only read");
        let w = h.fake("b").writes().pop().unwrap();
        assert_eq!(w.method, "insert");
        assert_eq!(w.send_updates, Some(SendUpdates::None));
        assert!(w.conference);
        assert_eq!(w.body["id"], r.id.as_str());
        assert_eq!(r.id.len(), 32);
        assert_ne!(r.id, "e");
        for key in [
            "iCalUID",
            "etag",
            "htmlLink",
            "created",
            "updated",
            "creator",
            "organizer",
            "sequence",
            "recurringEventId",
            "originalStartTime",
            "hangoutLink",
        ] {
            assert!(w.body.get(key).is_none(), "{key} should be stripped");
        }
        let create = &w.body["conferenceData"]["createRequest"];
        assert_eq!(create["conferenceSolutionKey"]["type"], "hangoutsMeet");
        assert!(create["requestId"].is_string());
        assert!(w.body["conferenceData"].get("conferenceId").is_none());
        assert_eq!(w.body["summary"], "Old");
        assert_eq!(w.body["location"], "Room 1");
        assert_eq!(w.body["attendees"][0]["email"], "bo@example.com");
        assert_eq!(w.body["start"]["dateTime"], "2026-11-10T10:00:00-05:00");

        let row = cached(&h, "b", "b@example.com", &r.id).await.unwrap();
        assert_eq!(row.summary.as_deref(), Some("Old"));
    }

    #[tokio::test]
    async fn duplicate_is_a_copy_to_the_same_calendar_without_meet() {
        let h = with_event().await;
        let r = h.service.copy_event("a", CAL, "e", "a", CAL).await.unwrap();
        assert_eq!(r.calendar_id, CAL);
        let w = h.fake("a").writes().pop().unwrap();
        assert!(!w.conference);
        assert!(w.body.get("conferenceData").is_none());
        assert!(cached(&h, "a", CAL, &r.id).await.is_some());
        assert!(cached(&h, "a", CAL, "e").await.is_some());
    }

    #[tokio::test]
    async fn copying_an_occurrence_makes_a_single_event_and_a_series_stays_one() {
        let h = harness(&["a"]).await;
        h.fake("a").put(CAL, standup_series());
        h.grant("a").await;

        let one = h
            .service
            .copy_event("a", CAL, "standup_20261109T140000Z", "a", CAL)
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert!(w.body.get("recurrence").is_none());
        assert_eq!(w.body["start"]["dateTime"], "2026-11-09T09:00:00-05:00");
        assert_eq!(w.body["end"]["dateTime"], "2026-11-09T09:15:00-05:00");
        let row = cached(&h, "a", CAL, &one.id).await.unwrap();
        assert!(row.recurrence.is_none());
        assert_eq!(row.start_ms, Some(ms("2026-11-09T14:00:00Z")));

        let series = h
            .service
            .copy_event("a", CAL, "standup", "a", CAL)
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.body["recurrence"], json!(["RRULE:FREQ=WEEKLY;BYDAY=MO"]));
        assert!(cached(&h, "a", CAL, &series.id)
            .await
            .unwrap()
            .recurrence
            .is_some());
    }

    #[tokio::test]
    async fn a_write_google_has_no_event_for_asks_for_a_sync() {
        let h = with_event().await;
        h.fake("a").forget(CAL, "e");
        assert!(!h.service.is_forced("a"));
        let err = h
            .service
            .update_event(
                "a",
                CAL,
                "e",
                EditScope::This,
                summary("New"),
                SendUpdates::None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::NotFound), "{err:?}");
        assert!(h.service.is_forced("a"), "a sync is asked for");
    }

    #[test]
    fn edit_scope_is_lowercase() {
        let s: Vec<EditScope> = serde_json::from_str(r#"["this","following","all"]"#).unwrap();
        assert_eq!(
            s,
            vec![EditScope::This, EditScope::Following, EditScope::All]
        );
    }
}
