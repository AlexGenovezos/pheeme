//! Context for an email address, read entirely from the account's local cache.
use super::*;
use crate::calendar::service::{CalendarEventDto, CalendarService};
use crate::sync::engine::SyncError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonConversation {
    pub id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonProfile {
    pub address: String,
    pub name: Option<String>,
    pub saved: bool,
    /// From Google Contacts (the user's own contact first, then Other contacts).
    pub phone: Option<String>,
    pub organization: Option<String>,
    pub photo_url: Option<String>,
    pub conversations: Vec<PersonConversation>,
    /// Meetings together in the next 90 days, soonest first.
    pub events: Vec<CalendarEventDto>,
    /// Meetings together that ended in the last 180 days, newest first.
    pub past_events: Vec<CalendarEventDto>,
    pub calendar_available: bool,
}

/// How far back the card looks for meetings together.
const PAST_DAYS: i64 = 180;
const DAY_MS: i64 = 86_400_000;

fn validated_address(address: &str) -> Result<String, MailError> {
    let address = address.trim().to_lowercase();
    if address.len() > 320 || address.parse::<lettre::Address>().is_err() {
        return Err(MailError::Invalid(
            "That isn't a valid email address.".into(),
        ));
    }
    Ok(address)
}

impl ContactService {
    pub async fn person(
        &self,
        calendar: &CalendarService,
        account_id: &str,
        address: &str,
        display_tz: &str,
    ) -> Result<PersonProfile, MailError> {
        let address = validated_address(address)?;
        if db::accounts::get_account(&self.db, account_id)
            .await?
            .is_none()
        {
            return Err(MailError::Invalid(
                "That account isn't connected any more.".into(),
            ));
        }
        let contact = db::contacts::all(&self.db, account_id)
            .await?
            .into_iter()
            .find(|c| c.address.eq_ignore_ascii_case(&address));
        let conversations = db::contacts::person_threads(&self.db, account_id, &address)
            .await?
            .into_iter()
            .map(|t| PersonConversation {
                id: t.id,
                subject: t.subject,
                snippet: t.snippet,
                date: t.date,
            })
            .collect();
        let card = db::contacts::card(&self.db, account_id, &address).await?;
        let now = now_ms();
        let events = calendar
            .events_with_person(
                account_id,
                &address,
                now,
                now + 90 * DAY_MS,
                display_tz,
                false,
            )
            .await?;
        // A meeting still going on is upcoming, not past.
        let past_events = calendar
            .events_with_person(
                account_id,
                &address,
                now - PAST_DAYS * DAY_MS,
                now,
                display_tz,
                true,
            )
            .await?
            .into_iter()
            .filter(|p| {
                !events.iter().any(|e| {
                    e.calendar_id == p.calendar_id
                        && e.id == p.id
                        && e.start.ms == p.start.ms
                        && e.start.date == p.start.date
                })
            })
            .collect();
        let calendar_available = calendar
            .accounts()
            .await?
            .iter()
            .any(|a| a.account_id == account_id && a.access.status == "on");
        Ok(PersonProfile {
            address,
            name: contact.as_ref().and_then(|c| c.name.clone()),
            saved: contact.is_some_and(|c| c.saved),
            phone: card.phone,
            organization: card.organization,
            photo_url: card.photo_url,
            conversations,
            events,
            past_events,
            calendar_available,
        })
    }

    pub async fn save_person(
        &self,
        account_id: &str,
        address: &str,
        name: Option<&str>,
    ) -> Result<(), MailError> {
        let address = validated_address(address)?;
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        if name.is_some_and(|n| n.len() > 500) {
            return Err(MailError::Invalid("That contact name is too long.".into()));
        }
        let gate = self.poller.gate(account_id);
        let _guard = gate.lock().await;
        if db::accounts::get_account(&self.db, account_id)
            .await?
            .is_none()
        {
            return Err(MailError::Invalid(
                "That account isn't connected any more.".into(),
            ));
        }
        if db::contacts::all(&self.db, account_id)
            .await?
            .iter()
            .any(|c| c.address == address && c.saved)
        {
            return Ok(());
        }
        (self.people_for)(account_id).create_contact(&address, name).await.map_err(|e| {
            if matches!(e, GmailError::Network(_) | GmailError::Decode(_) | GmailError::Api { status: 500..=599, .. }) {
                MailError::Invalid("Saving couldn't be confirmed. Check Google Contacts before trying again; the contact may already be there.".into())
            } else { MailError::Sync(SyncError::Gmail(e)) }
        })?;
        db::contacts::save_person(&self.db, account_id, &address, name).await?;
        self.forget(account_id);
        Ok(())
    }
}
