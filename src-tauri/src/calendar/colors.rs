//! Recolouring a calendar: its entry in the account's Google calendar list, so the website and
//! phones show the new colour too. Any calendar in the list can be recoloured, other people's
//! included, since the colour belongs to the list, not the calendar. Needs the calendar-list
//! consent (`auth::CALENDAR_LIST_SCOPES`); until it's allowed this fails with `missing_scope`.

use super::error::CalendarError;
use super::service::CalendarService;
use crate::db;
use crate::sync::SyncEvent;

/// `#rrggbb`.
fn is_hex(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl CalendarService {
    /// Draw the calendar in `background` with `foreground` text (both `#rrggbb`), on Google
    /// first, then in the cache as Google confirmed it.
    pub async fn set_calendar_color(
        &self,
        account_id: &str,
        calendar_id: &str,
        background: &str,
        foreground: &str,
    ) -> Result<(), CalendarError> {
        if !is_hex(background) || !is_hex(foreground) {
            return Err(CalendarError::Invalid("That isn't a colour.".into()));
        }
        let gone = || CalendarError::Invalid("That calendar isn't in your list any more.".into());
        self.calendar(account_id, calendar_id)
            .await
            .map_err(|e| match e {
                CalendarError::NotFound => gone(),
                e => e,
            })?;
        // Holds off sync, so a calendar list it read before the change can't cache the old colour after.
        let gate = self.poller.gate(account_id);
        let _held = gate.lock().await;
        let entry = (self.api_for)(account_id)
            .set_calendar_color(
                calendar_id,
                &background.to_ascii_lowercase(),
                &foreground.to_ascii_lowercase(),
            )
            .await
            .map_err(|e| {
                if e.is_missing_scope() {
                    CalendarError::MissingScope
                } else if e.is_not_found() {
                    gone()
                } else {
                    e.into()
                }
            })?;
        db::calendar::set_colors(
            &self.db,
            account_id,
            calendar_id,
            entry.background_color.as_deref(),
            entry.foreground_color.as_deref(),
        )
        .await?;
        self.events.emit(SyncEvent::CalendarUpdated {
            account_id: account_id.to_owned(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::fake::calendar;
    use crate::calendar::service::tests::harness;
    use crate::gmail::GmailError;

    const TEAM: &str = "team@group.calendar.google.com";

    async fn color_of(h: &crate::calendar::service::tests::Harness) -> Option<String> {
        db::calendar::calendars(&h.service.db, Some("a"))
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.id == TEAM)
            .and_then(|c| c.background_color)
    }

    async fn with_team() -> crate::calendar::service::tests::Harness {
        let h = harness(&["a"]).await;
        let mut team = calendar(TEAM);
        // Someone else's calendar: its colour is still the account's to choose.
        team.access_role = "reader".into();
        h.fake("a").add_calendar(team);
        h.grant("a").await;
        h.events.take();
        h
    }

    #[tokio::test]
    async fn recolours_on_google_then_caches_and_tells_the_ui() {
        let h = with_team().await;
        h.service
            .set_calendar_color("a", TEAM, "#4986E7", "#000000")
            .await
            .unwrap();

        let writes = h.fake("a").writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].method, "calendarList.patch");
        assert_eq!(writes[0].calendar_id, TEAM);
        assert_eq!(writes[0].body["backgroundColor"], "#4986e7");
        assert_eq!(color_of(&h).await.as_deref(), Some("#4986e7"));
        assert_eq!(h.events.names(), vec!["calendar:updated"]);
        // The next sync reads the same colour back from Google.
        h.grant("a").await;
        assert_eq!(color_of(&h).await.as_deref(), Some("#4986e7"));
    }

    #[tokio::test]
    async fn without_the_consent_it_asks_for_it_and_changes_nothing() {
        let h = with_team().await;
        h.fake("a").fail_write(0, || GmailError::Api {
            status: 403,
            reason: Some("insufficientPermissions".into()),
            message: "Request had insufficient authentication scopes.".into(),
        });
        let err = h
            .service
            .set_calendar_color("a", TEAM, "#4986e7", "#000000")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "missing_scope");
        assert_eq!(color_of(&h).await.as_deref(), Some("#9fe1e7"));
        assert!(h.events.take().is_empty());
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_colour_or_a_calendar() {
        let h = with_team().await;
        for (cal, bg) in [(TEAM, "blue"), (TEAM, "#12345"), ("nope", "#4986e7")] {
            let err = h
                .service
                .set_calendar_color("a", cal, bg, "#000000")
                .await
                .unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{cal} {bg}");
        }
        assert!(h.fake("a").writes().is_empty());
    }
}
