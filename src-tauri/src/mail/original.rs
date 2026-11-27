//! Show original: a message's whole RFC 2822 source from Gmail (`format=raw`, never cached),
//! the summary Gmail's own "Show original" page opens with (Message ID, Created at, From, To,
//! Subject and the SPF, DKIM and DMARC results from `Authentication-Results`), and saving the
//! source as an `.eml` file.

use super::attachment::{cap_bytes, openable_file_name_or, write_unique, MAX_NAME_BYTES};
use super::{MailError, MailService};
use crate::sync::engine::SyncError;
use mailparse::{dateparse, parse_headers, MailHeaderMap};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The most source text sent to the window. A message with big attachments is megabytes of
/// base64; the window shows the start, and Download original saves all of it.
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;

/// The checks the summary reports, in the order Gmail lists them.
const AUTH_METHODS: [&str; 3] = ["spf", "dkim", "dmarc"];

/// One result from the topmost `Authentication-Results` header (the one Gmail itself added).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthResult {
    /// `spf`, `dkim` or `dmarc`.
    pub method: String,
    /// Lowercase: `pass`, `fail`, `softfail`, `neutral`, `none`, …
    pub result: String,
    /// What the header says after the result (the explaining comment and properties).
    pub detail: Option<String>,
}

/// The header summary of a raw message, every value decoded (RFC 2047) and unfolded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSummary {
    /// The `Message-ID` header, brackets included.
    pub message_id: Option<String>,
    /// The `Date` header in milliseconds since the epoch.
    pub created_at: Option<i64>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub auth: Vec<AuthResult>,
}

/// What Show original hands to the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalDto {
    #[serde(flatten)]
    pub summary: OriginalSummary,
    /// The source as text (bytes that aren't UTF-8 show as �), cut at [`MAX_SOURCE_BYTES`].
    pub source: String,
    /// The source is longer than `source`.
    pub truncated: bool,
}

/// Splits `s` at the `;`s outside comments and quoted strings (a result's comment or value
/// may hold one), honouring backslash escapes in both (RFC 8601, RFC 5322 quoted-pair).
fn split_semicolons(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut quoted, mut escaped, mut start) = (0usize, false, false, 0);
    for (i, c) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if quoted || depth > 0 => escaped = true,
            '"' if depth == 0 => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth = depth.saturating_sub(1),
            ';' if depth == 0 && !quoted => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

/// The server that added an `Authentication-Results` header: its authserv-id, when the
/// segment is that id with nothing after it but comments and an optional numeric version.
fn authserv_id(segment: &str) -> Option<String> {
    // Comments become spaces, so the text around one can't join into another name.
    let (mut depth, mut escaped, mut text) = (0usize, false, String::new());
    for c in segment.chars() {
        if escaped {
            escaped = false;
        } else if c == '\\' && depth > 0 {
            escaped = true;
        } else if c == '(' {
            depth += 1;
            text.push(' ');
        } else if c == ')' && depth > 0 {
            depth -= 1;
        } else if depth == 0 {
            text.push(c);
        }
    }
    if depth > 0 {
        return None;
    }
    let mut words = text.split_whitespace();
    let id = words.next()?.to_ascii_lowercase();
    let version = words.next();
    let valid =
        words.next().is_none() && version.is_none_or(|v| v.bytes().all(|b| b.is_ascii_digit()));
    valid.then_some(id)
}

/// The server whose `Authentication-Results` the summary shows: Gmail's own. A header any
/// other server added (or the sender forged, on mail Gmail didn't receive itself) is ignored.
const GMAIL_AUTHSERV_ID: &str = "mx.google.com";

/// The SPF, DKIM and DMARC results of one `Authentication-Results` value
/// (`mx.google.com; dkim=pass header.i=@a.com; spf=pass (…) smtp.mailfrom=a.com`, RFC 8601),
/// or none when Gmail didn't add it.
fn auth_results(value: &str) -> Vec<AuthResult> {
    let segments = split_semicolons(value);
    if authserv_id(segments[0]).as_deref() != Some(GMAIL_AUTHSERV_ID) {
        return Vec::new();
    }
    segments
        .into_iter()
        .skip(1)
        .filter_map(|segment| {
            let segment = segment.trim();
            let (method, rest) = segment.split_once('=')?;
            let method = method.trim().to_ascii_lowercase();
            if !AUTH_METHODS.contains(&method.as_str()) {
                return None;
            }
            let rest = rest.trim();
            let (result, detail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            if result.is_empty() {
                return None;
            }
            let detail = detail.trim();
            Some(AuthResult {
                method,
                result: result.to_ascii_lowercase(),
                detail: (!detail.is_empty()).then(|| detail.to_owned()),
            })
        })
        .collect()
}

/// The summary of `raw`'s headers. Never fails: what isn't there is `None` or empty.
pub fn summarize(raw: &[u8]) -> OriginalSummary {
    let Ok((headers, _)) = parse_headers(raw) else {
        return OriginalSummary::default();
    };
    let first = |name: &str| {
        headers
            .get_first_value(name)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    OriginalSummary {
        message_id: first("Message-ID"),
        created_at: first("Date")
            .and_then(|d| dateparse(&d).ok())
            // A date it can't read comes back as 0, which is no date.
            .filter(|s| *s > 0)
            .map(|s| s.saturating_mul(1000)),
        from: first("From"),
        to: first("To"),
        subject: first("Subject"),
        // A forwarder's or sender's own header sits below Gmail's; only the first is Gmail's word.
        auth: headers
            .get_all_values("Authentication-Results")
            .first()
            .map(|v| auth_results(v))
            .unwrap_or_default(),
    }
}

/// `raw` as the text the window shows, and whether it was cut (never when `full`: Copy to
/// clipboard asks for all of it).
fn source_text(raw: &[u8], full: bool) -> (String, bool) {
    if full || raw.len() <= MAX_SOURCE_BYTES {
        return (String::from_utf8_lossy(raw).into_owned(), false);
    }
    // Cut inside the bytes, so a cut through a character becomes one �, not a panic.
    let mut text = String::from_utf8_lossy(&raw[..MAX_SOURCE_BYTES]).into_owned();
    if text.ends_with('\u{FFFD}') {
        text.pop();
    }
    (text, true)
}

/// The file Download original writes: the subject (made safe on every platform) and `.eml`.
fn eml_name(subject: Option<&str>) -> String {
    // A subject that cleans to nothing ("...", "/") is still a message, not an attachment.
    let stem = openable_file_name_or(subject, "message");
    let stem = cap_bytes(&stem, MAX_NAME_BYTES - ".eml".len()).trim_end_matches(['.', ' ']);
    format!("{stem}.eml")
}

impl MailService {
    /// The message's source and header summary, fetched from Gmail (nothing is cached), the
    /// source cut at [`MAX_SOURCE_BYTES`] unless `full`. Run it inside
    /// [`crate::gmail::user_action`].
    pub async fn original(
        &self,
        account_id: &str,
        message_id: &str,
        full: bool,
    ) -> Result<OriginalDto, MailError> {
        let raw = self.raw_source(account_id, message_id).await?;
        let (source, truncated) = source_text(&raw, full);
        Ok(OriginalDto {
            summary: summarize(&raw),
            source,
            truncated,
        })
    }

    /// Writes the message's whole source into `dir` as `Subject.eml` (collision-free) and
    /// returns the path. Run it inside [`crate::gmail::user_action`].
    pub async fn save_original(
        &self,
        account_id: &str,
        message_id: &str,
        dir: &Path,
    ) -> Result<PathBuf, MailError> {
        let raw = self.raw_source(account_id, message_id).await?;
        write_unique(dir, &eml_name(summarize(&raw).subject.as_deref()), &raw).await
    }

    async fn raw_source(&self, account_id: &str, message_id: &str) -> Result<Vec<u8>, MailError> {
        self.sync
            .api(account_id)
            .message_raw(message_id)
            .await
            .map_err(|e| MailError::Sync(SyncError::from(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "Delivered-To: me@gmail.com\r\n\
Authentication-Results: mx.google.com;\r\n\
\x20\x20\x20dkim=pass header.i=@example.com header.s=sel header.b=abc123;\r\n\
\x20\x20\x20spf=pass (google.com: domain of bob@example.com designates 203.0.113.9 as permitted sender) smtp.mailfrom=bob@example.com;\r\n\
\x20\x20\x20dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=example.com\r\n\
Authentication-Results: other.example; spf=fail\r\n\
Message-ID: <abc@mail.example.com>\r\n\
Date: Tue, 24 Nov 2026 15:17:00 +0000\r\n\
From: =?UTF-8?Q?Bob_M=C3=BCller?= <bob@example.com>\r\n\
To: me@gmail.com,\r\n Ann <ann@example.org>\r\n\
Subject: =?UTF-8?B?Q2Fmw6k=?= menu\r\n\
\r\n\
Hello\r\n";

    #[test]
    fn summary_decodes_and_unfolds_the_headers() {
        let s = summarize(RAW.as_bytes());
        assert_eq!(s.message_id.as_deref(), Some("<abc@mail.example.com>"));
        assert_eq!(s.created_at, Some(1_795_533_420_000));
        assert_eq!(s.from.as_deref(), Some("Bob Müller <bob@example.com>"));
        assert_eq!(s.to.as_deref(), Some("me@gmail.com, Ann <ann@example.org>"));
        assert_eq!(s.subject.as_deref(), Some("Café menu"));
    }

    #[test]
    fn auth_results_come_from_the_topmost_header_only() {
        let auth = summarize(RAW.as_bytes()).auth;
        let shown: Vec<_> = auth.iter().map(|a| (&*a.method, &*a.result)).collect();
        assert_eq!(
            shown,
            [("dkim", "pass"), ("spf", "pass"), ("dmarc", "fail")]
        );
        assert_eq!(
            auth[1].detail.as_deref(),
            Some("(google.com: domain of bob@example.com designates 203.0.113.9 as permitted sender) smtp.mailfrom=bob@example.com")
        );
        assert_eq!(
            auth[0].detail.as_deref(),
            Some("header.i=@example.com header.s=sel header.b=abc123")
        );
    }

    #[test]
    fn a_semicolon_inside_a_comment_does_not_split_a_result() {
        let r = auth_results(
            "mx.google.com; spf=softfail (a; b) smtp.mailfrom=x; auth=pass; dkim=none",
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].result, "softfail");
        assert_eq!(r[0].detail.as_deref(), Some("(a; b) smtp.mailfrom=x"));
        assert_eq!(
            (&*r[1].method, &*r[1].result, &r[1].detail),
            ("dkim", "none", &None)
        );
    }

    #[test]
    fn quoted_strings_and_escapes_do_not_split_or_forge_results() {
        let r = auth_results(
            r#"mx.google.com; spf=pass smtp.mailfrom="a;dkim=pass"; dmarc=fail (x \) ; dkim=pass) header.from=x"#,
        );
        let shown: Vec<_> = r.iter().map(|a| (&*a.method, &*a.result)).collect();
        assert_eq!(shown, [("spf", "pass"), ("dmarc", "fail")]);
    }

    #[test]
    fn only_gmails_own_header_is_believed() {
        for id in [
            "mx.google.com",
            "MX.Google.com 1",
            "mx.google.com (Google Transport Security)",
            " (relay) mx.google.com",
        ] {
            assert_eq!(auth_results(&format!("{id}; spf=pass")).len(), 1, "{id}");
        }
        for id in [
            "evil.example",
            "mx.google.com.evil.example",
            "",
            "(mx.google.com)",
            "mx.google(x).com",
            "mx.google.com evil",
            "mx.google.com 1 2",
            "mx.google.com (open",
        ] {
            assert!(auth_results(&format!("{id}; spf=pass")).is_empty(), "{id}");
        }
        // A sender's forged header on mail Gmail didn't receive (an import) shows nothing.
        let forged = b"Authentication-Results: spoof.example; spf=pass; dkim=pass\r\n\r\nHi";
        assert_eq!(summarize(forged).auth, []);
    }

    #[test]
    fn missing_headers_are_none_and_garbage_does_not_fail() {
        assert_eq!(summarize(b"Subject: x\r\n\r\nbody").auth, []);
        assert_eq!(summarize(b"Subject: x\r\n\r\nbody").created_at, None);
        assert_eq!(summarize(b""), OriginalSummary::default());
        assert_eq!(summarize(b"Date: not a date\r\n\r\n").created_at, None);
    }

    #[test]
    fn long_sources_are_cut_on_a_character() {
        let (text, cut) = source_text(b"short", false);
        assert_eq!((text.as_str(), cut), ("short", false));
        // A 3-byte character straddling the limit.
        let mut raw = vec![b'a'; MAX_SOURCE_BYTES - 1];
        raw.extend("€".as_bytes());
        let (text, cut) = source_text(&raw, false);
        assert!(cut);
        assert_eq!(text.len(), MAX_SOURCE_BYTES - 1);
        assert!(!text.contains('\u{FFFD}'));
        // Copy asks for all of it.
        let (all, cut) = source_text(&raw, true);
        assert!(!cut);
        assert_eq!(all.len(), raw.len());
    }

    #[test]
    fn the_file_is_named_for_the_subject() {
        assert_eq!(eml_name(Some("Café menu")), "Café menu.eml");
        assert_eq!(eml_name(Some("a/b: c")), "b c.eml");
        // Characters Windows refuses in a file name.
        assert_eq!(eml_name(Some("Can we meet?")), "Can we meet_.eml");
        assert_eq!(eml_name(None), "message.eml");
        assert_eq!(eml_name(Some("  ")), "message.eml");
        assert_eq!(eml_name(Some("...")), "message.eml");
        assert_eq!(eml_name(Some("/")), "message.eml");
        assert_eq!(eml_name(Some("CON")), "_CON.eml");
        for long in ["x".repeat(500), "報".repeat(300), "😀".repeat(300)] {
            let name = eml_name(Some(&long));
            assert!(name.len() <= 255, "{}", name.len());
            assert!(name.ends_with(".eml"));
        }
    }
}
