//! Typed Gmail REST client. Independent of Tauri so the sync engine and commands can both use it.
pub mod auth;
pub mod client;
pub mod drafts;
pub mod error;
pub mod history;
pub mod labels;
pub mod messages;
pub mod mime;
pub mod threads;
pub mod types;
pub mod user;

pub use client::{GmailClient, QuotaSetting, RetryPolicy, TokenProvider};
pub use error::GmailError;
pub use mime::{ParsedAttachment, ParsedMessage};
pub use types::MessageFormat;
