//! Google Calendar API v3: the account's calendar list, events (with sync tokens) and
//! Calendar settings. Needs [`super::auth::CALENDAR_SCOPES`] and the Calendar API turned on in
//! the user's Google Cloud project. Runs on [`GmailClient`]'s plumbing (bearer, retry,
//! refresh) pointed at the Calendar API root, as `people.rs` does for contacts.

use super::client::{ApiRequest, GmailClient, TokenProvider};
use super::error::GmailError;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub const CALENDAR_BASE_URL: &str = "https://www.googleapis.com/calendar/v3";

/// Largest page `events.list` returns.
const EVENTS_PAGE_SIZE: &str = "2500";
/// Largest page `calendarList.list` returns.
const CALENDARS_PAGE_SIZE: &str = "250";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ApiReminder {
    pub method: String,
    pub minutes: i64,
}

/// One entry of the account's calendar list.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCalendar {
    pub id: String,
    #[serde(default)]
    pub summary: String,
    /// The name the user gave the calendar in their list, which wins over `summary`.
    pub summary_override: Option<String>,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    #[serde(default)]
    pub access_role: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub default_reminders: Vec<ApiReminder>,
}

/// An event's start or end: `date` for all-day events, otherwise `date_time` (RFC 3339).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEventTime {
    pub date: Option<String>,
    pub date_time: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiPerson {
    pub email: Option<String>,
    pub display_name: Option<String>,
    #[serde(default, rename = "self")]
    pub is_self: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAttendee {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub response_status: Option<String>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub organizer: bool,
    #[serde(default, rename = "self")]
    pub is_self: bool,
    #[serde(default)]
    pub resource: bool,
    pub comment: Option<String>,
}

/// An event resource. Cancelled events in an incremental sync may carry little beyond `id`
/// and `status`; `raw` keeps the whole resource for fields not modelled here.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiEvent {
    pub id: String,
    pub status: Option<String>,
    pub ical_uid: Option<String>,
    pub recurring_event_id: Option<String>,
    pub original_start_time: Option<ApiEventTime>,
    pub start: Option<ApiEventTime>,
    pub end: Option<ApiEventTime>,
    pub recurrence: Vec<String>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<ApiPerson>,
    pub attendees: Vec<ApiAttendee>,
    pub conference_data: Option<Value>,
    pub color_id: Option<String>,
    pub transparency: Option<String>,
    pub visibility: Option<String>,
    pub reminders: Option<Value>,
    pub html_link: Option<String>,
    pub etag: String,
    /// RFC 3339.
    pub updated: Option<String>,
    pub raw: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventFields {
    id: String,
    status: Option<String>,
    #[serde(rename = "iCalUID")]
    ical_uid: Option<String>,
    recurring_event_id: Option<String>,
    original_start_time: Option<ApiEventTime>,
    start: Option<ApiEventTime>,
    end: Option<ApiEventTime>,
    #[serde(default)]
    recurrence: Vec<String>,
    summary: Option<String>,
    location: Option<String>,
    description: Option<String>,
    organizer: Option<ApiPerson>,
    #[serde(default)]
    attendees: Vec<ApiAttendee>,
    conference_data: Option<Value>,
    color_id: Option<String>,
    transparency: Option<String>,
    visibility: Option<String>,
    reminders: Option<Value>,
    html_link: Option<String>,
    #[serde(default)]
    etag: String,
    updated: Option<String>,
}

impl TryFrom<Value> for ApiEvent {
    type Error = GmailError;

    fn try_from(raw: Value) -> Result<Self, GmailError> {
        let f: EventFields = serde_json::from_value(raw.clone())
            .map_err(|e| GmailError::Decode(format!("unexpected Calendar event: {e}")))?;
        Ok(ApiEvent {
            id: f.id,
            status: f.status,
            ical_uid: f.ical_uid,
            recurring_event_id: f.recurring_event_id,
            original_start_time: f.original_start_time,
            start: f.start,
            end: f.end,
            recurrence: f.recurrence,
            summary: f.summary,
            location: f.location,
            description: f.description,
            organizer: f.organizer,
            attendees: f.attendees,
            conference_data: f.conference_data,
            color_id: f.color_id,
            transparency: f.transparency,
            visibility: f.visibility,
            reminders: f.reminders,
            html_link: f.html_link,
            etag: f.etag,
            updated: f.updated,
            raw,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CalendarListPage {
    pub items: Vec<ApiCalendar>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventsPage {
    pub items: Vec<ApiEvent>,
    pub next_page_token: Option<String>,
    /// Only on the last page.
    pub next_sync_token: Option<String>,
}

/// The user's Google Calendar settings that change how the calendar is drawn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CalendarSettings {
    pub time_zone: Option<String>,
    /// 0 Sunday, 1 Monday, 6 Saturday.
    pub week_start: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListResponse {
    #[serde(default)]
    items: Vec<ApiCalendar>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsResponse {
    #[serde(default)]
    items: Vec<Value>,
    next_page_token: Option<String>,
    next_sync_token: Option<String>,
}

#[derive(Deserialize)]
struct Setting {
    value: Option<String>,
}

fn non_empty(token: Option<String>) -> Option<String> {
    token.filter(|t| !t.is_empty())
}

/// One item of an events page. An item that can't be read is skipped (logged) rather than
/// failing the page, which would stop every later calendar's sync; a cancellation is kept
/// from the few fields it needs, so the removal isn't lost.
fn page_event(raw: Value) -> Option<ApiEvent> {
    let error = match ApiEvent::try_from(raw.clone()) {
        Ok(e) => return Some(e),
        Err(e) => e,
    };
    let id = raw["id"].as_str().map(str::to_owned);
    if raw["status"] == "cancelled" {
        if let Some(id) = &id {
            let mut slim = serde_json::json!({ "id": id, "status": "cancelled" });
            for key in ["recurringEventId", "originalStartTime"] {
                if let Some(v) = raw.get(key) {
                    slim[key] = v.clone();
                }
            }
            let slim = ApiEvent::try_from(slim.clone()).or_else(|_| {
                ApiEvent::try_from(serde_json::json!({ "id": id, "status": "cancelled" }))
            });
            if let Ok(e) = slim {
                return Some(e);
            }
        }
    }
    tracing::warn!(event = id.as_deref().unwrap_or("?"), %error, "skipping an unreadable Calendar event");
    None
}

impl GmailClient {
    /// A client for the Calendar API, signed in as the same account.
    pub fn calendar(tokens: Arc<dyn TokenProvider>) -> Self {
        GmailClient::new(tokens).with_base_url(CALENDAR_BASE_URL)
    }

    /// One page of the account's calendar list, hidden calendars included.
    pub async fn list_calendar_list(
        &self,
        page_token: Option<&str>,
    ) -> Result<CalendarListPage, GmailError> {
        let req = ApiRequest::get(&["users", "me", "calendarList"])
            .query("showHidden", "true")
            .query("maxResults", CALENDARS_PAGE_SIZE)
            .query_opt("pageToken", page_token);
        let res: CalendarListResponse = self.send_json(req).await?;
        Ok(CalendarListPage {
            items: res.items,
            next_page_token: non_empty(res.next_page_token),
        })
    }

    /// One page of a calendar's events: everything (a full sync) without `sync_token`, or
    /// what changed since it. Series come unexpanded, with their changed and cancelled
    /// occurrences as separate items.
    pub async fn list_events(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage, GmailError> {
        let req = ApiRequest::get(&["calendars", calendar_id, "events"])
            .query("singleEvents", "false")
            .query("showDeleted", "true")
            .query("maxResults", EVENTS_PAGE_SIZE)
            .query_opt("syncToken", sync_token)
            .query_opt("pageToken", page_token);
        let res: EventsResponse = self.send_json(req).await?;
        Ok(EventsPage {
            items: res.items.into_iter().filter_map(page_event).collect(),
            next_page_token: non_empty(res.next_page_token),
            next_sync_token: non_empty(res.next_sync_token),
        })
    }

    /// The user's time zone and first day of the week.
    pub async fn calendar_settings(&self) -> Result<CalendarSettings, GmailError> {
        let time_zone: Setting = self
            .send_json(ApiRequest::get(&["users", "me", "settings", "timezone"]))
            .await?;
        let week_start: Setting = self
            .send_json(ApiRequest::get(&["users", "me", "settings", "weekStart"]))
            .await?;
        Ok(CalendarSettings {
            time_zone: time_zone.value.filter(|v| !v.is_empty()),
            week_start: week_start
                .value
                .and_then(|v| v.parse::<u8>().ok())
                .filter(|d| *d < 7),
        })
    }
}

/// One calendar's answer to `freeBusy.query`: busy intervals as UTC ms (end exclusive), or the
/// reasons Google couldn't tell (`notFound` for an address it can't see, and the like).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FreeBusyCalendar {
    pub busy: Vec<(i64, i64)>,
    pub errors: Vec<String>,
}

#[derive(Deserialize)]
struct FreeBusyResponse {
    #[serde(default)]
    calendars: std::collections::HashMap<String, FreeBusyEntry>,
}

#[derive(Deserialize)]
struct FreeBusyEntry {
    #[serde(default)]
    busy: Vec<FreeBusyPeriod>,
    #[serde(default)]
    errors: Vec<FreeBusyError>,
}

#[derive(Deserialize)]
struct FreeBusyPeriod {
    start: String,
    end: String,
}

#[derive(Deserialize)]
struct FreeBusyError {
    reason: Option<String>,
}

fn rfc3339_ms(value: &str) -> Result<i64, GmailError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|t| t.timestamp_millis())
        .map_err(|e| GmailError::Decode(format!("unexpected free/busy time {value:?}: {e}")))
}

fn rfc3339_of(ms: i64) -> Result<String, GmailError> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| GmailError::Decode(format!("time out of range: {ms}")))
}

impl GmailClient {
    /// Busy time in `[from_ms, to_ms)` on each calendar id (an email address names that
    /// person's primary calendar). Needs [`super::auth::FREEBUSY_SCOPES`]; an id Google can't
    /// see answers with `errors` instead of busy time.
    pub async fn free_busy(
        &self,
        ids: &[String],
        from_ms: i64,
        to_ms: i64,
    ) -> Result<std::collections::HashMap<String, FreeBusyCalendar>, GmailError> {
        let items: Vec<Value> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect();
        let body = serde_json::json!({
            "timeMin": rfc3339_of(from_ms)?,
            "timeMax": rfc3339_of(to_ms)?,
            "timeZone": "UTC",
            "items": items,
        });
        let res: FreeBusyResponse = self
            .send_json(ApiRequest::post(&["freeBusy"]).json(body))
            .await?;
        res.calendars
            .into_iter()
            .map(|(id, entry)| {
                let busy = entry
                    .busy
                    .iter()
                    .map(|p| Ok((rfc3339_ms(&p.start)?, rfc3339_ms(&p.end)?)))
                    .collect::<Result<Vec<_>, GmailError>>()?;
                let errors = entry
                    .errors
                    .into_iter()
                    .map(|e| e.reason.unwrap_or_else(|| "unknown".into()))
                    .collect();
                Ok((id, FreeBusyCalendar { busy, errors }))
            })
            .collect()
    }
}

/// Whether Google emails the guests about a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendUpdates {
    All,
    None,
}

impl SendUpdates {
    fn as_str(self) -> &'static str {
        match self {
            SendUpdates::All => "all",
            SendUpdates::None => "none",
        }
    }
}

/// How an event write is sent.
#[derive(Debug, Clone, Copy)]
pub struct WriteOptions<'a> {
    pub send_updates: SendUpdates,
    /// The stored etag: the write fails with 412 if the event changed since.
    pub if_match: Option<&'a str>,
    /// The body touches `conferenceData` (adds `conferenceDataVersion=1`).
    pub conference: bool,
}

impl WriteOptions<'_> {
    fn apply(&self, mut req: ApiRequest) -> ApiRequest {
        req = req.query("sendUpdates", self.send_updates.as_str());
        if self.conference {
            req = req.query("conferenceDataVersion", "1");
        }
        if let Some(etag) = self.if_match {
            // With an etag the write must not be re-sent when its outcome is unknown.
            req = req.header("If-Match", etag).non_idempotent();
        }
        req
    }
}

impl GmailClient {
    /// Create an event. The body should carry a client-made `id`: a 409 means an earlier
    /// attempt landed, so that event is fetched and returned.
    pub async fn insert_event(
        &self,
        calendar_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        let id = body.get("id").and_then(Value::as_str).map(str::to_owned);
        let req = opts.apply(ApiRequest::post(&["calendars", calendar_id, "events"]).json(body));
        match self.send_json::<Value>(req).await {
            Ok(raw) => ApiEvent::try_from(raw),
            Err(e) if e.is_duplicate() => match id {
                // The earlier attempt landed, so whatever stops us reading it back leaves
                // the outcome unconfirmed, never "didn't reach Google".
                Some(id) => self.get_event(calendar_id, &id).await.map_err(|e| {
                    GmailError::Network(format!(
                        "the event was saved but couldn't be read back: {e}"
                    ))
                }),
                None => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    pub async fn patch_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        let req = opts
            .apply(ApiRequest::patch(&["calendars", calendar_id, "events", event_id]).json(body));
        ApiEvent::try_from(self.send_json::<Value>(req).await?)
    }

    /// Delete an event; one that is already gone (404 or 410) counts as deleted.
    pub async fn delete_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        opts: WriteOptions<'_>,
    ) -> Result<(), GmailError> {
        let req = opts.apply(ApiRequest::delete(&[
            "calendars",
            calendar_id,
            "events",
            event_id,
        ]));
        match self.send_empty(req).await {
            Err(e) if e.is_not_found() || e.is_gone() => Ok(()),
            other => other,
        }
    }

    pub async fn get_event(
        &self,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<ApiEvent, GmailError> {
        let req = ApiRequest::get(&["calendars", calendar_id, "events", event_id]);
        ApiEvent::try_from(self.send_json::<Value>(req).await?)
    }

    /// Move an event to another calendar. Never re-sent when its outcome is unknown.
    pub async fn move_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        destination: &str,
        send_updates: SendUpdates,
    ) -> Result<ApiEvent, GmailError> {
        let req = ApiRequest::post(&["calendars", calendar_id, "events", event_id, "move"])
            .query("destination", destination)
            .query("sendUpdates", send_updates.as_str())
            .non_idempotent();
        ApiEvent::try_from(self.send_json::<Value>(req).await?)
    }

    /// Copy an invitation into a calendar (`events.import`).
    pub async fn import_event(
        &self,
        calendar_id: &str,
        body: Value,
    ) -> Result<ApiEvent, GmailError> {
        let req = ApiRequest::post(&["calendars", calendar_id, "events", "import"]).json(body);
        ApiEvent::try_from(self.send_json::<Value>(req).await?)
    }

    /// The events on a calendar with this iCalendar UID (a series comes unexpanded).
    pub async fn events_by_ical_uid(
        &self,
        calendar_id: &str,
        ical_uid: &str,
    ) -> Result<Vec<ApiEvent>, GmailError> {
        let req = ApiRequest::get(&["calendars", calendar_id, "events"])
            .query("iCalUID", ical_uid)
            .query("singleEvents", "false")
            .query("showDeleted", "false");
        let res: EventsResponse = self.send_json(req).await?;
        res.items.into_iter().map(ApiEvent::try_from).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{SendUpdates, WriteOptions};
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn event_json(id: &str) -> serde_json::Value {
        json!({"id": id, "etag": "\"e2\"", "status": "confirmed", "summary": "Lunch"})
    }

    fn opts(
        send_updates: SendUpdates,
        if_match: Option<&str>,
        conference: bool,
    ) -> WriteOptions<'_> {
        WriteOptions {
            send_updates,
            if_match,
            conference,
        }
    }

    fn fixture(name: &str) -> serde_json::Value {
        let path = format!("{}/src/gmail/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn free_busy_posts_the_range_and_reads_busy_time_and_errors() {
        use wiremock::matchers::body_json;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/freeBusy"))
            .and(body_json(json!({
                "timeMin": "2026-11-16T14:00:00.000Z",
                "timeMax": "2026-11-17T02:00:00.000Z",
                "timeZone": "UTC",
                "items": [{"id": "primary"}, {"id": "sam@example.com"}, {"id": "x@other.org"}],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "calendar#freeBusy",
                "calendars": {
                    "primary": {"busy": [
                        {"start": "2026-11-16T15:00:00Z", "end": "2026-11-16T16:00:00Z"}
                    ]},
                    "sam@example.com": {"busy": [
                        {"start": "2026-11-16T10:30:00-05:00", "end": "2026-11-16T11:00:00-05:00"}
                    ]},
                    "x@other.org": {"errors": [{"domain": "global", "reason": "notFound"}], "busy": []}
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let ids = ["primary", "sam@example.com", "x@other.org"].map(String::from);
        let from = 1_794_837_600_000; // 2026-11-16T14:00Z
        let got = client
            .free_busy(&ids, from, from + 12 * 3_600_000)
            .await
            .unwrap();
        assert_eq!(
            got["primary"].busy,
            vec![(from + 3_600_000, from + 7_200_000)]
        );
        assert_eq!(
            got["sam@example.com"].busy,
            vec![(from + 5_400_000, from + 7_200_000)]
        );
        assert!(got["sam@example.com"].errors.is_empty());
        assert!(got["x@other.org"].busy.is_empty());
        assert_eq!(got["x@other.org"].errors, vec!["notFound".to_string()]);
    }

    #[tokio::test]
    async fn lists_events_with_sync_token_and_parses_all_shapes() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events"))
            .and(query_param("syncToken", "s1"))
            .and(query_param("singleEvents", "false"))
            .and(query_param("showDeleted", "true"))
            .and(query_param("maxResults", "2500"))
            .and(query_param("pageToken", "p2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture("calendar_events.json")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client
            .list_events("primary", Some("s1"), Some("p2"))
            .await
            .unwrap();

        assert_eq!(page.next_sync_token.as_deref(), Some("s2"));
        assert_eq!(page.next_page_token, None);
        assert_eq!(page.items.len(), 6);
        let timed = &page.items[0];
        assert_eq!(timed.id, "timed1");
        let start = timed.start.as_ref().unwrap();
        assert_eq!(
            start.date_time.as_deref(),
            Some("2026-11-12T14:00:00-05:00")
        );
        assert_eq!(start.time_zone.as_deref(), Some("America/New_York"));
        assert_eq!(timed.etag, "\"3400000000000000\"");
        assert_eq!(
            timed.organizer.as_ref().unwrap().email.as_deref(),
            Some("sam@acme.com")
        );
        let me: Vec<_> = timed.attendees.iter().filter(|a| a.is_self).collect();
        assert_eq!(me.len(), 1);
        assert_eq!(me[0].response_status.as_deref(), Some("needsAction"));
        assert!(timed.attendees[2].resource);
        assert!(timed.attendees[3].optional);
        assert_eq!(timed.attendees[3].comment.as_deref(), Some("Out that day"));
        assert!(timed.conference_data.is_some());
        assert_eq!(timed.raw["id"], "timed1");
        assert_eq!(timed.raw["eventType"], "default");

        let all_day = &page.items[1];
        assert_eq!(
            all_day.start.as_ref().unwrap().date.as_deref(),
            Some("2026-11-12")
        );
        assert_eq!(all_day.transparency.as_deref(), Some("transparent"));

        let series = &page.items[2];
        assert!(series.recurrence[0].starts_with("RRULE:"));
        assert_eq!(series.recurrence.len(), 2);

        let moved = &page.items[3];
        assert_eq!(moved.recurring_event_id.as_deref(), Some("series1"));
        assert_eq!(
            moved
                .original_start_time
                .as_ref()
                .unwrap()
                .date_time
                .as_deref(),
            Some("2026-11-09T09:00:00-05:00")
        );
        let cancelled = &page.items[4];
        assert_eq!(cancelled.status.as_deref(), Some("cancelled"));
        assert!(cancelled.start.is_none());
        assert_eq!(page.items[5].id, "gone1");
    }

    #[tokio::test]
    async fn full_sync_sends_no_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [], "nextPageToken": "p2"
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client.list_events("primary", None, None).await.unwrap();
        assert_eq!(page.next_page_token.as_deref(), Some("p2"));
        assert_eq!(page.next_sync_token, None);
        let requests = server.received_requests().await.unwrap();
        let query = requests[0].url.query().unwrap_or_default();
        assert!(!query.contains("syncToken"), "{query}");
        assert!(!query.contains("pageToken"), "{query}");
    }

    #[tokio::test]
    async fn calendar_id_with_hash_is_encoded() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/calendars/en.usa%23holiday@group.v.calendar.google.com/events",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items": []})))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .list_events("en.usa#holiday@group.v.calendar.google.com", None, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn an_unreadable_event_is_skipped_not_the_page() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {"id": "good", "status": "confirmed", "etag": "\"1\""},
                    {"id": "bad", "status": "confirmed", "start": "tomorrow"},
                    {"status": "confirmed", "summary": "no id"},
                    {"id": "gone", "status": "cancelled", "summary": 7,
                     "recurringEventId": "series1",
                     "originalStartTime": {"dateTime": "2026-11-12T14:00:00Z"}}
                ],
                "nextSyncToken": "s2"
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client.list_events("primary", None, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["good", "gone"]);
        let gone = &page.items[1];
        assert_eq!(gone.status.as_deref(), Some("cancelled"));
        assert_eq!(gone.recurring_event_id.as_deref(), Some("series1"));
        assert!(gone.original_start_time.is_some());
        assert_eq!(page.next_sync_token.as_deref(), Some("s2"));
    }

    #[tokio::test]
    async fn gone_sync_token_is_api_410() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events"))
            .respond_with(ResponseTemplate::new(410).set_body_json(json!({
                "error": {"code": 410, "message": "Sync token is no longer valid, a full sync is required.",
                          "errors": [{"reason": "fullSyncRequired", "message": "Sync token is no longer valid"}]}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let error = client
            .list_events("primary", Some("old"), None)
            .await
            .unwrap_err();
        assert!(error.is_gone(), "{error:?}");
        assert!(!error.is_not_found());
    }

    #[tokio::test]
    async fn lists_calendars() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/calendarList"))
            .and(query_param("showHidden", "true"))
            .and(query_param("maxResults", "250"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture("calendar_list.json")))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client.list_calendar_list(None).await.unwrap();
        assert_eq!(page.next_page_token.as_deref(), Some("c2"));
        let primary = &page.items[0];
        assert!(primary.primary);
        assert_eq!(primary.access_role, "owner");
        assert_eq!(primary.background_color.as_deref(), Some("#9fe1e7"));
        assert_eq!(primary.default_reminders[0].minutes, 10);
        assert_eq!(primary.default_reminders[0].method, "popup");
        let holidays = &page.items[1];
        assert!(!holidays.primary);
        assert!(!holidays.deleted);
        assert_eq!(holidays.access_role, "reader");
    }

    #[tokio::test]
    async fn reads_timezone_and_week_start() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/settings/timezone"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "calendar#setting", "id": "timezone", "value": "Europe/Paris"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/users/me/settings/weekStart"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "calendar#setting", "id": "weekStart", "value": "1"
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let settings = client.calendar_settings().await.unwrap();
        assert_eq!(settings.time_zone.as_deref(), Some("Europe/Paris"));
        assert_eq!(settings.week_start, Some(1));
    }

    #[tokio::test]
    async fn patch_sends_if_match_and_send_updates() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/calendars/primary/events/ev1"))
            .and(header("If-Match", "\"e1\""))
            .and(query_param("sendUpdates", "none"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("ev1")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let event = client
            .patch_event(
                "primary",
                "ev1",
                json!({"summary": "Lunch"}),
                opts(SendUpdates::None, Some("\"e1\""), false),
            )
            .await
            .unwrap();
        assert_eq!(event.etag, "\"e2\"");
        let requests = server.received_requests().await.unwrap();
        let query = requests[0].url.query().unwrap_or_default();
        assert!(!query.contains("conferenceDataVersion"), "{query}");
    }

    #[tokio::test]
    async fn patch_with_conference_sends_version_1() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/calendars/primary/events/ev1"))
            .and(query_param("conferenceDataVersion", "1"))
            .and(query_param("sendUpdates", "all"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("ev1")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .patch_event(
                "primary",
                "ev1",
                json!({}),
                opts(SendUpdates::All, None, true),
            )
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        assert!(!requests[0].headers.contains_key("if-match"));
    }

    #[tokio::test]
    async fn patch_412_is_conflict() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .respond_with(ResponseTemplate::new(412).set_body_json(json!({
                "error": {"code": 412, "message": "Precondition Failed",
                          "errors": [{"reason": "conditionNotMet", "message": "Precondition Failed"}]}
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let err = client
            .patch_event(
                "primary",
                "ev1",
                json!({}),
                opts(SendUpdates::None, Some("\"e1\""), false),
            )
            .await
            .unwrap_err();
        assert!(err.is_conflict(), "{err:?}");
        assert!(!err.is_duplicate());
    }

    #[tokio::test]
    async fn insert_retry_after_duplicate_returns_existing() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars/primary/events"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": {"code": 409, "message": "The requested identifier already exists.",
                          "errors": [{"reason": "duplicate", "message": "exists"}]}
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events/abc123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("abc123")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let event = client
            .insert_event(
                "primary",
                json!({"id": "abc123", "summary": "Lunch"}),
                opts(SendUpdates::None, None, false),
            )
            .await
            .unwrap();
        assert_eq!(event.id, "abc123");
    }

    #[tokio::test]
    async fn insert_duplicate_then_failed_get_is_network() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars/primary/events"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": {"code": 409, "message": "The requested identifier already exists.",
                          "errors": [{"reason": "duplicate", "message": "exists"}]}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events/abc123"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let err = client
            .insert_event(
                "primary",
                json!({"id": "abc123"}),
                opts(SendUpdates::None, None, false),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, crate::gmail::error::GmailError::Network(_)),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn insert_posts_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars/primary/events"))
            .and(query_param("sendUpdates", "none"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("abc123")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .insert_event(
                "primary",
                json!({"id": "abc123"}),
                opts(SendUpdates::None, None, false),
            )
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["id"], "abc123");
    }

    #[tokio::test]
    async fn delete_treats_410_as_done() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/calendars/primary/events/ev1"))
            .and(query_param("sendUpdates", "all"))
            .respond_with(ResponseTemplate::new(410).set_body_json(json!({
                "error": {"code": 410, "message": "Resource has been deleted"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/calendars/primary/events/ev2"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": {"code": 404, "message": "Not Found"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .delete_event("primary", "ev1", opts(SendUpdates::All, None, false))
            .await
            .unwrap();
        client
            .delete_event("primary", "ev2", opts(SendUpdates::None, None, false))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn move_posts_destination() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars/primary/events/ev1/move"))
            .and(query_param("destination", "work@group.calendar.google.com"))
            .and(query_param("sendUpdates", "none"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("ev1")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let event = client
            .move_event(
                "primary",
                "ev1",
                "work@group.calendar.google.com",
                SendUpdates::None,
            )
            .await
            .unwrap();
        assert_eq!(event.id, "ev1");
    }

    #[tokio::test]
    async fn import_posts_to_import_path() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars/primary/events/import"))
            .respond_with(ResponseTemplate::new(200).set_body_json(event_json("imp1")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let event = client
            .import_event("primary", json!({"iCalUID": "u@x"}))
            .await
            .unwrap();
        assert_eq!(event.id, "imp1");
    }

    #[tokio::test]
    async fn events_by_ical_uid_queries_uid() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/calendars/primary/events"))
            .and(query_param("iCalUID", "u1@google.com"))
            .and(query_param("singleEvents", "false"))
            .and(query_param("showDeleted", "false"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"items": [event_json("a"), event_json("b")]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let events = client
            .events_by_ical_uid("primary", "u1@google.com")
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn if_match_write_is_not_retried_on_503() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let err = client
            .patch_event(
                "primary",
                "ev1",
                json!({}),
                opts(SendUpdates::None, Some("\"e1\""), false),
            )
            .await
            .unwrap_err();
        assert!(!err.is_conflict(), "{err:?}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}
