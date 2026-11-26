//! An `.ics` file from an email, added to a Google calendar (Mail's Add to calendar dialog).
//! Every event in the file: what the dialog shows of each, where it already is, and how to
//! add it. An invitation the account is a guest of is answered through
//! `respond_to_invite` instead, so the organizer hears back; everything else goes in as a
//! plain copy, without its organizer and guests, so nobody is emailed.

use super::edit::{instance_id, OriginalStart};
use super::error::CalendarError;
use super::ics::{self, IcsTime, Invite};
use super::invite::{import_body, time_dto};
use super::repeating::original_start_json;
use super::service::{CalendarService, EventTimeDto};
use super::writes::EventRef;
use crate::db;
use crate::gmail::calendar::{ApiEvent, SendUpdates, WriteOptions};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEventDto {
    pub uid: String,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub start: EventTimeDto,
    pub end: EventTimeDto,
    pub all_day: bool,
    pub repeats: bool,
    pub cancelled: bool,
    /// The account is a guest of this invitation (not its organizer): adding it accepts.
    pub invited: bool,
    /// Where it already is, by iCalendar UID, on any account's calendar.
    pub existing: Option<EventRef>,
    /// The invitation as Google's event resource, guests included, for
    /// `respond_to_calendar_invite`; `None` unless `invited`.
    pub import: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarFileDto {
    pub events: Vec<FileEventDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedEvents {
    /// The events now on the calendar, in the file's order (added, or already there).
    pub events: Vec<EventRef>,
    /// How many of them were already on the calendar.
    pub already: usize,
}

/// Whether `email` is a guest of the invitation, so adding it is an answer to its organizer.
fn invited(invite: &Invite, email: &str) -> bool {
    let me = |address: &str| address.eq_ignore_ascii_case(email);
    matches!(invite.method.as_str(), "REQUEST" | "PUBLISH")
        && !invite.cancelled()
        && invite.recurrence_id.is_none()
        && !invite.organizer.as_ref().is_some_and(|o| me(&o.email))
        && invite.attendees.iter().any(|a| me(&a.email))
}

/// The event as a plain copy: no organizer, guests or SEQUENCE, so the calendar's owner is
/// its organizer and no later edit emails anyone.
fn copy_body(invite: &Invite) -> Value {
    let mut body = import_body(invite);
    if let Some(fields) = body.as_object_mut() {
        for key in ["organizer", "attendees", "sequence"] {
            fields.remove(key);
        }
        fields.insert("iCalUID".into(), json!(invite.uid));
    }
    body
}

/// A changed occurrence of a series, as a patch of its instance in the copy: its own times
/// and details.
fn occurrence_body(invite: &Invite) -> Value {
    let body = import_body(invite);
    let fields = ["start", "end", "summary", "description", "location"]
        .into_iter()
        .filter_map(|key| Some((key.to_owned(), body.get(key)?.clone())))
        .collect();
    Value::Object(fields)
}

const QUIET: WriteOptions<'static> = WriteOptions {
    send_updates: SendUpdates::None,
    if_match: None,
    conference: false,
};

impl CalendarService {
    /// The account's calendar zone, for times the file writes without one.
    async fn floating_zone(
        &self,
        account_id: &str,
    ) -> Result<Option<chrono_tz::Tz>, CalendarError> {
        Ok(db::calendar::access(&self.db, account_id)
            .await?
            .and_then(|a| a.time_zone)
            .and_then(|z| z.parse().ok()))
    }

    /// Where an event with this UID already is: its series or single event, not cancelled,
    /// on any account's calendar (this account's first).
    async fn existing(
        &self,
        account_id: &str,
        others: &[String],
        uid: &str,
    ) -> Result<Option<EventRef>, CalendarError> {
        for id in std::iter::once(account_id).chain(others.iter().map(String::as_str)) {
            let found = db::calendar::events_by_ical_uid(&self.db, id, uid)
                .await?
                .into_iter()
                .find(|e| e.recurring_event_id.is_none() && e.status != "cancelled");
            if let Some(e) = found {
                return Ok(Some(EventRef {
                    account_id: e.account_id,
                    calendar_id: e.calendar_id,
                    id: e.id,
                }));
            }
        }
        Ok(None)
    }

    /// Copies a changed occurrence (`RECURRENCE-ID`) onto the copied series `series_id`: its
    /// instance patched, or deleted when the file cancels it. `None` for the series itself.
    async fn copy_occurrence(
        &self,
        account_id: &str,
        calendar_id: &str,
        series_id: &str,
        occurrence: &Invite,
    ) -> Result<Option<ApiEvent>, CalendarError> {
        let at = match &occurrence.recurrence_id {
            Some(IcsTime::At { ms, .. }) => OriginalStart::Ms(*ms),
            Some(IcsTime::Day(d)) => OriginalStart::Date(*d),
            None => return Ok(None),
        };
        let id = instance_id(series_id, &at);
        let api = (self.api_for)(account_id);
        if !occurrence.cancelled() {
            let result = api
                .patch_event(calendar_id, &id, occurrence_body(occurrence), QUIET)
                .await;
            return self
                .settle(account_id, calendar_id, None, result)
                .await
                .map(Some);
        }
        let result = api.delete_event(calendar_id, &id, QUIET).await;
        self.settle(account_id, calendar_id, None, result).await?;
        let zone = match &occurrence.recurrence_id {
            Some(IcsTime::At { zone: Some(z), .. }) => z.as_str(),
            _ => "UTC",
        };
        Ok(Some(ApiEvent::try_from(json!({
            "id": id,
            "status": "cancelled",
            "recurringEventId": series_id,
            "originalStartTime": original_start_json(&at, zone),
        }))?))
    }

    /// Every event in the calendar file `ics_text`, read for `account_id` (the account the
    /// email came to). `None` when the file holds no event.
    pub async fn calendar_file(
        &self,
        account_id: &str,
        ics_text: &str,
    ) -> Result<Option<CalendarFileDto>, CalendarError> {
        let account = db::accounts::get_account(&self.db, account_id)
            .await?
            .ok_or(CalendarError::NotFound)?;
        let others: Vec<String> = db::accounts::list_accounts(&self.db)
            .await?
            .into_iter()
            .map(|a| a.id)
            .filter(|id| id != account_id)
            .collect();
        let all = ics::parse_all(ics_text, self.floating_zone(account_id).await?);
        if all.is_empty() {
            return Ok(None);
        }
        let mut events = Vec::with_capacity(all.len());
        for invite in &all {
            let invited = invited(invite, &account.email);
            events.push(FileEventDto {
                uid: invite.uid.clone(),
                summary: invite.summary.clone(),
                location: invite.location.clone(),
                start: time_dto(&invite.start),
                end: time_dto(&invite.end),
                all_day: invite.all_day(),
                repeats: !invite.recurrence.is_empty(),
                cancelled: invite.cancelled(),
                invited,
                existing: self.existing(account_id, &others, &invite.uid).await?,
                import: invited.then(|| import_body(invite)),
            });
        }
        Ok(Some(CalendarFileDto { events }))
    }

    /// Adds the events of `ics_text` whose UIDs are in `uids` to `calendar_id` of
    /// `account_id`, each as a plain copy (see [`copy_body`]), a series with its changed
    /// occurrences. An event already on that calendar (same UID) is left as it is, so trying
    /// again after a failure adds only the rest. Cancelled events are never added.
    /// `file_account_id` is the account the email came to: times written without a zone are
    /// read in its zone, as [`Self::calendar_file`] showed them.
    pub async fn add_calendar_file(
        &self,
        file_account_id: &str,
        account_id: &str,
        calendar_id: &str,
        ics_text: &str,
        uids: &[String],
    ) -> Result<AddedEvents, CalendarError> {
        let _held = self.hold(account_id).await;
        self.writable(account_id, calendar_id).await?;
        let floating = self.floating_zone(file_account_id).await?;
        let every = ics::parse_every(ics_text, floating);
        let wanted: Vec<Invite> = ics::parse_all(ics_text, floating)
            .into_iter()
            .filter(|i| uids.contains(&i.uid) && !i.cancelled())
            .collect();
        if wanted.is_empty() {
            return Err(CalendarError::Invalid(
                "There's no event in this file to add.".into(),
            ));
        }
        let api = (self.api_for)(account_id);
        let (mut refs, mut imported, mut already) = (Vec::new(), Vec::new(), 0);
        let mut failure = None;
        // A series whose rollback Google didn't confirm: trying again would skip it.
        let mut half_copied: Option<&str> = None;
        for invite in &wanted {
            let there = db::calendar::events_by_ical_uid(&self.db, account_id, &invite.uid)
                .await?
                .into_iter()
                .find(|e| {
                    e.calendar_id == calendar_id
                        && e.recurring_event_id.is_none()
                        && e.status != "cancelled"
                });
            if let Some(e) = there {
                already += 1;
                refs.push(EventRef {
                    account_id: account_id.to_owned(),
                    calendar_id: calendar_id.to_owned(),
                    id: e.id,
                });
                continue;
            }
            let result = api.import_event(calendar_id, copy_body(invite)).await;
            let series = match self.settle(account_id, calendar_id, None, result).await {
                Ok(event) => event,
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            };
            let series_id = series.id.clone();
            let mut saved = vec![series];
            let changed = every
                .iter()
                .filter(|c| c.uid == invite.uid && !invite.recurrence.is_empty());
            for occurrence in changed {
                match self
                    .copy_occurrence(account_id, calendar_id, &series_id, occurrence)
                    .await
                {
                    Ok(Some(event)) => saved.push(event),
                    Ok(None) => {}
                    Err(e) => {
                        failure = Some(e);
                        break;
                    }
                }
            }
            if failure.is_some() {
                // Not left half copied: without it, trying again copies it whole.
                if api
                    .delete_event(calendar_id, &series_id, QUIET)
                    .await
                    .is_err()
                {
                    half_copied = Some(invite.summary.as_deref().unwrap_or("A repeating event"));
                }
                break;
            }
            refs.push(EventRef {
                account_id: account_id.to_owned(),
                calendar_id: calendar_id.to_owned(),
                id: series_id,
            });
            imported.extend(saved);
        }
        let added = refs.len() - already;
        if !imported.is_empty() {
            self.save_all(account_id, calendar_id, imported).await?;
        }
        match (failure, half_copied) {
            (None, _) => Ok(AddedEvents {
                events: refs,
                already,
            }),
            (Some(e), Some(name)) => {
                let done = added + already;
                let counted = if done > 0 {
                    format!("Added {done} of {} events. ", wanted.len())
                } else {
                    String::new()
                };
                Err(CalendarError::Incomplete(format!(
                    "{counted}“{name}” may be on your calendar without its changed dates. {e} \
                     If it's there, delete it, then add this file's events again."
                )))
            }
            (Some(e), None) if added + already == 0 => Err(e),
            (Some(e), None) => Err(CalendarError::Incomplete(format!(
                "Added {} of {} events. {e} Try again to add the rest.",
                added + already,
                wanted.len()
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::calendar;
    use crate::calendar::service::tests::{harness, Harness};
    use crate::gmail::GmailError;

    const CAL: &str = "a@example.com";

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/src/calendar/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(path).unwrap()
    }

    fn uids(file: &CalendarFileDto) -> Vec<String> {
        file.events.iter().map(|e| e.uid.clone()).collect()
    }

    async fn granted() -> Harness {
        let h = harness(&["a"]).await;
        h.grant("a").await;
        h
    }

    #[tokio::test]
    async fn reads_every_event_of_a_schedule() {
        let h = granted().await;
        let file = h
            .service
            .calendar_file("a", &fixture("schedule.ics"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(file.events.len(), 3);
        let practice = &file.events[1];
        assert_eq!(practice.summary.as_deref(), Some("Practice"));
        assert!(practice.repeats);
        assert!(file.events.iter().all(|e| !e.invited && e.import.is_none()));
        assert!(file.events.iter().all(|e| e.existing.is_none()));
        assert!(file.events[2].all_day);
        assert!(h
            .service
            .calendar_file("a", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn an_invitation_to_the_account_is_answered_not_copied() {
        let h = granted().await;
        let theirs = fixture("google-request.ics");
        let file = h
            .service
            .calendar_file("a", &theirs)
            .await
            .unwrap()
            .unwrap();
        assert!(!file.events[0].invited, "a isn't on the guest list");
        assert!(file.events[0].import.is_none());

        let mine = theirs.replace("avery@example.org", "A@example.com");
        let file = h.service.calendar_file("a", &mine).await.unwrap().unwrap();
        let e = &file.events[0];
        assert!(e.invited);
        let import = e.import.as_ref().unwrap();
        assert_eq!(import["organizer"]["email"], "morgan@example.org");
        assert!(import["attendees"].as_array().unwrap().len() >= 3);
    }

    #[tokio::test]
    async fn adds_plain_copies_that_email_nobody() {
        let h = granted().await;
        let text = fixture("schedule.ics");
        let file = h.service.calendar_file("a", &text).await.unwrap().unwrap();
        let added = h
            .service
            .add_calendar_file("a", "a", CAL, &text, &uids(&file))
            .await
            .unwrap();
        assert_eq!((added.events.len(), added.already), (3, 0));
        let writes = h.fake("a").writes();
        let methods: Vec<_> = writes.iter().map(|w| w.method).collect();
        assert_eq!(methods, ["import", "import", "patch", "import"]);
        for w in &writes {
            assert_eq!(w.calendar_id, CAL);
            assert!(w.body.get("attendees").is_none());
            assert!(w.body.get("organizer").is_none());
            assert!(w.send_updates.is_none_or(|s| s == SendUpdates::None));
        }
        assert_eq!(writes[0].body["iCalUID"], "game-1@league.example");
        assert_eq!(writes[1].body["recurrence"][0], "RRULE:FREQ=WEEKLY;COUNT=4");
        assert_eq!(writes[1].body["start"]["timeZone"], "America/Chicago");
        // The practice moved on December 10 (17:00 to 18:00 Chicago): its instance in the copy.
        let series = &added.events[1].id;
        assert_eq!(
            writes[2].event_id.as_deref(),
            Some(format!("{series}_20261210T230000Z").as_str())
        );
        assert_eq!(writes[2].body["start"]["dateTime"], "2026-12-11T00:00:00Z");
        assert_eq!(writes[3].body["start"]["date"], "2026-12-19");

        // Cached, so the file now reads as already there, and adding again adds nothing.
        let again = h.service.calendar_file("a", &text).await.unwrap().unwrap();
        assert!(again
            .events
            .iter()
            .all(|e| e.existing.as_ref().is_some_and(|r| r.calendar_id == CAL)));
        let twice = h
            .service
            .add_calendar_file("a", "a", CAL, &text, &uids(&file))
            .await
            .unwrap();
        assert_eq!(twice.already, 3);
        assert_eq!(h.fake("a").writes().len(), 4);
    }

    #[tokio::test]
    async fn adds_only_the_chosen_events_to_the_chosen_calendar() {
        let h = harness(&["a"]).await;
        h.fake("a").add_calendar(calendar("Kids"));
        h.grant("a").await;
        let text = fixture("schedule.ics");
        let added = h
            .service
            .add_calendar_file(
                "a",
                "a",
                "Kids",
                &text,
                &["party@league.example".to_owned()],
            )
            .await
            .unwrap();
        assert_eq!(added.events.len(), 1);
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].calendar_id, "Kids");
    }

    #[tokio::test]
    async fn a_failure_part_way_says_how_many_were_added() {
        let h = granted().await;
        let text = fixture("schedule.ics");
        let all: Vec<String> = ics::parse_all(&text, None)
            .into_iter()
            .map(|i| i.uid)
            .collect();
        h.fake("a").fail_write(1, || GmailError::Api {
            status: 403,
            reason: Some("forbidden".into()),
            message: "nope".into(),
        });
        let err = h
            .service
            .add_calendar_file("a", "a", CAL, &text, &all)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CalendarError::Incomplete(m) if m.starts_with("Added 1 of 3 events.")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_refused_occurrence_takes_its_series_back_out() {
        let h = granted().await;
        let text = fixture("schedule.ics");
        let practice = ["practice@league.example".to_owned()];
        // Write 0 imports the series, write 1 patches its moved occurrence.
        h.fake("a").fail_write(1, || GmailError::Api {
            status: 403,
            reason: Some("forbidden".into()),
            message: "nope".into(),
        });
        h.service
            .add_calendar_file("a", "a", CAL, &text, &practice)
            .await
            .unwrap_err();
        let methods: Vec<_> = h.fake("a").writes().iter().map(|w| w.method).collect();
        assert_eq!(methods, ["import", "patch", "delete"]);
        let file = h.service.calendar_file("a", &text).await.unwrap().unwrap();
        assert!(file.events[1].existing.is_none());
    }

    #[tokio::test]
    async fn a_series_google_keeps_half_copied_says_so() {
        let h = granted().await;
        let text = fixture("schedule.ics");
        let both = [
            "game-1@league.example".to_owned(),
            "practice@league.example".to_owned(),
        ];
        let refused = || GmailError::Api {
            status: 403,
            reason: Some("forbidden".into()),
            message: "nope".into(),
        };
        // The game goes on; the practice's moved occurrence is refused, then so is taking the
        // series back out.
        h.fake("a").fail_write(2, refused);
        h.fake("a").fail_write(3, refused);
        let err = h
            .service
            .add_calendar_file("a", "a", CAL, &text, &both)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CalendarError::Incomplete(m)
                if m.starts_with("Added 1 of 2 events. “Practice” may be on your calendar")
                    && m.ends_with("delete it, then add this file's events again.")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn refuses_a_calendar_it_cannot_write_to() {
        let h = harness(&["a"]).await;
        let mut holidays = calendar("Holidays");
        holidays.access_role = "reader".into();
        h.fake("a").add_calendar(holidays);
        h.grant("a").await;
        let err = h
            .service
            .add_calendar_file(
                "a",
                "a",
                "Holidays",
                &fixture("schedule.ics"),
                &["party@league.example".to_owned()],
            )
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::ReadOnly(_)));
        assert!(h.fake("a").writes().is_empty());
    }
}
