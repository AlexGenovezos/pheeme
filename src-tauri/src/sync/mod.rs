//! Background sync: keeps each account's SQLite cache in step with Gmail and pushes
//! local changes through a persisted outbox. Tauri-free.
pub mod api;
pub mod connectivity;
pub mod convert;
pub mod engine;
pub mod events;
#[cfg(any(test, feature = "test-support"))]
pub mod fake;
pub mod manager;
pub mod outbox;
#[cfg(test)]
mod tests;

pub use api::MailApi;
pub use events::{NoopEvents, SyncEvent, SyncEvents};
