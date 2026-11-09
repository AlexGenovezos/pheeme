//! Calendar mode: each account's Google calendars and events, synced into SQLite and read
//! from there. Tauri-free; `commands/calendar.rs` is the thin IPC adapter.

pub mod recurrence;
