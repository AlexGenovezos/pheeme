//! Redacting log text before it leaves the machine.

use regex::{Captures, Regex};
use std::borrow::Cow;
use std::path::Path;
use std::sync::LazyLock;

/// An http(s) URL's query string (search terms, ids).
static URL_QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(https?://[^\s?#"'<>]+)\?[^\s"'<>]*"#).unwrap());
/// A Gmail search outside a URL, up to the next space or parameter.
static SEARCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bq=[^\s&]*").unwrap());
/// An email address, plain or percent-encoded (`bob%40x.com`).
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
        .unwrap()
});

/// `text` with email addresses other than `own_addresses` replaced by `<email>`, the query
/// strings of http(s) URLs by `?<redacted>`, `q=` values by `q=<redacted>`, and the `home`
/// directory prefix by `~`.
pub fn scrub(text: &str, own_addresses: &[String], home: Option<&Path>) -> String {
    let text = URL_QUERY.replace_all(text, "$1?<redacted>");
    let text = SEARCH.replace_all(&text, "q=<redacted>");
    let text = EMAIL.replace_all(&text, |c: &Captures| {
        let found = &c[0];
        if own_addresses
            .iter()
            .any(|own| own.eq_ignore_ascii_case(found))
        {
            found.to_owned()
        } else {
            "<email>".to_owned()
        }
    });
    match home.map(|h| h.to_string_lossy()) {
        // A bare root would turn every path into `~`.
        Some(home) if home.len() > 1 => {
            // Debug-formatted Windows paths double their backslashes.
            let escaped = home.replace('\\', "\\\\");
            text.replace(home.as_ref(), "~").replace(&escaped, "~")
        }
        _ => text.into_owned(),
    }
}

/// `path` for the log, with the home directory shown as `~` (it holds the user's name).
pub fn display_path(path: &Path) -> Cow<'_, str> {
    let home = std::env::home_dir();
    match home
        .as_deref()
        .and_then(|home| path.strip_prefix(home).ok())
    {
        Some(rest) => Cow::Owned(Path::new("~").join(rest).to_string_lossy().into_owned()),
        None => path.to_string_lossy(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_redacts_correspondents_search_terms_and_home() {
        let text = "GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Abob%40x.com failed\n\
                    from bob@x.com to Me@Gmail.com\n\
                    search q=from:carol@y.org&pageToken=1 done\n\
                    /home/jane/.local/share/app.pheeme.desktop/db.sqlite\n";
        let out = scrub(
            text,
            &["me@gmail.com".to_owned()],
            Some(Path::new("/home/jane")),
        );
        for gone in ["bob@x.com", "bob%40x.com", "from%3A", "carol", "/home/jane"] {
            assert!(!out.contains(gone), "{gone} survived: {out}");
        }
        assert!(out.contains("Me@Gmail.com"), "{out}");
        assert!(out.contains("~/.local/share"), "{out}");
        assert!(
            out.contains(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages?<redacted> failed"
            ),
            "{out}"
        );
        assert!(out.contains("from <email> to"), "{out}");
        assert!(out.contains("q=<redacted>&pageToken=1"), "{out}");
    }

    #[test]
    fn display_path_hides_the_home_directory() {
        let Some(home) = std::env::home_dir() else {
            return;
        };
        let path = home.join("data").join("db.sqlite");
        let shown = display_path(&path);
        assert!(shown.starts_with('~'), "{shown}");
        assert!(!shown.contains(home.to_string_lossy().as_ref()), "{shown}");
        assert_eq!(display_path(Path::new("/elsewhere/x")), "/elsewhere/x");
    }

    #[test]
    fn scrub_leaves_ordinary_lines_alone() {
        let line = "2026-11-06T10:00:00Z INFO pheeme_lib::mail: thread opened source=\"gmail\" total_ms=38200 retries=3 seq=4";
        assert_eq!(scrub(line, &[], None), line);
    }
}
