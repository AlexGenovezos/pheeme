//! Calendar mode: each account's Google calendars and events, synced into SQLite and read
//! from there. Tauri-free; `commands/calendar.rs` is the thin IPC adapter.

pub mod convert;
#[cfg(test)]
pub(crate) mod fake;
pub mod recurrence;
pub mod sync;

use crate::gmail::calendar::{CalendarListPage, CalendarSettings, EventsPage};
use crate::gmail::{GmailClient, GmailError};
use std::sync::Arc;

/// The Calendar API calls sync needs, so tests can use [`fake::FakeCalendar`].
#[async_trait::async_trait]
pub trait CalendarApi: Send + Sync {
    async fn list_calendar_list(
        &self,
        page_token: Option<&str>,
    ) -> Result<CalendarListPage, GmailError>;
    async fn list_events(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage, GmailError>;
    async fn calendar_settings(&self) -> Result<CalendarSettings, GmailError>;
}

#[async_trait::async_trait]
impl CalendarApi for GmailClient {
    async fn list_calendar_list(
        &self,
        page_token: Option<&str>,
    ) -> Result<CalendarListPage, GmailError> {
        GmailClient::list_calendar_list(self, page_token).await
    }

    async fn list_events(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage, GmailError> {
        GmailClient::list_events(self, calendar_id, sync_token, page_token).await
    }

    async fn calendar_settings(&self) -> Result<CalendarSettings, GmailError> {
        GmailClient::calendar_settings(self).await
    }
}

/// Builds the account's Calendar API client.
pub type CalendarFactory = Arc<dyn Fn(&str) -> Arc<dyn CalendarApi> + Send + Sync>;
