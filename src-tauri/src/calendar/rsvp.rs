//! Answering invitations: Yes, Maybe or No with an optional note, on an event already on a
//! calendar or on an invite Mail found by its iCalendar UID (imported first when it isn't
//! on the calendar yet). Guests are always emailed the answer, as calendar.google.com does.

use super::edit;
use super::error::CalendarError;
use super::repeating::{InSeries, Resolved};
use super::service::CalendarService;
use super::writes::{raw, EditScope, EventRef};
use crate::db;
use crate::db::calendar::DbEvent;
use crate::gmail::calendar::{ApiEvent, SendUpdates, WriteOptions};
use serde_json::{json, Value};

const RESPONSES: [&str; 3] = ["accepted", "tentative", "declined"];

fn invalid(message: &str) -> CalendarError {
    CalendarError::Invalid(message.to_owned())
}

/// What an answer patches: the event's id at Google, its etag when it is stored, and the
/// resource whose attendee list the answer starts from.
struct Answer {
    id: String,
    etag: Option<String>,
    base: Value,
}

impl Answer {
    fn stored(e: &DbEvent) -> Self {
        Answer {
            id: e.id.clone(),
            etag: (!e.etag.is_empty()).then(|| e.etag.clone()),
            base: raw(e),
        }
    }
}

/// `{"attendees": [...]}` from `base`'s list with this account's answer: its own entry
/// (`self`, or its address in any case) changed, or added when there is none. Everyone
/// else's entry is sent back as it was.
fn answered(base: &Value, email: &str, response: &str, comment: Option<&str>) -> Value {
    let mut attendees = base["attendees"].as_array().cloned().unwrap_or_default();
    let is_self = |a: &Value| {
        a["self"] == true
            || a["email"]
                .as_str()
                .is_some_and(|e| e.eq_ignore_ascii_case(email))
    };
    let at = match attendees.iter().position(is_self) {
        Some(i) => i,
        None => {
            attendees.push(json!({ "email": email }));
            attendees.len() - 1
        }
    };
    if let Some(me) = attendees[at].as_object_mut() {
        me.insert("responseStatus".into(), json!(response));
        match comment {
            Some("") => {
                me.remove("comment");
            }
            Some(c) => {
                me.insert("comment".into(), json!(c));
            }
            None => {}
        }
    }
    json!({ "attendees": attendees })
}

impl CalendarService {
    /// Answers an invitation for this account: `response` is `accepted`, `tentative` or
    /// `declined`, for one occurrence (`This`) or the whole series (`All`). `comment` `None`
    /// keeps the current note, `Some("")` removes it. Guests are always told, and no edit
    /// rights are needed: a guest answers on their own calendar.
    pub async fn respond(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        scope: EditScope,
        response: &str,
        comment: Option<String>,
    ) -> Result<EventRef, CalendarError> {
        if !RESPONSES.contains(&response) {
            return Err(invalid("The answer must be yes, maybe or no."));
        }
        if scope == EditScope::Following {
            return Err(invalid(
                "An answer is for one event or the whole series, not this and following.",
            ));
        }
        self.calendar(account_id, calendar_id).await?;
        let email = db::accounts::get_account(&self.db, account_id)
            .await?
            .ok_or(CalendarError::NotFound)?
            .email;
        let api = (self.api_for)(account_id);
        let mut retried = false;
        loop {
            let answer = self
                .answer_target(account_id, calendar_id, event_id, scope)
                .await?;
            let body = answered(&answer.base, &email, response, comment.as_deref());
            let opts = WriteOptions {
                send_updates: SendUpdates::All,
                if_match: answer.etag.as_deref(),
                conference: false,
            };
            let result = api.patch_event(calendar_id, &answer.id, body, opts).await;
            match result {
                // Someone changed the event (often another guest answering): answer again
                // on the fresh copy, once.
                Err(e) if e.is_conflict() && !retried => {
                    retried = true;
                    self.refresh_after_conflict(account_id, calendar_id, &answer.id)
                        .await;
                }
                result => {
                    let etag_id = answer.etag.is_some().then_some(answer.id.as_str());
                    let saved = self
                        .settle(account_id, calendar_id, etag_id, result)
                        .await?;
                    return self.save(account_id, calendar_id, saved).await;
                }
            }
        }
    }

    /// What an answer for `event_id` patches. "This" on an occurrence Google has no row for
    /// patches its instance id, starting from the series' guests; "all" patches the series.
    async fn answer_target(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        scope: EditScope,
    ) -> Result<Answer, CalendarError> {
        let target = self.target(account_id, calendar_id, event_id).await?;
        let s = match self.resolve(account_id, calendar_id, target, scope).await? {
            Resolved::Single(e) => return Ok(Answer::stored(&e)),
            Resolved::Series(s) => s,
        };
        let InSeries { master, at, row } = *s;
        match (scope, row, master) {
            (EditScope::All, _, Some(m)) => Ok(Answer::stored(&m)),
            (EditScope::All, _, None) => Err(invalid(
                "Pheeme doesn't have the rest of this series, so you can only answer for this event.",
            )),
            (_, Some(r), _) => Ok(Answer::stored(&r)),
            (_, None, Some(m)) => Ok(Answer {
                id: edit::instance_id(&m.id, &at),
                etag: None,
                base: raw(&m),
            }),
            (_, None, None) => Err(CalendarError::NotFound),
        }
    }

    /// Answers the invitation with this iCalendar UID for the whole event (Mail's invite
    /// card). It is looked for in the cache (primary calendar first), then at Google on the
    /// primary calendar; failing both, `import` (the invite as an event resource) is
    /// imported there first. Without `import` a missing invite is `NotFound`.
    pub async fn respond_to_invite(
        &self,
        account_id: &str,
        ical_uid: &str,
        response: &str,
        comment: Option<String>,
        import: Option<Value>,
    ) -> Result<EventRef, CalendarError> {
        if !RESPONSES.contains(&response) {
            return Err(invalid("The answer must be yes, maybe or no."));
        }
        let primary = db::calendar::calendars(&self.db, Some(account_id))
            .await?
            .into_iter()
            .find(|c| c.primary)
            .map(|c| c.id);
        let mut cached: Vec<DbEvent> =
            db::calendar::events_by_ical_uid(&self.db, account_id, ical_uid)
                .await?
                .into_iter()
                .filter(|e| e.recurring_event_id.is_none() && e.status != "cancelled")
                .collect();
        cached.sort_by_key(|e| Some(&e.calendar_id) != primary.as_ref());
        let (calendar_id, id) = match cached.into_iter().next() {
            Some(e) => (e.calendar_id, e.id),
            None => {
                let primary = primary.ok_or(CalendarError::NotFound)?;
                let found = self
                    .find_or_import(account_id, &primary, ical_uid, import)
                    .await?;
                (found.calendar_id, found.id)
            }
        };
        self.respond(
            account_id,
            &calendar_id,
            &id,
            EditScope::All,
            response,
            comment,
        )
        .await
    }

    /// The invite on Google's copy of the primary calendar (the series rather than one of
    /// its changed occurrences), or `import` imported there, cached.
    async fn find_or_import(
        &self,
        account_id: &str,
        primary: &str,
        ical_uid: &str,
        import: Option<Value>,
    ) -> Result<EventRef, CalendarError> {
        let api = (self.api_for)(account_id);
        let result = api.events_by_ical_uid(primary, ical_uid).await;
        let items = self.settle(account_id, primary, None, result).await?;
        let live = |e: &&ApiEvent| e.status.as_deref() != Some("cancelled");
        let found = items
            .iter()
            .filter(live)
            .find(|e| e.recurring_event_id.is_none())
            .or_else(|| items.iter().find(live))
            .cloned();
        let event = match (found, import) {
            (Some(e), _) => e,
            (None, Some(mut body)) => {
                let Some(fields) = body.as_object_mut() else {
                    return Err(invalid("Pheeme couldn't read this invitation."));
                };
                fields.insert("iCalUID".into(), json!(ical_uid));
                let result = api.import_event(primary, body).await;
                self.settle(account_id, primary, None, result).await?
            }
            (None, None) => return Err(CalendarError::NotFound),
        };
        self.save(account_id, primary, event).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::calendar;
    use crate::calendar::service::tests::{guest_event, harness, standup_series, Harness};
    use crate::db;
    use crate::db::calendar::DbEvent;
    use crate::gmail::calendar::SendUpdates;
    use crate::gmail::GmailError;
    use serde_json::json;

    const CAL: &str = "a@example.com";

    fn conflict() -> GmailError {
        GmailError::Api {
            status: 412,
            reason: Some("conditionNotMet".into()),
            message: "Precondition Failed".into(),
        }
    }

    /// `review`, organized by boss, with a's own answer and two other guests' answers.
    fn review() -> Value {
        let mut e = guest_event();
        e["attendees"] = json!([
            {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
            {"email": "A@Example.com", "responseStatus": "needsAction", "comment": "maybe"},
            {"email": "c@example.com", "responseStatus": "declined", "comment": "away"},
            {"email": "d@example.com", "responseStatus": "tentative"}
        ]);
        e
    }

    /// A guest's copy of the weekly standup (Mondays 09:00 New York).
    fn guest_standup() -> Value {
        let mut e = standup_series();
        e["organizer"] = json!({"email": "boss@example.com"});
        e["attendees"] = json!([
            {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
            {"email": "a@example.com", "self": true, "responseStatus": "needsAction"}
        ]);
        e
    }

    async fn synced(events: Vec<Value>) -> Harness {
        let h = harness(&["a"]).await;
        for e in events {
            h.fake("a").put(CAL, e);
        }
        h.grant("a").await;
        h.events.take();
        h
    }

    async fn cached(h: &Harness, cal: &str, id: &str) -> Option<DbEvent> {
        db::calendar::event(&h.service.db, "a", cal, id)
            .await
            .unwrap()
    }

    fn methods(h: &Harness) -> Vec<&'static str> {
        h.fake("a").writes().iter().map(|w| w.method).collect()
    }

    #[tokio::test]
    async fn rsvp_keeps_other_attendees() {
        let h = synced(vec![review()]).await;
        let r = h
            .service
            .respond("a", CAL, "review", EditScope::All, "accepted", None)
            .await
            .unwrap();
        assert_eq!(
            r,
            EventRef {
                account_id: "a".into(),
                calendar_id: CAL.into(),
                id: "review".into()
            }
        );
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.method, "patch");
        assert_eq!(w.event_id.as_deref(), Some("review"));
        assert_eq!(w.send_updates, Some(SendUpdates::All));
        assert_eq!(w.if_match.as_deref(), Some("\"review\""));
        assert!(!w.conference);
        assert_eq!(
            w.body,
            json!({"attendees": [
                {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
                {"email": "A@Example.com", "responseStatus": "accepted", "comment": "maybe"},
                {"email": "c@example.com", "responseStatus": "declined", "comment": "away"},
                {"email": "d@example.com", "responseStatus": "tentative"}
            ]})
        );
        let row = cached(&h, CAL, "review").await.unwrap();
        assert_eq!(
            json!(row.etag),
            h.fake("a").event(CAL, "review").unwrap()["etag"]
        );
        assert_eq!(h.events.names(), vec!["calendar:updated"]);

        // A note replaces the old one; an empty note removes it.
        h.service
            .respond(
                "a",
                CAL,
                "review",
                EditScope::This,
                "tentative",
                Some("late".into()),
            )
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(
            w.body["attendees"][1],
            json!({"email": "A@Example.com", "responseStatus": "tentative", "comment": "late"})
        );
        h.service
            .respond(
                "a",
                CAL,
                "review",
                EditScope::This,
                "declined",
                Some(String::new()),
            )
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(
            w.body["attendees"][1],
            json!({"email": "A@Example.com", "responseStatus": "declined"})
        );
        assert_eq!(w.body["attendees"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn rsvp_adds_self_when_missing() {
        let mut e = guest_event();
        e["attendees"] = json!([
            {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"}
        ]);
        let h = synced(vec![e]).await;
        h.service
            .respond(
                "a",
                CAL,
                "review",
                EditScope::All,
                "declined",
                Some("sorry".into()),
            )
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(
            w.body,
            json!({"attendees": [
                {"email": "boss@example.com", "organizer": true, "responseStatus": "accepted"},
                {"email": "a@example.com", "responseStatus": "declined", "comment": "sorry"}
            ]})
        );
    }

    #[tokio::test]
    async fn rsvp_this_occurrence_patches_instance() {
        let h = synced(vec![guest_standup()]).await;
        let id = "standup_20261102T140000Z";
        let r = h
            .service
            .respond("a", CAL, id, EditScope::This, "accepted", None)
            .await
            .unwrap();
        assert_eq!(r.id, id);
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.event_id.as_deref(), Some(id));
        assert_eq!(w.if_match, None, "an unstored occurrence has no etag");
        assert_eq!(w.send_updates, Some(SendUpdates::All));
        assert_eq!(w.body["attendees"][1]["responseStatus"], "accepted");
        assert_eq!(w.body["attendees"][0]["email"], "boss@example.com");
        let row = cached(&h, CAL, id).await.unwrap();
        assert_eq!(row.recurring_event_id.as_deref(), Some("standup"));
        assert_eq!(row.self_response.as_deref(), Some("accepted"));
        let master = cached(&h, CAL, "standup").await.unwrap();
        assert_eq!(master.self_response.as_deref(), Some("needsAction"));

        // "All" on an occurrence answers the series.
        let other = "standup_20261109T140000Z";
        h.service
            .respond("a", CAL, other, EditScope::All, "declined", None)
            .await
            .unwrap();
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.event_id.as_deref(), Some("standup"));
        assert_eq!(w.if_match.as_deref(), Some("\"standup\""));
        assert_eq!(w.body["attendees"][1]["responseStatus"], "declined");
        let master = cached(&h, CAL, "standup").await.unwrap();
        assert_eq!(master.self_response.as_deref(), Some("declined"));
    }

    #[tokio::test]
    async fn rsvp_retries_once_after_conflict() {
        let h = synced(vec![review()]).await;
        // Someone else answered in the meantime; the cache still has the old copy.
        let mut theirs = review();
        theirs["etag"] = json!("\"r2\"");
        theirs["attendees"][3]["responseStatus"] = json!("accepted");
        h.fake("a").put(CAL, theirs);

        h.service
            .respond("a", CAL, "review", EditScope::All, "accepted", None)
            .await
            .unwrap();
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0].if_match.as_deref(), Some("\"review\""));
        assert_eq!(writes[1].if_match.as_deref(), Some("\"r2\""));
        assert_eq!(writes[1].send_updates, Some(SendUpdates::All));
        let attendees = &writes[1].body["attendees"];
        assert_eq!(attendees[1]["responseStatus"], "accepted");
        assert_eq!(
            attendees[3]["responseStatus"], "accepted",
            "built from the fresh copy"
        );
        let google = h.fake("a").event(CAL, "review").unwrap();
        assert_eq!(google["attendees"][3]["responseStatus"], "accepted");
        assert_eq!(google["attendees"][1]["responseStatus"], "accepted");
    }

    #[tokio::test]
    async fn rsvp_second_conflict_is_reported() {
        let h = synced(vec![review()]).await;
        h.fake("a").fail_write(0, conflict);
        h.fake("a").fail_write(1, conflict);
        let err = h
            .service
            .respond("a", CAL, "review", EditScope::All, "accepted", None)
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Conflict), "{err:?}");
        assert_eq!(methods(&h), vec!["patch", "patch"], "retried only once");
    }

    #[tokio::test]
    async fn rsvp_following_is_invalid() {
        let h = synced(vec![guest_standup(), review()]).await;
        let err = h
            .service
            .respond("a", CAL, "standup", EditScope::Following, "accepted", None)
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::Invalid(_)), "{err:?}");
        for response in ["needsAction", "yes", ""] {
            let err = h
                .service
                .respond("a", CAL, "review", EditScope::All, response, None)
                .await
                .unwrap_err();
            assert!(
                matches!(err, CalendarError::Invalid(_)),
                "{response}: {err:?}"
            );
        }
        let err = h
            .service
            .respond("a", "nope", "review", EditScope::All, "accepted", None)
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::NotFound), "{err:?}");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn rsvp_needs_no_edit_rights() {
        let h = harness(&["a"]).await;
        let mut reader = calendar("shared");
        reader.access_role = "reader".into();
        h.fake("a").add_calendar(reader);
        h.fake("a").put("shared", review());
        h.grant("a").await;
        h.service
            .respond("a", "shared", "review", EditScope::All, "accepted", None)
            .await
            .unwrap();
        assert_eq!(methods(&h), vec!["patch"]);
    }

    #[tokio::test]
    async fn respond_to_invite_finds_cached_event_by_uid() {
        let h = harness(&["a"]).await;
        // The same invitation on another calendar, listed first by id.
        h.fake("a").add_calendar(calendar("Shared"));
        h.fake("a").put("Shared", review());
        h.fake("a").put(CAL, review());
        h.grant("a").await;

        let r = h
            .service
            .respond_to_invite("a", "review@google.com", "accepted", None, None)
            .await
            .unwrap();
        assert_eq!((r.calendar_id.as_str(), r.id.as_str()), (CAL, "review"));
        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].method, "patch");
        assert_eq!(writes[0].calendar_id, CAL, "primary calendar first");
        assert_eq!(writes[0].send_updates, Some(SendUpdates::All));
    }

    #[tokio::test]
    async fn respond_to_invite_falls_back_to_api_lookup() {
        let h = synced(vec![]).await;
        // Google has it; the cache doesn't yet.
        h.fake("a").put(CAL, review());
        assert!(cached(&h, CAL, "review").await.is_none());

        let r = h
            .service
            .respond_to_invite("a", "review@google.com", "tentative", None, None)
            .await
            .unwrap();
        assert_eq!(r.id, "review");
        assert_eq!(methods(&h), vec!["patch"]);
        let w = h.fake("a").writes().pop().unwrap();
        assert_eq!(w.if_match.as_deref(), Some("\"review\""));
        let google = h.fake("a").event(CAL, "review").unwrap();
        assert_eq!(google["attendees"][1]["responseStatus"], "tentative");
        assert!(cached(&h, CAL, "review").await.is_some());
    }

    #[tokio::test]
    async fn respond_to_invite_imports_when_missing() {
        let h = synced(vec![]).await;
        let mut invite = review();
        for key in ["id", "etag", "updated", "status"] {
            invite.as_object_mut().unwrap().remove(key);
        }
        let r = h
            .service
            .respond_to_invite(
                "a",
                "review@google.com",
                "accepted",
                Some("see you".into()),
                Some(invite),
            )
            .await
            .unwrap();
        let writes = h.fake("a").writes();
        assert_eq!(methods(&h), vec!["import", "patch"]);
        assert_eq!(writes[0].calendar_id, CAL);
        assert_eq!(writes[1].event_id.as_deref(), Some(r.id.as_str()));
        let google = h.fake("a").event(CAL, &r.id).unwrap();
        assert!(
            writes[1].if_match.is_some(),
            "the imported copy's etag is sent"
        );
        assert_eq!(writes[1].send_updates, Some(SendUpdates::All));
        assert_eq!(google["iCalUID"], "review@google.com");
        assert_eq!(
            google["attendees"][1],
            json!({"email": "A@Example.com", "responseStatus": "accepted", "comment": "see you"})
        );
        let row = cached(&h, CAL, &r.id).await.unwrap();
        assert_eq!(json!(row.etag), google["etag"]);
    }

    #[tokio::test]
    async fn respond_to_invite_without_import_is_not_found() {
        let h = synced(vec![]).await;
        let err = h
            .service
            .respond_to_invite("a", "review@google.com", "accepted", None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, CalendarError::NotFound), "{err:?}");
        assert!(h.fake("a").writes().is_empty());
    }
}
