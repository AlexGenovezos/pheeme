//! Mail's invite card: the invitation an email carries ([`super::ics`]), with the event as it
//! is now on the account's calendar when the cache has it (found by iCalendar UID, the primary
//! calendar first), so an out-of-date email still shows the current time and answers.

use super::edit::{self, OriginalStart};
use super::error::CalendarError;
use super::ics::{self, IcsTime, Invite};
use super::meeting::MeetingLink;
use super::service::{AttendeeDto, CalendarService, EventDetailDto, EventTimeDto, PersonDto};
use crate::db;
use crate::db::calendar::DbEvent;
use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{json, Value};

/// What the invite card shows: the email's invitation and, when cached, the live event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteDto {
    /// `REQUEST`, `CANCEL`, `REPLY`, `PUBLISH`, …
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    /// The email cancels the event (`METHOD:CANCEL` or `STATUS:CANCELLED`).
    pub cancelled: bool,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    /// The video call (Meet, Teams, Zoom, Webex, FaceTime, …).
    pub meeting: Option<MeetingLink>,
    pub start: EventTimeDto,
    /// Exclusive, as Google's: the day after the last for an all-day event.
    pub end: EventTimeDto,
    pub all_day: bool,
    pub recurrence: Vec<String>,
    /// The email is about one changed occurrence of a series, originally at this time.
    pub recurrence_id: Option<EventTimeDto>,
    pub organizer: Option<PersonDto>,
    pub attendees: Vec<AttendeeDto>,
    /// The event as it is now on the account's calendar (the occurrence, for one occurrence).
    pub live: Option<EventDetailDto>,
    /// The live event's SEQUENCE: higher than `sequence` means the email is out of date.
    pub live_sequence: Option<i64>,
    /// The event to import when answering an invitation the calendar doesn't have (Google
    /// usually adds invitations by itself); `None` when there's nothing to answer.
    pub import: Option<Value>,
}

fn time_dto(t: &IcsTime) -> EventTimeDto {
    match t {
        IcsTime::At { ms, zone } => EventTimeDto {
            ms: Some(*ms),
            date: None,
            time_zone: zone.clone(),
        },
        IcsTime::Day(d) => EventTimeDto {
            ms: None,
            date: Some(d.format("%Y-%m-%d").to_string()),
            time_zone: None,
        },
    }
}

/// The invitation as Google's event resource, for `events.import`.
fn import_body(invite: &Invite) -> Value {
    let zone = |t: &IcsTime| match t {
        IcsTime::At { zone, .. } => zone.clone(),
        IcsTime::Day(_) => None,
    };
    // A series needs a zone to repeat in; UTC when the file named none Pheeme knows.
    let series_zone = (!invite.recurrence.is_empty())
        .then(|| zone(&invite.start).unwrap_or_else(|| "UTC".into()));
    let time = |t: &IcsTime| match t {
        IcsTime::At { ms, zone } => {
            let mut v = json!({ "dateTime": ics::rfc3339(*ms) });
            if let Some(z) = zone.clone().or_else(|| series_zone.clone()) {
                v["timeZone"] = json!(z);
            }
            v
        }
        IcsTime::Day(d) => json!({ "date": d.format("%Y-%m-%d").to_string() }),
    };
    let mut body = json!({
        "start": time(&invite.start),
        "end": time(&invite.end),
        "sequence": invite.sequence,
        "status": "confirmed",
        "attendees": invite.attendees.iter().map(|a| {
            let mut v = json!({ "email": a.email, "responseStatus": a.response });
            if let Some(n) = &a.name { v["displayName"] = json!(n); }
            if a.optional { v["optional"] = json!(true); }
            if a.resource { v["resource"] = json!(true); }
            v
        }).collect::<Vec<_>>(),
    });
    for (key, value) in [
        ("summary", &invite.summary),
        ("description", &invite.description),
        ("location", &invite.location),
    ] {
        if let Some(v) = value {
            body[key] = json!(v);
        }
    }
    if let Some(o) = &invite.organizer {
        body["organizer"] = json!({ "email": o.email });
        if let Some(n) = &o.name {
            body["organizer"]["displayName"] = json!(n);
        }
    }
    if !invite.recurrence.is_empty() {
        body["recurrence"] = json!(invite.recurrence);
    }
    body
}

/// The invitation as the card shows it, before the live event is looked up. `email` is the
/// account's address: its guest entry is `is_self`.
pub fn dto(invite: &Invite, email: &str) -> InviteDto {
    let me = |address: &str| address.eq_ignore_ascii_case(email);
    let organizer = invite.organizer.as_ref();
    let answerable = matches!(invite.method.as_str(), "REQUEST" | "PUBLISH")
        && !invite.cancelled()
        && invite.recurrence_id.is_none();
    InviteDto {
        method: invite.method.clone(),
        uid: invite.uid.clone(),
        sequence: invite.sequence,
        cancelled: invite.cancelled(),
        summary: invite.summary.clone(),
        description: invite.description.clone(),
        location: invite.location.clone(),
        meeting: invite.meeting.clone(),
        start: time_dto(&invite.start),
        end: time_dto(&invite.end),
        all_day: invite.all_day(),
        recurrence: invite.recurrence.clone(),
        recurrence_id: invite.recurrence_id.as_ref().map(time_dto),
        organizer: organizer.map(|o| PersonDto {
            email: Some(o.email.clone()),
            name: o.name.clone(),
            is_self: me(&o.email),
        }),
        attendees: invite
            .attendees
            .iter()
            .map(|a| AttendeeDto {
                email: Some(a.email.clone()),
                name: a.name.clone(),
                response: Some(a.response.clone()),
                optional: a.optional,
                organizer: organizer.is_some_and(|o| o.email.eq_ignore_ascii_case(&a.email)),
                is_self: me(&a.email),
                resource: a.resource,
                comment: None,
            })
            .collect(),
        live: None,
        live_sequence: None,
        import: answerable.then(|| import_body(invite)),
    }
}

/// Where a changed occurrence was originally, as instance ids spell it.
fn original_start(t: &IcsTime) -> OriginalStart {
    match t {
        IcsTime::At { ms, .. } => OriginalStart::Ms(*ms),
        IcsTime::Day(d) => OriginalStart::Date(*d),
    }
}

fn same_original(e: &DbEvent, at: &OriginalStart) -> bool {
    match at {
        OriginalStart::Ms(ms) => {
            e.original_start_date.is_none() && e.original_start_ms == Some(*ms)
        }
        OriginalStart::Date(d) => {
            e.original_start_date
                .as_deref()
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                == Some(*d)
        }
    }
}

impl CalendarService {
    /// The invitation in this iCalendar text for `account_id`, with the live event when the
    /// cache has it. `None` when the text holds no event.
    pub async fn invite(
        &self,
        account_id: &str,
        ics_text: &str,
    ) -> Result<Option<InviteDto>, CalendarError> {
        let account = db::accounts::get_account(&self.db, account_id)
            .await?
            .ok_or(CalendarError::NotFound)?;
        let zone = db::calendar::access(&self.db, account_id)
            .await?
            .and_then(|a| a.time_zone)
            .and_then(|z| z.parse().ok());
        let Some(invite) = ics::parse(ics_text, zone) else {
            return Ok(None);
        };
        let mut out = dto(&invite, &account.email);
        if let Some((row, id)) = self.live_target(account_id, &invite).await? {
            // A cancelled occurrence or one outside its series' rule isn't there any more.
            if let Ok(detail) = self.event_detail(account_id, &row.calendar_id, &id).await {
                out.live_sequence = serde_json::from_str::<Value>(&row.raw)
                    .ok()
                    .and_then(|r| r["sequence"].as_i64())
                    .or(Some(0));
                out.live = Some(detail);
            }
        }
        Ok(Some(out))
    }

    /// The cached row behind the invitation and the id to read: the series or single event
    /// (primary calendar first), or for one occurrence its own row or instance id.
    async fn live_target(
        &self,
        account_id: &str,
        invite: &Invite,
    ) -> Result<Option<(DbEvent, String)>, CalendarError> {
        let primary = db::calendar::calendars(&self.db, Some(account_id))
            .await?
            .into_iter()
            .find(|c| c.primary)
            .map(|c| c.id);
        let mut rows = db::calendar::events_by_ical_uid(&self.db, account_id, &invite.uid).await?;
        rows.sort_by_key(|e| Some(&e.calendar_id) != primary.as_ref());
        let Some(rid) = &invite.recurrence_id else {
            return Ok(rows
                .into_iter()
                .find(|e| e.recurring_event_id.is_none() && e.status != "cancelled")
                .map(|e| {
                    let id = e.id.clone();
                    (e, id)
                }));
        };
        let at = original_start(rid);
        if let Some(own) = rows
            .iter()
            .find(|e| e.recurring_event_id.is_some() && same_original(e, &at))
        {
            let id = own.id.clone();
            return Ok(Some((own.clone(), id)));
        }
        Ok(rows
            .into_iter()
            .find(|e| e.recurrence.is_some() && e.status != "cancelled")
            .map(|master| {
                let id = edit::instance_id(&master.id, &at);
                (master, id)
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::timed;
    use crate::calendar::service::tests::{harness, standup_series, Harness};
    use serde_json::json;

    const CAL: &str = "a@example.com";

    /// A request for `uid`, from boss to a, starting at `start` (UTC).
    fn request(uid: &str, sequence: i64, start: &str, extra: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSEQUENCE:{sequence}\r\n\
             DTSTART:{start}\r\nDURATION:PT1H\r\nSUMMARY:Review\r\n\
             ORGANIZER;CN=Boss:mailto:boss@example.com\r\n\
             ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com\r\n\
             ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:A@example.com\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
        )
    }

    async fn synced(events: Vec<Value>) -> Harness {
        let h = harness(&["a"]).await;
        for e in events {
            h.fake("a").put(CAL, e);
        }
        h.grant("a").await;
        h
    }

    #[tokio::test]
    async fn invite_without_cached_event_offers_import() {
        let h = synced(vec![]).await;
        let got = h
            .service
            .invite("a", &request("new@x", 0, "20261112T150000Z", ""))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.method, "REQUEST");
        assert_eq!(got.summary.as_deref(), Some("Review"));
        assert!(got.live.is_none());
        assert_eq!(got.start.ms, Some(1_794_495_600_000));
        let me: Vec<_> = got.attendees.iter().filter(|a| a.is_self).collect();
        assert_eq!(me.len(), 1, "matched in any case");
        assert!(got.attendees[0].organizer);
        let import = got.import.unwrap();
        assert_eq!(import["start"]["dateTime"], "2026-11-12T15:00:00Z");
        assert_eq!(import["end"]["dateTime"], "2026-11-12T16:00:00Z");
        assert_eq!(import["organizer"]["email"], "boss@example.com");
        assert_eq!(import["attendees"][1]["responseStatus"], "needsAction");
        assert!(import.get("recurrence").is_none());
    }

    #[tokio::test]
    async fn invite_reads_the_live_event() {
        let mut moved = timed(
            "review",
            "Review (moved)",
            "2026-11-12T16:00:00Z",
            "2026-11-12T17:00:00Z",
        );
        moved["sequence"] = json!(3);
        moved["attendees"] = json!([
            {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
            {"email": "a@example.com", "self": true, "responseStatus": "tentative"}
        ]);
        let h = synced(vec![moved]).await;
        let got = h
            .service
            .invite(
                "a",
                &request("review@google.com", 1, "20261112T150000Z", ""),
            )
            .await
            .unwrap()
            .unwrap();
        let live = got.live.unwrap();
        assert_eq!(live.event.id, "review");
        assert_eq!(live.event.summary.as_deref(), Some("Review (moved)"));
        assert_eq!(live.event.self_response.as_deref(), Some("tentative"));
        assert_eq!(got.live_sequence, Some(3));
        assert_eq!(got.sequence, 1);
    }

    #[tokio::test]
    async fn occurrence_invite_reads_the_occurrence() {
        let mut series = standup_series();
        series["iCalUID"] = json!("standup@google.com");
        let h = synced(vec![series]).await;
        // Monday 2 November, 09:00 New York (14:00 UTC), moved to 10:00.
        let text = request(
            "standup@google.com",
            1,
            "20261102T150000Z",
            "RECURRENCE-ID;TZID=America/New_York:20261102T090000\r\n",
        );
        let got = h.service.invite("a", &text).await.unwrap().unwrap();
        assert!(got.import.is_none(), "one occurrence isn't imported");
        assert_eq!(got.recurrence_id.unwrap().ms, Some(1_793_628_000_000));
        let live = got.live.unwrap();
        assert_eq!(live.event.id, "standup_20261102T140000Z");
        assert_eq!(live.event.master_id.as_deref(), Some("standup"));
    }

    #[tokio::test]
    async fn cancellations_and_replies_have_nothing_to_answer() {
        let h = synced(vec![]).await;
        let cancel =
            request("x@y", 2, "20261112T150000Z", "").replace("METHOD:REQUEST", "METHOD:CANCEL");
        let got = h.service.invite("a", &cancel).await.unwrap().unwrap();
        assert!(got.cancelled);
        assert!(got.import.is_none());
        let reply =
            request("x@y", 0, "20261112T150000Z", "").replace("METHOD:REQUEST", "METHOD:REPLY");
        let got = h.service.invite("a", &reply).await.unwrap().unwrap();
        assert_eq!(got.method, "REPLY");
        assert!(got.import.is_none());
        assert!(h
            .service
            .invite("a", "not a calendar")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn import_of_a_series_has_a_zone() {
        let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:s\nDTSTART:20261117T150000Z\nDTEND:20261117T153000Z\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR\n";
        let body = import_body(&ics::parse(text, None).unwrap());
        assert_eq!(body["recurrence"], json!(["RRULE:FREQ=WEEKLY"]));
        assert_eq!(body["start"]["timeZone"], "UTC");
        let day = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:d\nDTSTART;VALUE=DATE:20261224\nEND:VEVENT\nEND:VCALENDAR\n";
        let body = import_body(&ics::parse(day, None).unwrap());
        assert_eq!(body["start"], json!({"date": "2026-12-24"}));
        assert_eq!(body["end"], json!({"date": "2026-12-25"}));
    }
}
