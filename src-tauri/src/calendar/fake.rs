//! An in-memory Google Calendar for tests: calendars, events with a change log so sync
//! tokens return only what changed, and switches for 410 Gone and permission failures.

use super::CalendarApi;
use crate::gmail::calendar::{
    ApiCalendar, ApiEvent, CalendarListPage, CalendarSettings, EventsPage, SendUpdates,
    WriteOptions,
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
    /// Every write received, in order (a failed one too).
    writes: Vec<FakeWrite>,
    /// Writes received so far; the index of the next one.
    write_count: usize,
    /// Planned outcomes by absolute write index.
    plans: HashMap<usize, Plan>,
}

#[derive(Clone, Copy)]
enum Plan {
    /// Fail without applying.
    Fail(fn() -> GmailError),
    /// Apply, then answer a network error.
    LoseReply,
}

/// One write the fake received.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeWrite {
    /// `"insert"`, `"patch"`, `"delete"`, `"move"` or `"import"`.
    pub method: &'static str,
    pub calendar_id: String,
    pub event_id: Option<String>,
    pub send_updates: Option<SendUpdates>,
    pub if_match: Option<String>,
    pub conference: bool,
    pub body: Value,
}

fn api_error(status: u16, reason: &str) -> GmailError {
    GmailError::Api {
        status,
        reason: Some(reason.into()),
        message: reason.into(),
    }
}

/// `{master}_{suffix}` split at the last `_`, with the `originalStartTime` the suffix names.
fn instance_parts(id: &str, master: &Value) -> Option<(String, Value)> {
    let (master_id, suffix) = id.rsplit_once('_')?;
    let original = if suffix.len() == 8 && suffix.bytes().all(|b| b.is_ascii_digit()) {
        let d = chrono::NaiveDate::parse_from_str(suffix, "%Y%m%d").ok()?;
        json!({"date": d.format("%Y-%m-%d").to_string()})
    } else {
        let t = chrono::NaiveDateTime::parse_from_str(suffix, "%Y%m%dT%H%M%SZ").ok()?;
        let mut o =
            json!({"dateTime": t.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
        if let Some(tz) = master["start"]["timeZone"].as_str() {
            o["timeZone"] = json!(tz);
        }
        o
    };
    Some((master_id.to_owned(), original))
}

impl State {
    /// The newest version of an event (a cancelled one too).
    fn current(&self, calendar_id: &str, id: &str) -> Option<Value> {
        self.log
            .get(calendar_id)?
            .iter()
            .rev()
            .find(|(_, e)| e["id"] == id)
            .map(|(_, e)| e.clone())
    }

    /// Log a write's result as a new version: etag `"v{seq}"`.
    fn put_version(&mut self, calendar_id: &str, mut event: Value) -> Value {
        self.seq += 1;
        event["etag"] = json!(format!("\"v{}\"", self.seq));
        event["updated"] = json!("2026-11-01T00:00:00Z");
        let seq = self.seq;
        self.log
            .entry(calendar_id.into())
            .or_default()
            .push((seq, event.clone()));
        event
    }

    fn check_etag(current: &Value, if_match: Option<&str>) -> Result<(), GmailError> {
        match if_match {
            Some(m) if current["etag"] != m => Err(api_error(412, "conditionNotMet")),
            _ => Ok(()),
        }
    }

    /// The override an instance id stands for, as a copy of its master.
    fn override_of(&self, calendar_id: &str, id: &str) -> Option<Value> {
        let master_id = id.rsplit_once('_')?.0;
        let master = self.current(calendar_id, master_id)?;
        let (_, original) = instance_parts(id, &master)?;
        let (start, end) = instance_times(&master, &original)?;
        let mut e = master.clone();
        let o = e.as_object_mut()?;
        o.remove("recurrence");
        o.insert("id".into(), json!(id));
        o.insert("recurringEventId".into(), json!(master_id));
        o.insert("originalStartTime".into(), original);
        o.insert("start".into(), start);
        o.insert("end".into(), end);
        Some(e)
    }
}

/// An instance's own start and end, as Google gives them: its original start, and the
/// series' length.
fn instance_times(master: &Value, original: &Value) -> Option<(Value, Value)> {
    if let Some(d) = original["date"].as_str() {
        let parse = |v: &Value| chrono::NaiveDate::parse_from_str(v.as_str()?, "%Y-%m-%d").ok();
        let days = parse(&master["end"]["date"])? - parse(&master["start"]["date"])?;
        let start = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
        let end = (start + days).format("%Y-%m-%d").to_string();
        return Some((json!({"date": d}), json!({"date": end})));
    }
    let parse = |v: &Value| chrono::DateTime::parse_from_rfc3339(v.as_str()?).ok();
    let length = parse(&master["end"]["dateTime"])? - parse(&master["start"]["dateTime"])?;
    let start = parse(&original["dateTime"])?;
    let time = |t: chrono::DateTime<chrono::FixedOffset>| {
        let mut v = json!({"dateTime": t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
        if let Some(tz) = master["start"]["timeZone"].as_str() {
            v["timeZone"] = json!(tz);
        }
        v
    };
    Some((time(start), time(start + length)))
}

fn write(
    method: &'static str,
    calendar_id: &str,
    event_id: Option<String>,
    opts: Option<&WriteOptions<'_>>,
    body: Value,
) -> FakeWrite {
    FakeWrite {
        method,
        calendar_id: calendar_id.into(),
        event_id,
        send_updates: opts.map(|o| o.send_updates),
        if_match: opts.and_then(|o| o.if_match).map(str::to_owned),
        conference: opts.is_some_and(|o| o.conference),
        body,
    }
}

/// The write applied; a lost reply turns its answer into a network error.
fn reply<T>(lost: bool, result: Result<T, GmailError>) -> Result<T, GmailError> {
    match (lost, result) {
        (true, Ok(_)) => Err(GmailError::Network("reply lost".into())),
        (_, r) => r,
    }
}

fn event(raw: Value) -> Result<ApiEvent, GmailError> {
    ApiEvent::try_from(raw)
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

    /// Every write received so far, in order.
    pub fn writes(&self) -> Vec<FakeWrite> {
        self.lock().writes.clone()
    }

    /// The `n`-th write from now (0-based) fails with `make()` without applying. Several
    /// can be pending at once.
    pub fn fail_write(&self, n: usize, make: fn() -> GmailError) {
        let mut s = self.lock();
        let at = s.write_count + n;
        s.plans.insert(at, Plan::Fail(make));
    }

    /// The `n`-th write from now (0-based) applies, then answers a network error.
    pub fn lose_reply(&self, n: usize) {
        let mut s = self.lock();
        let at = s.write_count + n;
        s.plans.insert(at, Plan::LoseReply);
    }

    /// The newest version of an event (a cancelled one too), for assertions.
    pub fn event(&self, calendar_id: &str, id: &str) -> Option<Value> {
        self.lock().current(calendar_id, id)
    }

    /// Record a write and decide its planned outcome: `Err` if it must fail unapplied,
    /// `Ok(true)` if it applies but its reply is lost.
    fn begin_write(
        &self,
        w: FakeWrite,
    ) -> Result<(std::sync::MutexGuard<'_, State>, bool), GmailError> {
        let mut s = self.enter()?;
        let at = s.write_count;
        s.write_count += 1;
        s.writes.push(w);
        match s.plans.remove(&at) {
            Some(Plan::Fail(make)) => Err(make()),
            Some(Plan::LoseReply) => Ok((s, true)),
            None => Ok((s, false)),
        }
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

    async fn insert_event(
        &self,
        calendar_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        let id = body["id"].as_str().map(str::to_owned);
        let (mut s, lost) = self.begin_write(write(
            "insert",
            calendar_id,
            id.clone(),
            Some(&opts),
            body.clone(),
        ))?;
        if !s.calendars.iter().any(|c| c.id == calendar_id) {
            return Err(api_error(404, "notFound"));
        }
        // Like Google, a repeated id answers 409 (the real client turns that into a fetch).
        if id
            .as_deref()
            .is_some_and(|id| s.current(calendar_id, id).is_some())
        {
            return Err(api_error(409, "duplicate"));
        }
        let mut e = body;
        if e["id"].is_null() {
            e["id"] = json!(format!("gen{}", s.seq + 1));
        }
        if e["status"].is_null() {
            e["status"] = json!("confirmed");
        }
        if e["iCalUID"].is_null() {
            e["iCalUID"] = json!(format!(
                "{}@google.com",
                e["id"].as_str().unwrap_or_default()
            ));
        }
        let e = s.put_version(calendar_id, e);
        reply(lost, event(e))
    }

    async fn patch_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        let (mut s, lost) = self.begin_write(write(
            "patch",
            calendar_id,
            Some(event_id.into()),
            Some(&opts),
            body.clone(),
        ))?;
        let base = match s.current(calendar_id, event_id) {
            Some(cur) if cur["status"] != "cancelled" => {
                State::check_etag(&cur, opts.if_match)?;
                cur
            }
            _ => s
                .override_of(calendar_id, event_id)
                .ok_or_else(|| api_error(404, "notFound"))?,
        };
        let mut merged = base;
        if let (Some(m), Some(patch)) = (merged.as_object_mut(), body.as_object()) {
            for (k, v) in patch {
                if v.is_null() {
                    m.remove(k);
                } else {
                    m.insert(k.clone(), v.clone());
                }
            }
        }
        merged["id"] = json!(event_id);
        let e = s.put_version(calendar_id, merged);
        reply(lost, event(e))
    }

    async fn delete_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        opts: WriteOptions<'_>,
    ) -> Result<(), GmailError> {
        let (mut s, lost) = self.begin_write(write(
            "delete",
            calendar_id,
            Some(event_id.into()),
            Some(&opts),
            Value::Null,
        ))?;
        let cancelled = match s.current(calendar_id, event_id) {
            Some(cur) if cur["status"] == "cancelled" => None,
            Some(cur) => {
                State::check_etag(&cur, opts.if_match)?;
                let mut c = json!({"id": event_id, "status": "cancelled"});
                for k in ["recurringEventId", "originalStartTime"] {
                    if !cur[k].is_null() {
                        c[k] = cur[k].clone();
                    }
                }
                Some(c)
            }
            None => s.override_of(calendar_id, event_id).map(|o| {
                json!({"id": event_id, "status": "cancelled",
                       "recurringEventId": o["recurringEventId"],
                       "originalStartTime": o["originalStartTime"]})
            }),
        };
        // Gone already counts as deleted, as in the real client.
        if let Some(c) = cancelled {
            s.put_version(calendar_id, c);
        }
        reply(lost, Ok(()))
    }

    async fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<ApiEvent, GmailError> {
        let s = self.enter()?;
        let e = s
            .current(calendar_id, event_id)
            .ok_or_else(|| api_error(404, "notFound"))?;
        event(e)
    }

    async fn move_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        destination: &str,
        send_updates: SendUpdates,
    ) -> Result<ApiEvent, GmailError> {
        let mut w = write(
            "move",
            calendar_id,
            Some(event_id.into()),
            None,
            Value::Null,
        );
        w.send_updates = Some(send_updates);
        w.body = json!({"destination": destination});
        let (mut s, lost) = self.begin_write(w)?;
        let cur = s
            .current(calendar_id, event_id)
            .filter(|c| c["status"] != "cancelled")
            .ok_or_else(|| api_error(404, "notFound"))?;
        if !s.calendars.iter().any(|c| c.id == destination) {
            return Err(api_error(404, "notFound"));
        }
        let moved = s.put_version(destination, cur);
        s.put_version(calendar_id, json!({"id": event_id, "status": "cancelled"}));
        reply(lost, event(moved))
    }

    async fn import_event(&self, calendar_id: &str, body: Value) -> Result<ApiEvent, GmailError> {
        let id = body["id"].as_str().map(str::to_owned);
        let (mut s, lost) =
            self.begin_write(write("import", calendar_id, id, None, body.clone()))?;
        let mut e = body;
        if e["id"].is_null() {
            e["id"] = json!(format!("imp{}", s.seq + 1));
        }
        if e["status"].is_null() {
            e["status"] = json!("confirmed");
        }
        let e = s.put_version(calendar_id, e);
        reply(lost, event(e))
    }

    async fn events_by_ical_uid(
        &self,
        calendar_id: &str,
        ical_uid: &str,
    ) -> Result<Vec<ApiEvent>, GmailError> {
        let s = self.enter()?;
        let mut latest: Vec<Value> = Vec::new();
        for (_, e) in s.log.get(calendar_id).into_iter().flatten() {
            latest.retain(|l| l["id"] != e["id"]);
            latest.push(e.clone());
        }
        latest
            .into_iter()
            .filter(|e| e["status"] != "cancelled" && e["iCalUID"] == ical_uid)
            .map(event)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::calendar::{SendUpdates, WriteOptions};

    fn opts(if_match: Option<&str>) -> WriteOptions<'_> {
        WriteOptions {
            send_updates: SendUpdates::None,
            if_match,
            conference: false,
        }
    }

    fn series() -> Value {
        let mut e = timed(
            "standup",
            "Standup",
            "2026-11-03T14:00:00Z",
            "2026-11-03T14:30:00Z",
        );
        e["recurrence"] = json!(["RRULE:FREQ=DAILY"]);
        e
    }

    fn is_status(e: &GmailError, code: u16) -> bool {
        matches!(e, GmailError::Api { status, .. } if *status == code)
    }

    #[tokio::test]
    async fn patch_with_stale_etag_is_412() {
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("a"));
        fake.put("a", series());
        let err = fake
            .patch_event(
                "a",
                "standup",
                json!({"summary": "x"}),
                opts(Some("\"old\"")),
            )
            .await
            .unwrap_err();
        assert!(is_status(&err, 412));
        let ok = fake
            .patch_event(
                "a",
                "standup",
                json!({"summary": "x"}),
                opts(Some("\"standup\"")),
            )
            .await
            .unwrap();
        assert_eq!(ok.summary.as_deref(), Some("x"));
        assert_eq!(fake.writes().len(), 2);
    }

    #[tokio::test]
    async fn patch_instance_creates_override_seen_by_sync() {
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("a"));
        fake.put("a", series());
        let first = fake.list_events("a", None, None).await.unwrap();
        let token = first.next_sync_token.unwrap();
        fake.patch_event(
            "a",
            "standup_20261110T140000Z",
            json!({"summary": "Moved"}),
            opts(None),
        )
        .await
        .unwrap();
        let page = fake.list_events("a", Some(&token), None).await.unwrap();
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        assert_eq!(item.recurring_event_id.as_deref(), Some("standup"));
        assert_eq!(item.summary.as_deref(), Some("Moved"));
        assert_eq!(
            item.raw["originalStartTime"]["dateTime"],
            "2026-11-10T14:00:00Z"
        );
    }

    #[tokio::test]
    async fn fail_write_fails_only_the_nth() {
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("a"));
        fake.fail_write(1, || GmailError::Offline("down".into()));
        let body = |id: &str| timed(id, "E", "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z");
        fake.insert_event("a", body("e1"), opts(None))
            .await
            .unwrap();
        assert!(fake
            .insert_event("a", body("e2"), opts(None))
            .await
            .is_err());
        fake.insert_event("a", body("e3"), opts(None))
            .await
            .unwrap();
        assert!(fake.event("a", "e2").is_none());
        assert!(fake.event("a", "e3").is_some());
    }

    #[tokio::test]
    async fn lose_reply_applies_but_answers_network() {
        let fake = FakeCalendar::default();
        fake.add_calendar(calendar("a"));
        fake.lose_reply(0);
        let body = timed("e1", "E", "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z");
        let err = fake.insert_event("a", body, opts(None)).await.unwrap_err();
        assert!(matches!(err, GmailError::Network(_)));
        assert!(fake.event("a", "e1").is_some());
    }
}
