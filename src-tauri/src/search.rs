//! Gmail search syntax → a query the local cache can answer.
//!
//! Plain words, quoted phrases and the common operators run locally against the FTS5
//! index. Anything this can't evaluate exactly (`OR`, `-term`, grouping, `filename:`, …)
//! makes the query Gmail-only: local search returns nothing for it and the Gmail results
//! stand alone, rather than showing local results that don't match what Gmail would.

use chrono::{Local, NaiveDate, TimeZone};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What the local search runs. All conditions apply to the same message, like Gmail.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalQuery {
    /// FTS5 MATCH expression; `None` when the query has no text terms.
    pub fts: Option<String>,
    /// Each entry is one `label:`/`in:`/`category:`/`is:important` value; a message needs
    /// a label matching every entry (see [`label_matches`]).
    pub labels: Vec<String>,
    /// Gmail leaves Spam and Trash out unless the query asks for them.
    pub include_spam_trash: bool,
    pub has_attachment: bool,
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    /// Unix ms: `date >= after`, `date < before`.
    pub after: Option<i64>,
    pub before: Option<i64>,
    /// Bytes: `size > larger`, `size < smaller`.
    pub larger: Option<i64>,
    pub smaller: Option<i64>,
    pub from_me: bool,
    pub to_me: bool,
}

impl LocalQuery {
    /// Nothing to search for (an empty query).
    pub fn is_empty(&self) -> bool {
        *self == LocalQuery::default()
    }
}

/// `None`: Gmail-only (see the module docs).
pub fn parse(query: &str, now_ms: i64) -> Option<LocalQuery> {
    let mut q = LocalQuery::default();
    let mut fts: Vec<String> = Vec::new();
    for token in tokenize(query)? {
        match token {
            Token::Phrase(text) => fts.extend(fts_term(None, &text, false)),
            Token::Word(word) => {
                if matches!(word.as_str(), "OR" | "AND" | "AROUND") || word.starts_with('-') {
                    return None;
                }
                let word = word.strip_prefix('+').unwrap_or(&word);
                match word.split_once(':') {
                    Some((key, value)) if !value.is_empty() && is_operator(key) => {
                        apply(&mut q, &mut fts, key, value, false, now_ms)?;
                    }
                    _ => fts.extend(fts_term(None, word, true)),
                }
            }
            Token::Operator(key, value) => {
                if !is_operator(&key) {
                    // `foo:"bar"` isn't an operator: search the words.
                    fts.extend(fts_term(None, &key, true));
                    fts.extend(fts_term(None, &value, false));
                } else {
                    apply(&mut q, &mut fts, &key, &value, true, now_ms)?;
                }
            }
        }
    }
    if !fts.is_empty() {
        q.fts = Some(fts.join(" "));
    }
    Some(q)
}

const OPERATORS: &[&str] = &[
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "label",
    "in",
    "is",
    "has",
    "category",
    "before",
    "after",
    "older",
    "newer",
    "older_than",
    "newer_than",
    "larger",
    "smaller",
    "size",
    "filename",
    "list",
    "deliveredto",
    "rfc822msgid",
];

fn is_operator(key: &str) -> bool {
    OPERATORS.contains(&key.to_ascii_lowercase().as_str())
}

/// One operator. `None` when it can't run locally.
fn apply(
    q: &mut LocalQuery,
    fts: &mut Vec<String>,
    key: &str,
    value: &str,
    quoted: bool,
    now_ms: i64,
) -> Option<()> {
    let lower = value.to_lowercase();
    match key.to_ascii_lowercase().as_str() {
        "from" if lower == "me" && !quoted => q.from_me = true,
        "to" if lower == "me" && !quoted => q.to_me = true,
        "from" => fts.extend(fts_term(Some("sender"), value, !quoted)),
        "to" => fts.extend(fts_term(Some("recipients cc"), value, !quoted)),
        "cc" if lower != "me" => fts.extend(fts_term(Some("cc"), value, !quoted)),
        "subject" => fts.extend(fts_term(Some("subject"), value, !quoted)),
        "label" => add_label(q, &lower),
        "in" => match lower.as_str() {
            "anywhere" => q.include_spam_trash = true,
            "inbox" | "sent" | "draft" | "drafts" | "trash" | "spam" | "starred" | "important"
            | "unread" => add_label(q, if lower == "drafts" { "draft" } else { &lower }),
            _ => return None,
        },
        "is" => match lower.as_str() {
            "unread" => q.unread = Some(true),
            "read" => q.unread = Some(false),
            "starred" => q.starred = Some(true),
            "important" => add_label(q, "important"),
            _ => return None,
        },
        "has" if lower == "attachment" => q.has_attachment = true,
        "category" => {
            let label = match lower.as_str() {
                "primary" | "personal" => "category_personal",
                "social" => "category_social",
                "promotions" => "category_promotions",
                "updates" => "category_updates",
                "forums" => "category_forums",
                _ => return None,
            };
            add_label(q, label);
        }
        // Quoted dates aren't rewritten for Gmail (see `gmail_query`), so leave them to it.
        "after" | "newer" | "before" | "older" if quoted => return None,
        "after" | "newer" => q.after = Some(max_opt(q.after, parse_date(value)?)),
        "before" | "older" => q.before = Some(min_opt(q.before, parse_date(value)?)),
        "newer_than" => q.after = Some(max_opt(q.after, now_ms - parse_age(&lower)?)),
        "older_than" => q.before = Some(min_opt(q.before, now_ms - parse_age(&lower)?)),
        "larger" | "size" => q.larger = Some(max_opt(q.larger, parse_size(&lower)?)),
        "smaller" => q.smaller = Some(min_opt(q.smaller, parse_size(&lower)?)),
        _ => return None,
    }
    Some(())
}

fn add_label(q: &mut LocalQuery, label: &str) {
    if matches!(label, "trash" | "spam") {
        q.include_spam_trash = true;
    }
    q.labels.push(label.to_owned());
}

fn max_opt(a: Option<i64>, b: i64) -> i64 {
    a.map_or(b, |a| a.max(b))
}

fn min_opt(a: Option<i64>, b: i64) -> i64 {
    a.map_or(b, |a| a.min(b))
}

/// The query to send Gmail, and whether it asks for Spam or Trash (Gmail's API leaves
/// them out unless told otherwise). Date literals become Unix seconds: the API reads
/// `after:2024/01/31` as Pacific time, while local search (and the user) mean local time.
pub fn gmail_query(query: &str) -> (String, bool) {
    let mut out = String::with_capacity(query.len());
    let mut spam_trash = false;
    let mut word = String::new();
    let mut quoted = false;
    let mut flush = |word: &mut String, out: &mut String| {
        // `in:"trash"` and `{in:trash in:spam}` count too; a quoted phrase doesn't.
        let operand = word.trim_start_matches(['{', '(']);
        let lower: String = operand
            .to_lowercase()
            .chars()
            .filter(|c| !matches!(c, '"' | '}' | ')'))
            .collect();
        spam_trash |= !operand.starts_with('"')
            && matches!(
                lower.as_str(),
                "in:trash" | "in:spam" | "in:anywhere" | "label:trash" | "label:spam"
            );
        let date = word.split_once(':').and_then(|(key, value)| {
            let is_date_key = matches!(
                key.to_ascii_lowercase().as_str(),
                "after" | "before" | "newer" | "older"
            );
            let is_seconds = value.bytes().all(|b| b.is_ascii_digit());
            (is_date_key && !is_seconds)
                .then(|| parse_date(value))
                .flatten()
                .map(|ms| format!("{key}:{}", ms.div_euclid(1000)))
        });
        out.push_str(date.as_deref().unwrap_or(word));
        word.clear();
    };
    for c in query.chars() {
        if c == '"' {
            quoted = !quoted;
        }
        if c.is_whitespace() && !quoted {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    (out, spam_trash)
}

/// Whether a Gmail label (`id`, `name`) is what a `label:` value names. Gmail accepts the
/// name in any case with spaces, slashes and underscores written as `-`.
pub fn label_matches(value: &str, id: &str, name: &str) -> bool {
    let norm = |s: &str| {
        s.to_lowercase()
            .chars()
            .map(|c| if matches!(c, ' ' | '/' | '_') { '-' } else { c })
            .collect::<String>()
    };
    let value = norm(value);
    value == norm(id) || value == norm(name)
}

/// An FTS5 phrase for `text`, limited to `columns` when given. `prefix` makes the last
/// word match as a prefix, so results appear while a word is still being typed. `None`
/// when `text` has nothing searchable.
fn fts_term(columns: Option<&str>, text: &str, prefix: bool) -> Option<String> {
    if !text.chars().any(char::is_alphanumeric) {
        return None;
    }
    let phrase = format!(
        "\"{}\"{}",
        text.replace('"', "\"\""),
        if prefix { "*" } else { "" }
    );
    Some(match columns {
        Some(columns) => format!("{{{columns}}} : {phrase}"),
        None => phrase,
    })
}

/// `YYYY/MM/DD`, `YYYY-MM-DD`, `MM/DD/YYYY`, or Unix seconds; midnight local time.
fn parse_date(value: &str) -> Option<i64> {
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        return value.parse::<i64>().ok()?.checked_mul(1000);
    }
    let parts: Vec<&str> = value.split(['/', '-']).collect();
    let [a, b, c] = parts.as_slice() else {
        return None;
    };
    let (y, m, d) = if a.len() == 4 { (a, b, c) } else { (c, a, b) };
    let date = NaiveDate::from_ymd_opt(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)?;
    let midnight = Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    Some(midnight.timestamp_millis())
}

/// `3d`, `2m` (months, as 30 days), `1y` → milliseconds.
fn parse_age(value: &str) -> Option<i64> {
    let (n, days) = [("d", 1), ("m", 30), ("y", 365)]
        .into_iter()
        .find_map(|(unit, days)| Some((value.strip_suffix(unit)?, days)))?;
    n.parse::<i64>().ok()?.checked_mul(days * DAY_MS)
}

/// `5000`, `10k`, `10kb`, `2m`, `2mb` → bytes.
fn parse_size(value: &str) -> Option<i64> {
    let value = value.strip_suffix('b').unwrap_or(value);
    let (n, mult) = if let Some(n) = value.strip_suffix('k') {
        (n, 1024)
    } else if let Some(n) = value.strip_suffix('m') {
        (n, 1024 * 1024)
    } else {
        (value, 1)
    };
    n.parse::<i64>().ok()?.checked_mul(mult)
}

#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    /// `key:"quoted value"`.
    Operator(String, String),
}

/// Splits on whitespace, keeping quoted phrases together. `None` for grouping (`(`, `{`)
/// or an unclosed quote, which only Gmail understands.
fn tokenize(query: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut chars = query.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '"' {
            chars.next();
            tokens.push(Token::Phrase(read_quoted(&mut chars)?));
            continue;
        }
        let mut word = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            if matches!(c, '(' | ')' | '{' | '}') {
                return None;
            }
            chars.next();
            if c == '"' {
                // `key:"value"`; a quote anywhere else is Gmail-only.
                let key = word.strip_suffix(':')?.to_owned();
                tokens.push(Token::Operator(key, read_quoted(&mut chars)?));
                word.clear();
                break;
            }
            word.push(c);
        }
        if !word.is_empty() {
            tokens.push(Token::Word(word));
        }
    }
    Some(tokens)
}

fn read_quoted(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<String> {
    let mut text = String::new();
    for c in chars.by_ref() {
        if c == '"' {
            return Some(text);
        }
        text.push(c);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn local(q: &str) -> LocalQuery {
        parse(q, NOW).unwrap_or_else(|| panic!("{q} should run locally"))
    }

    #[test]
    fn words_and_phrases_become_fts() {
        assert_eq!(
            local("quarterly \"board meeting\" ré").fts.as_deref(),
            Some(r#""quarterly"* "board meeting" "ré"*"#)
        );
        assert_eq!(local(r#"say"#).fts.as_deref(), Some(r#""say"*"#));
        assert!(local("   ").is_empty());
        assert_eq!(local("@ + ").fts, None, "nothing searchable is dropped");
    }

    #[test]
    fn address_and_subject_operators_scope_columns() {
        assert_eq!(
            local("from:alice@example.com to:bob subject:\"q3 plan\" cc:carol")
                .fts
                .as_deref(),
            Some(
                r#"{sender} : "alice@example.com"* {recipients cc} : "bob"* {subject} : "q3 plan" {cc} : "carol"*"#
            )
        );
        let me = local("from:me to:me");
        assert!(me.from_me && me.to_me && me.fts.is_none());
        assert_eq!(
            local(r#"subject:"say ""hi""#).fts.as_deref(),
            Some(r#"{subject} : "say " "hi""#),
            "quotes inside a value close it, like Gmail"
        );
    }

    #[test]
    fn flag_and_label_operators() {
        let q = local(
            "is:unread is:starred has:attachment label:Work/Projects in:inbox category:social",
        );
        assert_eq!(q.unread, Some(true));
        assert_eq!(q.starred, Some(true));
        assert!(q.has_attachment);
        assert_eq!(q.labels, ["work/projects", "inbox", "category_social"]);
        assert!(!q.include_spam_trash);
        assert!(local("in:trash").include_spam_trash);
        assert!(local("in:anywhere foo").include_spam_trash);
        assert_eq!(local("is:read").unread, Some(false));
    }

    #[test]
    fn dates_and_sizes() {
        let q = local("after:2024/01/31 before:2024-02-02 larger:2M smaller:10kb");
        let jan31 = Local
            .with_ymd_and_hms(2024, 1, 31, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let feb2 = Local
            .with_ymd_and_hms(2024, 2, 2, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!((q.after, q.before), (Some(jan31), Some(feb2)));
        assert_eq!(
            (q.larger, q.smaller),
            (Some(2 * 1024 * 1024), Some(10 * 1024))
        );
        assert_eq!(local("after:1700000000").after, Some(1_700_000_000_000));
        assert_eq!(local("after:01/31/2024").after, Some(jan31));
        assert_eq!(local("newer_than:2d").after, Some(NOW - 2 * DAY_MS));
        assert_eq!(local("older_than:1y").before, Some(NOW - 365 * DAY_MS));
        assert_eq!(local("larger:5000").larger, Some(5000));
    }

    #[test]
    fn gmail_only_syntax_is_left_to_gmail() {
        for q in [
            "a OR b",
            "-spam",
            "from:(a b)",
            "{a b}",
            "filename:pdf",
            "has:drive",
            "is:snoozed",
            "in:chats",
            "bcc:x",
            "cc:me",
            "after:yesterday",
            "larger:big",
            "\"unclosed",
            "list:foo",
        ] {
            assert_eq!(parse(q, NOW), None, "{q}");
        }
    }

    #[test]
    fn non_operator_colons_are_text() {
        assert_eq!(local("re:meeting").fts.as_deref(), Some(r#""re:meeting"*"#));
        assert_eq!(local("10:30").fts.as_deref(), Some(r#""10:30"*"#));
        assert_eq!(local("from:").fts.as_deref(), Some(r#""from:"*"#));
    }

    #[test]
    fn gmail_query_pins_dates_and_asks_for_spam_trash() {
        let jan31 = Local
            .with_ymd_and_hms(2024, 1, 31, 0, 0, 0)
            .unwrap()
            .timestamp();
        assert_eq!(
            gmail_query("invoice  after:2024/01/31 before:1700000000 subject:\"after:2024/01/31\""),
            (
                format!("invoice  after:{jan31} before:1700000000 subject:\"after:2024/01/31\""),
                false
            )
        );
        assert!(gmail_query("x In:Trash").1);
        assert!(gmail_query("in:anywhere").1);
        assert!(gmail_query("in:\"trash\"").1);
        assert!(gmail_query("{in:trash in:spam} x").1);
        assert_eq!(
            parse("after:\"2024/01/31\"", NOW),
            None,
            "quoted dates are Gmail-only"
        );
        assert!(!gmail_query("-in:trash \"in:spam\"").1);
        assert_eq!(
            parse("older_than:é", NOW),
            None,
            "no panic on a non-ASCII unit"
        );
    }

    #[test]
    fn label_names_match_like_gmail() {
        assert!(label_matches("work-projects", "Label_7", "Work/Projects"));
        assert!(label_matches("my-label", "Label_1", "My Label"));
        assert!(label_matches("inbox", "INBOX", "INBOX"));
        assert!(label_matches(
            "category_social",
            "CATEGORY_SOCIAL",
            "CATEGORY_SOCIAL"
        ));
        assert!(!label_matches("work", "Label_7", "Work/Projects"));
    }
}
