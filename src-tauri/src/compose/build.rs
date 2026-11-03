//! Outgoing RFC 2822 messages, built with `lettre` (builder only; Gmail does the transport).
//!
//! Layout: `multipart/alternative` (plain text derived from the HTML, then the HTML) on its
//! own, or wrapped in `multipart/mixed` with the attachments after it. Bcc stays in the
//! headers because the Gmail API reads recipients from them (and strips it on delivery).

use super::{ComposeDraft, StagedAttachment, MAX_ATTACHMENT_BYTES};
use crate::gmail::mime::EmailAddress;
use crate::mail::MailError;
use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};
use lettre::{Address, Message};
use std::time::SystemTime;

pub struct Outgoing<'a> {
    pub from: &'a EmailAddress,
    pub draft: &'a ComposeDraft,
    /// The draft's attachments with their bytes, in order.
    pub attachments: &'a [(StagedAttachment, Vec<u8>)],
    /// With angle brackets.
    pub message_id: &'a str,
    pub date: SystemTime,
}

fn mailbox(a: &EmailAddress) -> Result<Mailbox, MailError> {
    let address: Address =
        a.address.trim().parse().map_err(|_| {
            MailError::Invalid(format!("\"{}\" isn't an email address.", a.address))
        })?;
    let name = a
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    Ok(Mailbox::new(name, address))
}

/// The HTML that goes out: the editor's body, then the quoted original if there is one.
pub fn full_html(draft: &ComposeDraft) -> String {
    match draft.quote_html.as_deref().filter(|q| !q.trim().is_empty()) {
        Some(quote) => format!("{}<br>{}", draft.body_html, quote),
        None => draft.body_html.clone(),
    }
}

pub fn build_message(out: &Outgoing<'_>) -> Result<Vec<u8>, MailError> {
    let draft = out.draft;
    let total: u64 = out.attachments.iter().map(|(_, b)| b.len() as u64).sum();
    if total > MAX_ATTACHMENT_BYTES {
        return Err(MailError::Invalid(
            "Attachments can add up to 25 MB at most.".into(),
        ));
    }
    let from = mailbox(out.from)?;
    let mut builder = Message::builder()
        .from(from.clone())
        .subject(draft.subject.trim())
        .date(out.date)
        .message_id(Some(out.message_id.to_owned()))
        .user_agent(concat!("Pheeme/", env!("CARGO_PKG_VERSION")).to_owned())
        // The envelope isn't used (Gmail reads the headers); set it so drafts may have no
        // recipients yet.
        .envelope(
            lettre::address::Envelope::new(Some(from.email.clone()), vec![from.email.clone()])
                .expect("an envelope with one recipient is valid"),
        )
        .keep_bcc();
    for a in &draft.to {
        builder = builder.to(mailbox(a)?);
    }
    for a in &draft.cc {
        builder = builder.cc(mailbox(a)?);
    }
    for a in &draft.bcc {
        builder = builder.bcc(mailbox(a)?);
    }
    if let Some(id) = draft.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(id.to_owned());
    }
    if !draft.references.is_empty() {
        builder = builder.references(draft.references.join(" "));
    }

    let html = full_html(draft);
    let body = MultiPart::alternative_plain_html(html_to_text(&html), html);
    let message = if out.attachments.is_empty() {
        builder.multipart(body)
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for (att, bytes) in out.attachments {
            mixed = mixed.singlepart(attachment_part(att, bytes.clone()));
        }
        builder.multipart(mixed)
    }
    .map_err(|e| MailError::Invalid(format!("Couldn't build the message: {e}")))?;
    Ok(message.formatted())
}

fn attachment_part(att: &StagedAttachment, bytes: Vec<u8>) -> SinglePart {
    let content_type = ContentType::parse(&att.mime_type)
        .unwrap_or_else(|_| ContentType::parse("application/octet-stream").expect("valid"));
    let builder = match att.content_id.as_deref() {
        Some(cid) => Attachment::new_inline_with_name(cid.to_owned(), att.filename.clone()),
        None => Attachment::new(att.filename.clone()),
    };
    // Base64 always: the bytes arrive exactly as attached (no line-ending rewrites).
    let body = Body::new_with_encoding(bytes, ContentTransferEncoding::Base64)
        .expect("any bytes can be base64-encoded");
    builder.body(body, content_type)
}

/// Plain-text alternative of an HTML body: block ends become line breaks, list items get
/// a dash, links keep their target, quoted text gets `> `.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut quote_depth = 0usize;
    let mut pending_href: Vec<Option<String>> = Vec::new();
    let mut rest = html;
    let mut skip_until: Option<&'static str> = None;

    while let Some(lt) = rest.find('<') {
        if skip_until.is_none() {
            push_text(&mut out, &rest[..lt], quote_depth);
        }
        let after = &rest[lt..];
        if after.starts_with("<!--") {
            rest = after.find("-->").map_or("", |end| &after[end + 3..]);
            continue;
        }
        let Some(gt) = after.find('>') else {
            rest = "";
            break;
        };
        let tag = &after[1..gt];
        rest = &after[gt + 1..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if let Some(until) = skip_until {
            if closing && name == until {
                skip_until = None;
            }
            continue;
        }
        match (name.as_str(), closing) {
            ("style", false) => skip_until = Some("style"),
            ("script", false) => skip_until = Some("script"),
            ("head", false) => skip_until = Some("head"),
            ("title", false) => skip_until = Some("title"),
            ("br", _) => newline(&mut out, quote_depth),
            ("blockquote", false) => {
                block_break(&mut out, quote_depth);
                quote_depth += 1;
            }
            ("blockquote", true) => {
                quote_depth = quote_depth.saturating_sub(1);
                block_break(&mut out, quote_depth);
            }
            ("li", false) => {
                block_break(&mut out, quote_depth);
                out.push_str("- ");
            }
            ("a", false) => pending_href.push(attr(tag, "href")),
            ("a", true) => {
                if let Some(Some(href)) = pending_href.pop() {
                    let href = decode_entities(&href);
                    let text_end = out.trim_end();
                    if !href.starts_with("mailto:") && !text_end.ends_with(&href) {
                        out.push_str(&format!(" <{href}>"));
                    }
                }
            }
            (
                "p" | "div" | "tr" | "ul" | "ol" | "table" | "h1" | "h2" | "h3" | "h4" | "h5"
                | "h6" | "pre" | "hr",
                _,
            ) => block_break(&mut out, quote_depth),
            _ => {}
        }
    }
    if skip_until.is_none() {
        push_text(&mut out, rest, quote_depth);
    }
    tidy(&out)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = lower[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let value_start = tag.len() - rest.len() + 1;
        let value = tag[value_start..].trim_start();
        return Some(match value.chars().next() {
            Some(q @ ('"' | '\'')) => value[1..].split(q).next().unwrap_or("").to_owned(),
            _ => value
                .split(|c: char| c.is_whitespace())
                .next()
                .unwrap_or("")
                .to_owned(),
        });
    }
    None
}

fn prefix(depth: usize) -> String {
    "> ".repeat(depth)
}

fn at_line_start(out: &str) -> bool {
    out.is_empty() || out.ends_with('\n')
}

fn newline(out: &mut String, depth: usize) {
    if at_line_start(out) && depth > 0 {
        out.push_str(prefix(depth).trim_end());
    }
    out.push('\n');
}

fn block_break(out: &mut String, depth: usize) {
    if !at_line_start(out) {
        newline(out, depth);
    }
}

fn push_text(out: &mut String, raw: &str, depth: usize) {
    let text = decode_entities(raw);
    // HTML whitespace collapses; line breaks come from tags.
    let mut collapsed = String::with_capacity(text.len());
    let mut last_space = out.ends_with([' ', '\n']) || out.is_empty();
    for c in text.chars() {
        if c.is_whitespace() && c != '\u{a0}' {
            if !last_space {
                collapsed.push(' ');
                last_space = true;
            }
        } else {
            collapsed.push(if c == '\u{a0}' { ' ' } else { c });
            last_space = false;
        }
    }
    if collapsed.trim().is_empty() && at_line_start(out) {
        return;
    }
    if at_line_start(out) {
        out.push_str(&prefix(depth));
        out.push_str(collapsed.trim_start());
    } else {
        out.push_str(&collapsed);
    }
}

fn tidy(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    while lines.first().is_some_and(|l| l.is_empty()) {
        lines.remove(0);
    }
    let mut out = String::new();
    let mut blank = 0;
    for line in lines {
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_owned()
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        let decoded = after.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let entity = &after[1..semi];
            let c = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, semi))
        });
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Escape text for HTML, turning line breaks into `<br>`.
pub fn text_to_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("<br>"),
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(name: Option<&str>, address: &str) -> EmailAddress {
        EmailAddress {
            name: name.map(Into::into),
            address: address.into(),
        }
    }

    fn parse(raw: &[u8]) -> mailparse::ParsedMail<'_> {
        mailparse::parse_mail(raw).unwrap()
    }

    fn me() -> EmailAddress {
        addr(Some("Alex G"), "alex@example.com")
    }

    fn build(draft: &ComposeDraft, attachments: &[(StagedAttachment, Vec<u8>)]) -> Vec<u8> {
        build_message(&Outgoing {
            from: &me(),
            draft,
            attachments,
            message_id: "<id-1@pheeme.app>",
            date: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000),
        })
        .unwrap()
    }

    #[test]
    fn plain_message_has_both_alternatives_and_all_recipients() {
        use mailparse::MailHeaderMap;
        let draft = ComposeDraft {
            to: vec![addr(Some("Bö Jones"), "bo@example.com")],
            cc: vec![addr(None, "cc@example.com")],
            bcc: vec![addr(None, "hidden@example.com")],
            subject: "Café plans".into(),
            body_html: "<p>Hi <b>there</b> &amp; welcome</p><p>Line two</p>".into(),
            ..Default::default()
        };
        let raw = build(&draft, &[]);
        let mail = parse(&raw);
        let h = &mail.headers;
        assert_eq!(h.get_first_value("Subject").unwrap(), "Café plans");
        assert_eq!(
            h.get_first_value("From").unwrap(),
            "\"Alex G\" <alex@example.com>"
        );
        assert!(h.get_first_value("To").unwrap().contains("bo@example.com"));
        assert_eq!(h.get_first_value("Cc").unwrap(), "cc@example.com");
        assert_eq!(h.get_first_value("Bcc").unwrap(), "hidden@example.com");
        assert_eq!(
            h.get_first_value("Message-ID").unwrap(),
            "<id-1@pheeme.app>"
        );
        assert!(h.get_first_value("In-Reply-To").is_none());
        assert_eq!(mail.ctype.mimetype, "multipart/alternative");
        assert_eq!(mail.subparts[0].ctype.mimetype, "text/plain");
        assert_eq!(
            mail.subparts[0]
                .get_body()
                .unwrap()
                .replace("\r\n", "\n")
                .trim_end(),
            "Hi there & welcome\nLine two"
        );
        assert_eq!(mail.subparts[1].ctype.mimetype, "text/html");
        assert!(mail.subparts[1]
            .get_body()
            .unwrap()
            .contains("<b>there</b>"));
    }

    #[test]
    fn reply_headers_quote_and_attachments() {
        use mailparse::MailHeaderMap;
        let draft = ComposeDraft {
            to: vec![addr(None, "bo@example.com")],
            subject: "Re: Plans".into(),
            body_html: "<p>Sounds good</p>".into(),
            quote_html: Some("<blockquote>Original</blockquote>".into()),
            in_reply_to: Some("<orig@x>".into()),
            references: vec!["<root@x>".into(), "<orig@x>".into()],
            ..Default::default()
        };
        let files = vec![
            (
                StagedAttachment {
                    id: "1".into(),
                    filename: "notes.txt".into(),
                    mime_type: "text/plain".into(),
                    size: 5,
                    content_id: None,
                },
                b"hello".to_vec(),
            ),
            (
                StagedAttachment {
                    id: "2".into(),
                    filename: "logo.png".into(),
                    mime_type: "image/png".into(),
                    size: 3,
                    content_id: Some("logo@x".into()),
                },
                vec![0x89, 0x50, 0x4e],
            ),
        ];
        let raw = build(&draft, &files);
        let mail = parse(&raw);
        let h = &mail.headers;
        assert_eq!(h.get_first_value("In-Reply-To").unwrap(), "<orig@x>");
        assert_eq!(
            h.get_first_value("References").unwrap(),
            "<root@x> <orig@x>"
        );
        assert_eq!(mail.ctype.mimetype, "multipart/mixed");
        let html = mail.subparts[0].subparts[1].get_body().unwrap();
        assert!(html.contains("<p>Sounds good</p><br><blockquote>Original</blockquote>"));
        let text = mail.subparts[0].subparts[0].get_body().unwrap();
        assert_eq!(
            text.replace("\r\n", "\n").trim_end(),
            "Sounds good\n\n> Original"
        );

        let file = &mail.subparts[1];
        assert_eq!(file.get_body_raw().unwrap(), b"hello");
        let disp = file.get_content_disposition();
        assert_eq!(disp.disposition, mailparse::DispositionType::Attachment);
        assert_eq!(disp.params["filename"], "notes.txt");
        let inline = &mail.subparts[2];
        assert_eq!(inline.get_body_raw().unwrap(), [0x89, 0x50, 0x4e]);
        assert_eq!(
            inline.headers.get_first_value("Content-ID").unwrap(),
            "<logo@x>"
        );
    }

    #[test]
    fn drafts_may_have_no_recipients_but_bad_addresses_fail() {
        let raw = build(&ComposeDraft::default(), &[]);
        assert!(!raw.is_empty());
        let bad = ComposeDraft {
            to: vec![addr(None, "not an address")],
            ..Default::default()
        };
        let err = build_message(&Outgoing {
            from: &me(),
            draft: &bad,
            attachments: &[],
            message_id: "<x@pheeme.app>",
            date: SystemTime::now(),
        })
        .unwrap_err();
        assert!(matches!(err, MailError::Invalid(m) if m.contains("not an address")));
    }

    #[test]
    fn attachments_over_the_limit_are_refused() {
        let big = (
            StagedAttachment {
                id: "1".into(),
                filename: "big.bin".into(),
                mime_type: "application/octet-stream".into(),
                size: MAX_ATTACHMENT_BYTES + 1,
                content_id: None,
            },
            vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1],
        );
        let err = build_message(&Outgoing {
            from: &me(),
            draft: &ComposeDraft::default(),
            attachments: &[big],
            message_id: "<x@pheeme.app>",
            date: SystemTime::now(),
        })
        .unwrap_err();
        assert!(matches!(err, MailError::Invalid(_)));
    }

    #[test]
    fn html_to_text_handles_structure() {
        assert_eq!(
            html_to_text(
                "<style>p{color:red}</style><h1>Title</h1><p>One&nbsp;two<br>three</p>\
                 <ul><li>a</li><li>b</li></ul><p>See <a href=\"https://x.test/\">the site</a></p>\
                 <!-- hidden --><blockquote><p>quoted</p><blockquote>deeper</blockquote></blockquote>after"
            ),
            "Title\nOne two\nthree\n- a\n- b\nSee the site <https://x.test/>\n> quoted\n> > deeper\nafter"
        );
        assert_eq!(
            html_to_text("a &lt;b&gt; &#233;&#xe9; &bogus; &"),
            "a <b> éé &bogus; &"
        );
    }

    #[test]
    fn text_to_html_escapes() {
        assert_eq!(text_to_html("a<b>\n&c"), "a&lt;b&gt;<br>&amp;c");
    }
}
