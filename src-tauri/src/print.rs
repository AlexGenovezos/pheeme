//! Printing an email the way Gmail does: the conversation as a plain page in a window of its
//! own, with the system's print dialog over it. The page is built by the main window from the
//! conversation it shows (sanitized bodies, as the reading pane has them) and served here under
//! a policy that runs no script and loads nothing but images, so the email can't act in it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::lock::lock;

pub const PRINT_SCHEME: &str = "pheeme-print";
/// The scheme's host on Windows, where WebView2 serves custom protocols over `http`.
const WINDOWS_PRINT_HOST: &str = "pheeme-print.localhost";

/// A page waiting in its window.
struct Page {
    html: String,
    allow_remote: bool,
}

/// The print pages of open print windows, by number.
#[derive(Default)]
pub struct PrintPages {
    pages: Mutex<HashMap<u64, Page>>,
    next: AtomicU64,
}

impl PrintPages {
    /// Keep `html` for a new print window; its number names the window and the page's URL.
    pub fn add(&self, html: String, allow_remote: bool) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.pages).insert(id, Page { html, allow_remote });
        id
    }

    /// The window closed.
    pub fn remove(&self, id: u64) {
        lock(&self.pages).remove(&id);
    }

    /// Answer a `pheeme-print` request: the page with its policy, or 404.
    pub fn serve(&self, uri: &str) -> tauri::http::Response<Vec<u8>> {
        let page = page_id(uri).and_then(|id| {
            lock(&self.pages)
                .get(&id)
                .map(|p| (p.html.clone(), p.allow_remote))
        });
        let Some((html, allow_remote)) = page else {
            let mut response = tauri::http::Response::new(Vec::new());
            *response.status_mut() = tauri::http::StatusCode::NOT_FOUND;
            return response;
        };
        tauri::http::Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header(
                "Content-Security-Policy",
                content_security_policy(allow_remote),
            )
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .header("Cache-Control", "no-store")
            .body(html.into_bytes())
            .expect("fixed headers are valid")
    }
}

/// The reading pane's frame policy (`src/mail/srcdoc.ts`), with scripts named as refused: images
/// only (remote ones unless held back, as in Spam), inline styles, and nothing else.
fn content_security_policy(allow_remote: bool) -> String {
    let remote = if allow_remote { " https: http:" } else { "" };
    format!(
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; \
         img-src data: pheeme-att: http://pheeme-att.localhost{remote}; \
         form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
}

/// The page number a print URL names (`pheeme-print://localhost/7`, or on Windows
/// `http://pheeme-print.localhost/7`).
fn page_id(uri: &str) -> Option<u64> {
    let url = tauri::Url::parse(uri).ok()?;
    let ours = match url.scheme() {
        PRINT_SCHEME => true,
        "http" | "https" => url.host_str() == Some(WINDOWS_PRINT_HOST),
        _ => false,
    };
    if !ours {
        return None;
    }
    url.path().trim_start_matches('/').parse().ok()
}

fn page_url(id: u64) -> String {
    if cfg!(windows) {
        format!("http://{WINDOWS_PRINT_HOST}/{id}")
    } else {
        format!("{PRINT_SCHEME}://localhost/{id}")
    }
}

/// Open a window on the page and, once it has loaded, the system's print dialog over it. The
/// window stays until the user closes it (Gmail's print tab does the same).
pub fn open_window(
    app: &tauri::AppHandle,
    pages: Arc<PrintPages>,
    title: &str,
    html: String,
    allow_remote: bool,
) -> tauri::Result<()> {
    let id = pages.add(html, allow_remote);
    let url = page_url(id)
        .parse()
        .expect("the print URL is built from fixed parts and a number");
    let printed = AtomicBool::new(false);
    let built = tauri::WebviewWindowBuilder::new(
        app,
        format!("print-{id}"),
        tauri::WebviewUrl::CustomProtocol(url),
    )
    .title(title)
    .inner_size(820.0, 960.0)
    .on_page_load(move |window, payload| {
        // Once: a link followed from the page opens in the browser, not here.
        if payload.event() == tauri::webview::PageLoadEvent::Finished
            && !printed.swap(true, Ordering::Relaxed)
        {
            if let Err(e) = window.print() {
                tracing::warn!(error = %e, "couldn't open the print dialog");
            }
        }
    })
    .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            pages.remove(id);
            return Err(e);
        }
    };
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            pages.remove(id);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_served_by_number_with_a_policy_that_runs_no_script() {
        let pages = PrintPages::default();
        let id = pages.add("<h1>Hello</h1>".into(), true);
        let response = pages.serve(&page_url(id));
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), b"<h1>Hello</h1>");
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(csp.contains("script-src 'none'"), "{csp}");
        assert!(csp.contains("https: http:"), "{csp}");

        let held = pages.add("<p>Spam</p>".into(), false);
        let csp = pages.serve(&page_url(held)).headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(!csp.contains("https:"), "{csp}");

        pages.remove(id);
        assert_eq!(pages.serve(&page_url(id)).status(), 404);
    }

    #[test]
    fn only_our_print_urls_name_a_page() {
        assert_eq!(page_id("pheeme-print://localhost/3"), Some(3));
        assert_eq!(page_id("http://pheeme-print.localhost/3"), Some(3));
        assert_eq!(page_id("http://evil.localhost/3"), None);
        assert_eq!(page_id("pheeme-print://localhost/../etc"), None);
        assert_eq!(page_id("pheeme-att://localhost/3"), None);
    }
}
