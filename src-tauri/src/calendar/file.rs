//! An `.ics` file from an email, added to a Google calendar (Mail's Add to calendar dialog).
//! Every event in the file: what the dialog shows of each, where it already is, and how to
//! add it. An invitation the account is a guest of is answered through
//! `respond_to_invite` instead, so the organizer hears back; everything else goes in as a
//! plain copy, without its organizer and guests, so nobody is emailed.

use super::error::CalendarError;
use super::ics::{self, Invite};
use super::invite::{import_body, time_dto};
use super::service::{CalendarService, EventTimeDto};
use super::writes::EventRef;
use crate::db;
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
    /// `account_id`, each as a plain copy (see [`copy_body`]). An event already on that
    /// calendar (same UID) is left as it is, so trying again after a failure adds only the
    /// rest. Cancelled events are never added.
    pub async fn add_calendar_file(
        &self,
        account_id: &str,
        calendar_id: &str,
        ics_text: &str,
        uids: &[String],
    ) -> Result<AddedEvents, CalendarError> {
        self.writable(account_id, calendar_id).await?;
        let wanted: Vec<Invite> = ics::parse_all(ics_text, self.floating_zone(account_id).await?)
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
            match self.settle(account_id, calendar_id, None, result).await {
                Ok(event) => {
                    refs.push(EventRef {
                        account_id: account_id.to_owned(),
                        calendar_id: calendar_id.to_owned(),
                        id: event.id.clone(),
                    });
                    imported.push(event);
                }
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        let added = imported.len();
        if !imported.is_empty() {
            self.save_all(account_id, calendar_id, imported).await?;
        }
        match failure {
            None => Ok(AddedEvents {
                events: refs,
                already,
            }),
            Some(e) if added + already == 0 => Err(e),
            Some(e) => Err(CalendarError::Incomplete(format!(
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
            .add_calendar_file("a", CAL, &text, &uids(&file))
            .await
            .unwrap();
        assert_eq!((added.events.len(), added.already), (3, 0));
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 3);
        for w in &writes {
            assert_eq!(w.method, "import");
            assert_eq!(w.calendar_id, CAL);
            assert!(w.body.get("attendees").is_none());
            assert!(w.body.get("organizer").is_none());
        }
        assert_eq!(writes[0].body["iCalUID"], "game-1@league.example");
        assert_eq!(writes[1].body["recurrence"][0], "RRULE:FREQ=WEEKLY;COUNT=4");
        assert_eq!(writes[1].body["start"]["timeZone"], "America/Chicago");
        assert_eq!(writes[2].body["start"]["date"], "2026-12-19");

        // Cached, so the file now reads as already there, and adding again adds nothing.
        let again = h.service.calendar_file("a", &text).await.unwrap().unwrap();
        assert!(again
            .events
            .iter()
            .all(|e| e.existing.as_ref().is_some_and(|r| r.calendar_id == CAL)));
        let twice = h
            .service
            .add_calendar_file("a", CAL, &text, &uids(&file))
            .await
            .unwrap();
        assert_eq!(twice.already, 3);
        assert_eq!(h.fake("a").writes().len(), 3);
    }

    #[tokio::test]
    async fn adds_only_the_chosen_events_to_the_chosen_calendar() {
        let h = harness(&["a"]).await;
        h.fake("a").add_calendar(calendar("Kids"));
        h.grant("a").await;
        let text = fixture("schedule.ics");
        let added = h
            .service
            .add_calendar_file("a", "Kids", &text, &["party@league.example".to_owned()])
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
            .add_calendar_file("a", CAL, &text, &all)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CalendarError::Incomplete(m) if m.starts_with("Added 1 of 3 events.")),
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
