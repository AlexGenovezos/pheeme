//! Plumbing shared by the Calendar write commands: what an event id points at, whether a
//! calendar can be changed, and caching Google's answer to a write.

use super::convert::{self, EventChange};
use super::edit::{self, OriginalStart};
use super::error::CalendarError;
use super::recurrence;
use super::service::CalendarService;
use crate::db;
use crate::db::calendar::{DbCalendar, DbEvent};
use crate::gmail::calendar::ApiEvent;
use crate::sync::SyncEvent;
use serde::Serialize;

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
    #[allow(dead_code)] // used by the write commands (Task 6)
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
    #[allow(dead_code)] // used by the write commands (Task 6)
    pub(super) async fn save(
        &self,
        account_id: &str,
        calendar_id: &str,
        api_event: ApiEvent,
    ) -> Result<EventRef, CalendarError> {
        let calendar = self.calendar(account_id, calendar_id).await?;
        let id = api_event.id.clone();
        let (upserts, deleted) = match convert::event(
            account_id,
            calendar_id,
            calendar.time_zone.as_deref(),
            &api_event,
        ) {
            EventChange::Upsert(e) => (vec![*e], Vec::new()),
            EventChange::Delete(id) => (Vec::new(), vec![id]),
        };
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
        Ok(EventRef {
            account_id: account_id.to_owned(),
            calendar_id: calendar_id.to_owned(),
            id,
        })
    }

    /// After a 412: fetch Google's current version and cache it. Errors are ignored; the
    /// command reports the conflict either way.
    #[allow(dead_code)] // used by the write commands (Task 6)
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
}
