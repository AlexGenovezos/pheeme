//! Calendar mode: each account's Google calendars and events, synced into SQLite and read
//! from there. Tauri-free; `commands/calendar.rs` is the thin IPC adapter.

pub mod convert;
pub mod edit;
pub mod error;
#[cfg(test)]
pub(crate) mod fake;
pub mod recurrence;
mod repeating;
mod rsvp;
pub mod series;
pub mod service;
pub mod sync;
pub mod writes;

use crate::gmail::calendar::{
    ApiEvent, CalendarListPage, CalendarSettings, EventsPage, SendUpdates, WriteOptions,
};
use crate::gmail::{GmailClient, GmailError};
use serde_json::Value;
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
    async fn insert_event(
        &self,
        calendar_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError>;
    async fn patch_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError>;
    async fn delete_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        opts: WriteOptions<'_>,
    ) -> Result<(), GmailError>;
    async fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<ApiEvent, GmailError>;
    async fn move_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        destination: &str,
        send_updates: SendUpdates,
    ) -> Result<ApiEvent, GmailError>;
    async fn import_event(&self, calendar_id: &str, body: Value) -> Result<ApiEvent, GmailError>;
    async fn events_by_ical_uid(
        &self,
        calendar_id: &str,
        ical_uid: &str,
    ) -> Result<Vec<ApiEvent>, GmailError>;
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

    async fn insert_event(
        &self,
        calendar_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        GmailClient::insert_event(self, calendar_id, body, opts).await
    }

    async fn patch_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        body: Value,
        opts: WriteOptions<'_>,
    ) -> Result<ApiEvent, GmailError> {
        GmailClient::patch_event(self, calendar_id, event_id, body, opts).await
    }

    async fn delete_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        opts: WriteOptions<'_>,
    ) -> Result<(), GmailError> {
        GmailClient::delete_event(self, calendar_id, event_id, opts).await
    }

    async fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<ApiEvent, GmailError> {
        GmailClient::get_event(self, calendar_id, event_id).await
    }

    async fn move_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        destination: &str,
        send_updates: SendUpdates,
    ) -> Result<ApiEvent, GmailError> {
        GmailClient::move_event(self, calendar_id, event_id, destination, send_updates).await
    }

    async fn import_event(&self, calendar_id: &str, body: Value) -> Result<ApiEvent, GmailError> {
        GmailClient::import_event(self, calendar_id, body).await
    }

    async fn events_by_ical_uid(
        &self,
        calendar_id: &str,
        ical_uid: &str,
    ) -> Result<Vec<ApiEvent>, GmailError> {
        GmailClient::events_by_ical_uid(self, calendar_id, ical_uid).await
    }
}

/// Builds the account's Calendar API client.
pub type CalendarFactory = Arc<dyn Fn(&str) -> Arc<dyn CalendarApi> + Send + Sync>;
