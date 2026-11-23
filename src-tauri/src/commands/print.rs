//! Printing: the window hands over the page it built from a conversation (see [`crate::print`]).

use super::CommandError;
use crate::print::{self, PrintPages};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Open a print window on `html` (a whole page) titled `title`, with the print dialog over it.
/// `allow_remote`: load remote images (held back for Spam, as in the reading pane). Async: a
/// synchronous command that builds a window can deadlock WebView2.
#[tauri::command]
pub async fn print_email(
    app: AppHandle,
    pages: State<'_, Arc<PrintPages>>,
    title: String,
    html: String,
    allow_remote: bool,
) -> Result<(), CommandError> {
    print::open_window(&app, Arc::clone(&pages), &title, html, allow_remote).map_err(|error| {
        tracing::warn!(%error, "couldn't open the print window");
        CommandError {
            code: "internal".into(),
            message: "Pheeme couldn't open the print window.".into(),
        }
    })
}
