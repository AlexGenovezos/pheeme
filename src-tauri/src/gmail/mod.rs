//! Typed Gmail REST client. Independent of Tauri so the sync engine and commands can both use it.
pub mod auth;
pub mod calendar;
pub mod client;
pub mod drafts;
pub mod error;
pub mod filters;
pub mod history;
pub mod labels;
pub mod messages;
pub mod mime;
pub mod palette;
pub mod people;
pub mod probe;
pub mod send_as;
pub mod threads;
pub mod types;
pub mod user;

pub use client::{
    user_action, GmailClient, QuotaSetting, RetryPolicy, TokenProvider, RATE_LIMIT_COOLDOWN,
};
pub use error::GmailError;
pub use mime::{ParsedAttachment, ParsedMessage};
pub use types::MessageFormat;
