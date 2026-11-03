//! Background sync: keeps each account's SQLite cache in step with Gmail and pushes
//! local changes through a persisted outbox. Tauri-free.
pub mod api;
pub mod convert;
pub mod engine;
pub mod events;
#[cfg(test)]
pub mod fake;

pub use api::MailApi;
pub use events::{NoopEvents, SyncEvent, SyncEvents};
