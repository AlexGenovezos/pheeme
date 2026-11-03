//! Reply, Reply All and Forward: who it goes to, the subject, the threading headers and
//! the quoted original, the way Gmail does them.

use super::build::text_to_html;
use super::{ComposeDraft, ComposeMode};
use crate::gmail::mime::EmailAddress;
use chrono::TimeZone;
use std::collections::HashSet;

/// What a reply or forward needs from the original message.
#[derive(Debug, Clone, Default)]
pub struct Original {
    pub thread_id: String,
    pub from: Option<EmailAddress>,
    pub reply_to: Vec<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub subject: Option<String>,
    /// Milliseconds since the epoch.
    pub date: Option<i64>,
    /// `Message-ID`, with angle brackets.
    pub message_id: Option<String>,
    pub references: Vec<String>,
    /// Raw (unsanitized) HTML body.
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: Option<String>,
}

fn is(a: &EmailAddress, address: &str) -> bool {
    a.address.trim().eq_ignore_ascii_case(address.trim())
}

/// Drop `exclude`d addresses and repeats (first one wins), keeping order.
fn distinct(list: Vec<EmailAddress>, exclude: &[&EmailAddress]) -> Vec<EmailAddress> {
    let mut seen: HashSet<String> = exclude
        .iter()
        .map(|a| a.address.trim().to_ascii_lowercase())
        .collect();
    list.into_iter()
        .filter(|a| !a.address.trim().is_empty())
        .filter(|a| seen.insert(a.address.trim().to_ascii_lowercase()))
        .collect()
}

fn prefixed(subject: Option<&str>, prefix: &str, already: &[&str]) -> String {
    let subject = subject.unwrap_or("").trim();
    let lower = subject.to_ascii_lowercase();
    if already.iter().any(|p| lower.starts_with(p)) {
        subject.to_owned()
    } else if subject.is_empty() {
        prefix.trim_end().to_owned()
    } else {
        format!("{prefix}{subject}")
    }
}

pub fn template<Tz>(mode: ComposeMode, original: &Original, me: &str, tz: &Tz) -> ComposeDraft
where
    Tz: TimeZone,
    Tz::Offset: std::fmt::Display,
{
    let me_addr = EmailAddress {
        name: None,
        address: me.to_owned(),
    };
    let sent_by_me = original.from.as_ref().is_some_and(|f| is(f, me));
    let sender: Vec<EmailAddress> = if !original.reply_to.is_empty() {
        original.reply_to.clone()
    } else {
        original.from.iter().cloned().collect()
    };

    let (to, cc) = match mode {
        ComposeMode::Forward => (Vec::new(), Vec::new()),
        // Replying to your own message continues the conversation with its recipients.
        ComposeMode::Reply if sent_by_me => (distinct(original.to.clone(), &[]), Vec::new()),
        ComposeMode::Reply => (distinct(sender, &[]), Vec::new()),
        ComposeMode::ReplyAll => {
            let to = if sent_by_me {
                original.to.clone()
            } else {
                sender.into_iter().chain(original.to.clone()).collect()
            };
            let to = distinct(to, &[&me_addr]);
            let cc = distinct(
                original.cc.clone(),
                &to.iter().chain([&me_addr]).collect::<Vec<_>>(),
            );
            if to.is_empty() && cc.is_empty() {
                // Only you were on it.
                (vec![me_addr.clone()], Vec::new())
            } else {
                (to, cc)
            }
        }
    };

    let subject = match mode {
        ComposeMode::Forward => prefixed(original.subject.as_deref(), "Fwd: ", &["fwd:", "fw:"]),
        _ => prefixed(original.subject.as_deref(), "Re: ", &["re:"]),
    };

    let mut references: Vec<String> = Vec::new();
    for id in original.references.iter().chain(&original.message_id) {
        if !references.contains(id) {
            references.push(id.clone());
        }
    }

    ComposeDraft {
        to,
        cc,
        subject,
        quote_html: Some(match mode {
            ComposeMode::Forward => forward_quote(original, tz),
            _ => reply_quote(original, tz),
        }),
        in_reply_to: original.message_id.clone(),
        references,
        thread_id: Some(original.thread_id.clone()),
        ..Default::default()
    }
}

fn display(a: &EmailAddress) -> String {
    match a.name.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(name) => format!("{name} <{}>", a.address),
        None => a.address.clone(),
    }
}

fn date_text<Tz>(ms: Option<i64>, tz: &Tz) -> Option<String>
where
    Tz: TimeZone,
    Tz::Offset: std::fmt::Display,
{
    let at = tz.timestamp_millis_opt(ms?).single()?;
    Some(at.format("%a, %b %-d, %Y at %-I:%M %p").to_string())
}

/// The original body, safe to put in an outgoing message.
fn original_body(original: &Original) -> String {
    if let Some(html) = original
        .body_html
        .as_deref()
        .filter(|h| !h.trim().is_empty())
    {
        return clean_html(html);
    }
    let text = original
        .body_text
        .as_deref()
        .or(original.snippet.as_deref())
        .unwrap_or("");
    text_to_html(text)
}

/// Scripts, handlers and external stylesheets go; inline styles, images (also `cid:`) stay.
fn clean_html(html: &str) -> String {
    ammonia::Builder::default()
        .add_tags(["center", "font"])
        .add_generic_attributes([
            "style",
            "class",
            "align",
            "valign",
            "bgcolor",
            "width",
            "height",
            "border",
            "cellpadding",
            "cellspacing",
            "color",
            "face",
            "size",
            "dir",
        ])
        .add_clean_content_tags(["title"])
        .url_schemes(std::collections::HashSet::from([
            "http", "https", "mailto", "cid",
        ]))
        .link_rel(Some("noopener noreferrer"))
        .clean(html)
        .to_string()
}

const QUOTE_STYLE: &str =
    "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

fn reply_quote<Tz>(original: &Original, tz: &Tz) -> String
where
    Tz: TimeZone,
    Tz::Offset: std::fmt::Display,
{
    let who = original
        .from
        .as_ref()
        .map(display)
        .unwrap_or_else(|| "someone".into());
    let attribution = match date_text(original.date, tz) {
        Some(date) => format!("On {date}, {who} wrote:"),
        None => format!("{who} wrote:"),
    };
    format!(
        "<div class=\"gmail_quote\"><div dir=\"ltr\" class=\"gmail_attr\">{}<br></div>\
         <blockquote class=\"gmail_quote\" style=\"{QUOTE_STYLE}\">{}</blockquote></div>",
        text_to_html(&attribution),
        original_body(original)
    )
}

fn forward_quote<Tz>(original: &Original, tz: &Tz) -> String
where
    Tz: TimeZone,
    Tz::Offset: std::fmt::Display,
{
    let list = |l: &[EmailAddress]| l.iter().map(display).collect::<Vec<_>>().join(", ");
    let mut lines = vec!["---------- Forwarded message ---------".to_owned()];
    if let Some(from) = &original.from {
        lines.push(format!("From: {}", display(from)));
    }
    if let Some(date) = date_text(original.date, tz) {
        lines.push(format!("Date: {date}"));
    }
    lines.push(format!(
        "Subject: {}",
        original.subject.as_deref().unwrap_or("")
    ));
    if !original.to.is_empty() {
        lines.push(format!("To: {}", list(&original.to)));
    }
    if !original.cc.is_empty() {
        lines.push(format!("Cc: {}", list(&original.cc)));
    }
    let header: Vec<String> = lines.iter().map(|l| text_to_html(l)).collect();
    format!(
        "<div class=\"gmail_quote\"><div dir=\"ltr\" class=\"gmail_attr\">{}<br></div><br>{}</div>",
        header.join("<br>"),
        original_body(original)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const ME: &str = "me@example.com";

    fn a(address: &str) -> EmailAddress {
        EmailAddress {
            name: None,
            address: address.into(),
        }
    }

    fn named(name: &str, address: &str) -> EmailAddress {
        EmailAddress {
            name: Some(name.into()),
            address: address.into(),
        }
    }

    fn original() -> Original {
        Original {
            thread_id: "t1".into(),
            from: Some(named("Bo", "bo@example.com")),
            to: vec![a("ME@example.com"), a("ann@example.com")],
            cc: vec![
                a("cy@example.com"),
                a("ann@example.com"),
                a("me@example.com"),
            ],
            subject: Some("Plans".into()),
            date: Some(1_800_000_000_000),
            message_id: Some("<m2@x>".into()),
            references: vec!["<m1@x>".into()],
            body_html: Some(
                "<p onclick=\"x()\">Hello <img src=\"cid:logo\"></p><script>bad()</script>".into(),
            ),
            ..Default::default()
        }
    }

    fn t(mode: ComposeMode, o: &Original) -> ComposeDraft {
        template(mode, o, ME, &Utc)
    }

    fn addresses(list: &[EmailAddress]) -> Vec<&str> {
        list.iter().map(|a| a.address.as_str()).collect()
    }

    #[test]
    fn reply_goes_to_the_sender_in_the_same_thread() {
        let d = t(ComposeMode::Reply, &original());
        assert_eq!(addresses(&d.to), ["bo@example.com"]);
        assert!(d.cc.is_empty());
        assert_eq!(d.subject, "Re: Plans");
        assert_eq!(d.in_reply_to.as_deref(), Some("<m2@x>"));
        assert_eq!(d.references, ["<m1@x>", "<m2@x>"]);
        assert_eq!(d.thread_id.as_deref(), Some("t1"));
        let quote = d.quote_html.unwrap();
        assert!(
            quote.contains("On Fri, Jan 15, 2027 at 8:00 AM, Bo &lt;bo@example.com&gt; wrote:"),
            "{quote}"
        );
        assert!(quote.contains("<img src=\"cid:logo\">"));
        assert!(!quote.contains("script") && !quote.contains("onclick"));
    }

    #[test]
    fn reply_honours_reply_to() {
        let mut o = original();
        o.reply_to = vec![a("list@example.com")];
        assert_eq!(
            addresses(&t(ComposeMode::Reply, &o).to),
            ["list@example.com"]
        );
    }

    #[test]
    fn reply_all_keeps_everyone_but_me_once() {
        let d = t(ComposeMode::ReplyAll, &original());
        assert_eq!(addresses(&d.to), ["bo@example.com", "ann@example.com"]);
        assert_eq!(addresses(&d.cc), ["cy@example.com"]);
    }

    #[test]
    fn replying_to_my_own_message_addresses_its_recipients() {
        let mut o = original();
        o.from = Some(a("Me@Example.com"));
        o.to = vec![a("ann@example.com")];
        assert_eq!(
            addresses(&t(ComposeMode::Reply, &o).to),
            ["ann@example.com"]
        );
        let all = t(ComposeMode::ReplyAll, &o);
        assert_eq!(addresses(&all.to), ["ann@example.com"]);
        assert_eq!(addresses(&all.cc), ["cy@example.com"]);

        o.to = vec![a("me@example.com")];
        o.cc = Vec::new();
        assert_eq!(
            addresses(&t(ComposeMode::ReplyAll, &o).to),
            ["me@example.com"],
            "a note to self still has a recipient"
        );
    }

    #[test]
    fn subjects_are_prefixed_once() {
        let mut o = original();
        o.subject = Some("RE: Plans".into());
        assert_eq!(t(ComposeMode::Reply, &o).subject, "RE: Plans");
        assert_eq!(t(ComposeMode::Forward, &o).subject, "Fwd: RE: Plans");
        o.subject = Some("Fw: Plans".into());
        assert_eq!(t(ComposeMode::Forward, &o).subject, "Fw: Plans");
        o.subject = None;
        assert_eq!(t(ComposeMode::Reply, &o).subject, "Re:");
    }

    #[test]
    fn forward_has_no_recipients_and_a_header_block() {
        let mut o = original();
        o.body_html = None;
        o.body_text = Some("Line 1\n<Line 2>".into());
        let d = t(ComposeMode::Forward, &o);
        assert!(d.to.is_empty() && d.cc.is_empty());
        assert_eq!(d.subject, "Fwd: Plans");
        let quote = d.quote_html.unwrap();
        assert!(quote.contains("---------- Forwarded message ---------<br>From: Bo &lt;bo@example.com&gt;<br>Date: Fri, Jan 15, 2027 at 8:00 AM<br>Subject: Plans<br>To: ME@example.com, ann@example.com<br>Cc: cy@example.com, ann@example.com, me@example.com"), "{quote}");
        assert!(quote.contains("Line 1<br>&lt;Line 2&gt;"));
    }
}
