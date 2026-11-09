//! An in-memory Google Calendar for tests: calendars, events with a change log so sync
//! tokens return only what changed, and switches for 410 Gone and permission failures.

use super::CalendarApi;
use crate::gmail::calendar::{
    ApiCalendar, ApiEvent, CalendarListPage, CalendarSettings, EventsPage,
};
use crate::gmail::GmailError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// Items per `list_events` page, small so tests cross pages.
const PAGE: usize = 2;

#[derive(Default)]
struct State {
    calendars: Vec<ApiCalendar>,
    /// Per calendar: (change sequence, event JSON), newest last; one entry per change.
    log: HashMap<String, Vec<(u64, Value)>>,
    seq: u64,
    /// Tokens issued before this sequence answer 410 Gone.
    gone_before: u64,
    fail: Option<fn() -> GmailError>,
    settings: CalendarSettings,
    pub calls: usize,
}

#[derive(Default)]
pub struct FakeCalendar {
    state: Mutex<State>,
}

pub fn calendar(id: &str) -> ApiCalendar {
    ApiCalendar {
        id: id.into(),
        summary: id.into(),
        summary_override: None,
        description: None,
        time_zone: Some("America/New_York".into()),
        background_color: Some("#9fe1e7".into()),
        foreground_color: Some("#000000".into()),
        access_role: "owner".into(),
        primary: false,
        deleted: false,
        default_reminders: Vec::new(),
    }
}

/// A timed event JSON, `start`/`end` as RFC 3339.
pub fn timed(id: &str, summary: &str, start: &str, end: &str) -> Value {
    json!({
        "id": id, "status": "confirmed", "summary": summary, "etag": format!("\"{id}\""),
        "iCalUID": format!("{id}@google.com"), "updated": "2026-11-01T00:00:00Z",
        "start": {"dateTime": start, "timeZone": "America/New_York"},
        "end": {"dateTime": end, "timeZone": "America/New_York"}
    })
}

impl FakeCalendar {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn add_calendar(&self, cal: ApiCalendar) {
        self.lock().calendars.push(cal);
    }

    pub fn remove_calendar(&self, id: &str) {
        let mut s = self.lock();
        s.calendars.retain(|c| c.id != id);
        s.log.remove(id);
    }

    /// Add or change an event (the JSON resource).
    pub fn put(&self, calendar_id: &str, event: Value) {
        let mut s = self.lock();
        s.seq += 1;
        let seq = s.seq;
        s.log
            .entry(calendar_id.into())
            .or_default()
            .push((seq, event));
    }

    /// Delete an event, as Google reports it: `status: cancelled` and little else.
    pub fn cancel(&self, calendar_id: &str, id: &str) {
        self.put(
            calendar_id,
            json!({"id": id, "status": "cancelled", "etag": "\"x\""}),
        );
    }

    /// Forget an event without a trace in the change log (only a full sync sees it's gone).
    pub fn forget(&self, calendar_id: &str, id: &str) {
        let mut s = self.lock();
        if let Some(log) = s.log.get_mut(calendar_id) {
            log.retain(|(_, e)| e["id"] != id);
        }
    }

    /// Every token issued so far now answers 410 Gone.
    pub fn expire_tokens(&self) {
        let mut s = self.lock();
        s.seq += 1;
        s.gone_before = s.seq;
    }

    /// Every call fails with `make()` until [`Self::succeed`].
    pub fn fail_with(&self, make: fn() -> GmailError) {
        self.lock().fail = Some(make);
    }

    pub fn succeed(&self) {
        self.lock().fail = None;
    }

    pub fn set_settings(&self, settings: CalendarSettings) {
        self.lock().settings = settings;
    }

    pub fn calls(&self) -> usize {
        self.lock().calls
    }

    fn enter(&self) -> Result<std::sync::MutexGuard<'_, State>, GmailError> {
        let mut s = self.lock();
        s.calls += 1;
        match s.fail {
            Some(make) => Err(make()),
            None => Ok(s),
        }
    }
}

#[async_trait::async_trait]
impl CalendarApi for FakeCalendar {
    async fn list_calendar_list(
        &self,
        _page_token: Option<&str>,
    ) -> Result<CalendarListPage, GmailError> {
        let s = self.enter()?;
        Ok(CalendarListPage {
            items: s.calendars.clone(),
            next_page_token: None,
        })
    }

    async fn list_events(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage, GmailError> {
        let s = self.enter()?;
        if !s.calendars.iter().any(|c| c.id == calendar_id) {
            return Err(GmailError::Api {
                status: 404,
                reason: Some("notFound".into()),
                message: "Not Found".into(),
            });
        }
        let since = match sync_token {
            Some(t) => {
                let since: u64 = t.trim_start_matches("seq:").parse().unwrap();
                if since < s.gone_before {
                    return Err(GmailError::Api {
                        status: 410,
                        reason: Some("fullSyncRequired".into()),
                        message: "Sync token is no longer valid".into(),
                    });
                }
                since
            }
            None => 0,
        };
        // The newest version of each event changed since the token, oldest change first.
        let mut latest: Vec<(u64, Value)> = Vec::new();
        for (seq, event) in s.log.get(calendar_id).into_iter().flatten() {
            latest.retain(|(_, e)| e["id"] != event["id"]);
            if *seq > since {
                latest.push((*seq, event.clone()));
            }
        }
        let offset: usize = page_token.map_or(0, |p| p.parse().unwrap());
        let page: Vec<ApiEvent> = latest
            .iter()
            .skip(offset)
            .take(PAGE)
            .map(|(_, e)| ApiEvent::try_from(e.clone()).unwrap())
            .collect();
        let more = offset + PAGE < latest.len();
        Ok(EventsPage {
            items: page,
            next_page_token: more.then(|| (offset + PAGE).to_string()),
            next_sync_token: (!more).then(|| format!("seq:{}", s.seq)),
        })
    }

    async fn calendar_settings(&self) -> Result<CalendarSettings, GmailError> {
        let s = self.enter()?;
        Ok(s.settings.clone())
    }
}
