//! Outgoing RFC 2822 messages, built with `lettre` (builder only; Gmail does the transport).
//!
//! Layout: `multipart/alternative` (plain text derived from the HTML, then the HTML). Images
//! the HTML shows through `cid:` sit beside it in `multipart/related` (Gmail's own layout, so
//! no client lists them as files), and files go after it all in `multipart/mixed`. Bcc stays in the
//! headers because the Gmail API reads recipients from them (and strips it on delivery).

use super::{ComposeDraft, StagedAttachment, MAX_ATTACHMENT_BYTES};
use crate::gmail::mime::EmailAddress;
use crate::mail::MailError;
use crate::text::decode_html_entities;
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

/// A saved message's HTML taken apart again: what the user wrote, and the quoted original
/// below it (`None` when there is none). The reverse of [`full_html`].
///
/// The quote starts at the first element carrying the `gmail_quote` class: the wrapper both
/// our reply and forward templates and Gmail's own write. What the user wrote comes first
/// and never has that class (the editor keeps no classes), so nothing in the quoted mail
/// can move the boundary. A message without such an element (written by another client, or
/// flattened by an older Pheeme) is all body.
pub fn split_quote(html: &str) -> (String, Option<String>) {
    let Some(at) = quote_start(html) else {
        return (html.to_owned(), None);
    };
    let body = html[..at].trim_end();
    // The line break `full_html` (and Gmail) puts between the two.
    let body = ["<br>", "<br/>", "<br />"]
        .iter()
        .find_map(|br| {
            let cut = body.len().checked_sub(br.len())?;
            (body.is_char_boundary(cut) && body[cut..].eq_ignore_ascii_case(br))
                .then(|| &body[..cut])
        })
        .unwrap_or(body);
    (body.to_owned(), Some(html[at..].to_owned()))
}

/// Byte offset of the first start tag whose `class` has the `gmail_quote` token.
fn quote_start(html: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(lt) = html[from..].find('<').map(|i| from + i) {
        let after = &html[lt..];
        if after.starts_with("<!--") {
            from = lt + after.find("-->").map_or(after.len(), |end| end + 3);
            continue;
        }
        let end = tag_end(after)?;
        let tag = &after[1..end];
        if tag.starts_with(|c: char| c.is_ascii_alphabetic())
            && class_of(tag).is_some_and(|class| {
                class
                    .split_ascii_whitespace()
                    .any(|token| token.eq_ignore_ascii_case("gmail_quote"))
            })
        {
            return Some(lt);
        }
        from = lt + end + 1;
    }
    None
}

/// Offset of the `>` closing the tag that `tag` starts with (a `>` inside a quoted attribute
/// value doesn't count).
fn tag_end(tag: &str) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, b) in tag.bytes().enumerate() {
        match (quote, b) {
            (Some(q), _) if b == q => quote = None,
            (None, b'"' | b'\'') => quote = Some(b),
            (None, b'>') => return Some(i),
            _ => {}
        }
    }
    None
}

/// The value of a start tag's `class` attribute (`tag` is the text between `<` and `>`).
fn class_of(tag: &str) -> Option<&str> {
    let bytes = tag.as_bytes();
    let mut i = tag.find(|c: char| c.is_ascii_whitespace() || c == '/')?;
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let name_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let name = &tag[name_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = "";
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start;
            match bytes.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    start = i + 1;
                    i = start;
                    while i < bytes.len() && bytes[i] != q {
                        i += 1;
                    }
                    value = &tag[start..i];
                    i = (i + 1).min(bytes.len());
                }
                _ => {
                    start = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    value = &tag[start..i];
                }
            }
        }
        if name.eq_ignore_ascii_case("class") {
            return Some(value);
        }
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
    let mut body = MultiPart::alternative_plain_html(html_to_text(&html), html);
    let (inline, files): (Vec<_>, Vec<_>) = out
        .attachments
        .iter()
        .partition(|(att, _)| att.content_id.is_some());
    if !inline.is_empty() {
        let mut related = MultiPart::related().multipart(body);
        for (att, bytes) in inline {
            related = related.singlepart(attachment_part(att, bytes.clone()));
        }
        body = related;
    }
    let message = if files.is_empty() {
        builder.multipart(body)
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for (att, bytes) in files {
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
    let body = if att.mime_type.trim().eq_ignore_ascii_case(FORWARDED_MESSAGE) {
        message_body(bytes)
    } else {
        // Base64: the bytes arrive exactly as attached (no line-ending rewrites).
        base64_body(bytes)
    };
    builder.body(body, content_type)
}

/// The content type of a message forwarded as an attachment (an `.eml` file).
pub const FORWARDED_MESSAGE: &str = "message/rfc822";

fn base64_body(bytes: Vec<u8>) -> Body {
    Body::new_with_encoding(bytes, ContentTransferEncoding::Base64)
        .expect("any bytes can be base64-encoded")
}

/// A forwarded message as it stands: RFC 2046 lets a `message/rfc822` part be only 7bit, 8bit
/// or binary, so readers show it as a message. One that wouldn't be valid that way (a line
/// longer than 998 bytes, a bare CR or LF, a NUL) goes as base64, which readers also take.
fn message_body(bytes: Vec<u8>) -> Body {
    if !is_valid_8bit(&bytes) {
        return base64_body(bytes);
    }
    let encoding = if bytes.is_ascii() {
        ContentTransferEncoding::SevenBit
    } else {
        ContentTransferEncoding::EightBit
    };
    Body::dangerous_pre_encoded(bytes, encoding)
}

/// RFC 5322 lines: CRLF only, each at most 998 bytes, no NUL.
fn is_valid_8bit(bytes: &[u8]) -> bool {
    let mut line = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            0 => return false,
            b'\r' if bytes.get(i + 1) != Some(&b'\n') => return false,
            b'\n' if i == 0 || bytes[i - 1] != b'\r' => return false,
            b'\r' => {}
            b'\n' => line = 0,
            _ => {
                line += 1;
                if line > 998 {
                    return false;
                }
            }
        }
    }
    true
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
                    let href = decode_html_entities(&href);
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
    let text = decode_html_entities(raw);
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
    fn split_quote_undoes_full_html() {
        let quote = "<div class=\"gmail_quote\"><div dir=\"ltr\" class=\"gmail_attr\">On Monday, Bo wrote:<br></div><blockquote class=\"gmail_quote\" style=\"margin:0\"><div class=\"gmail_signature\">theirs</div></blockquote></div>";
        for body in [
            "<p>Hi</p>",
            "",
            "<p>Hi</p><div class=\"gmail_signature\" data-smartmail=\"gmail_signature\">mine</div>",
            "<p>ends with a break</p><br>",
        ] {
            let draft = ComposeDraft {
                body_html: body.into(),
                quote_html: Some(quote.into()),
                ..Default::default()
            };
            assert_eq!(
                split_quote(&full_html(&draft)),
                (body.to_owned(), Some(quote.to_owned())),
                "{body:?}"
            );
        }
    }

    #[test]
    fn split_quote_finds_gmails_wrapper_and_nothing_else() {
        // Gmail on the web.
        let (body, quote) = split_quote(
            "<div dir=\"ltr\">Sure<a title=\"a > b\" class=\"x\">.</a></div><br>\n<div class='gmail_quote gmail_quote_container'><blockquote>hi</blockquote></div>",
        );
        assert_eq!(
            body,
            "<div dir=\"ltr\">Sure<a title=\"a > b\" class=\"x\">.</a></div>"
        );
        assert_eq!(
            quote.as_deref(),
            Some(
                "<div class='gmail_quote gmail_quote_container'><blockquote>hi</blockquote></div>"
            )
        );

        // No wrapper: all body, as written.
        for html in [
            "<p>Hi</p><blockquote><p>quoted by hand</p></blockquote>",
            "<p>about class=\"gmail_quote\" in text</p>",
            "<p data-class=\"gmail_quote\">x</p><p class=\"gmail_quoted\">y</p>",
            "<!-- <div class=\"gmail_quote\"> --><p>Hi</p>",
            "<p>unclosed <div class=\"gmail_quote\"",
            "",
        ] {
            assert_eq!(split_quote(html), (html.to_owned(), None), "{html}");
        }
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
        // mixed [ related [ alternative [ text, html ], logo.png ], notes.txt ]
        assert_eq!(mail.ctype.mimetype, "multipart/mixed");
        assert_eq!(mail.subparts.len(), 2);
        let related = &mail.subparts[0];
        assert_eq!(related.ctype.mimetype, "multipart/related");
        let alternative = &related.subparts[0];
        assert_eq!(alternative.ctype.mimetype, "multipart/alternative");
        let html = alternative.subparts[1].get_body().unwrap();
        assert!(html.contains("<p>Sounds good</p><br><blockquote>Original</blockquote>"));
        let text = alternative.subparts[0].get_body().unwrap();
        assert_eq!(
            text.replace("\r\n", "\n").trim_end(),
            "Sounds good\n\n> Original"
        );

        let file = &mail.subparts[1];
        assert_eq!(file.get_body_raw().unwrap(), b"hello");
        let disp = file.get_content_disposition();
        assert_eq!(disp.disposition, mailparse::DispositionType::Attachment);
        assert_eq!(disp.params["filename"], "notes.txt");
        let inline = &related.subparts[1];
        assert_eq!(
            inline.get_content_disposition().disposition,
            mailparse::DispositionType::Inline
        );
        assert_eq!(inline.get_body_raw().unwrap(), [0x89, 0x50, 0x4e]);
        assert_eq!(
            inline.headers.get_first_value("Content-ID").unwrap(),
            "<logo@x>"
        );
    }

    #[test]
    fn a_forwarded_message_goes_as_it_stands_unless_it_cannot() {
        let forwarded = |name: &str, bytes: &[u8]| {
            (
                StagedAttachment {
                    id: name.into(),
                    filename: format!("{name}.eml"),
                    mime_type: FORWARDED_MESSAGE.into(),
                    size: bytes.len() as u64,
                    content_id: None,
                },
                bytes.to_vec(),
            )
        };
        let long_line = format!("Subject: x\r\n\r\n{}\r\n", "a".repeat(999));
        let files = vec![
            forwarded("ascii", b"Subject: Hi\r\n\r\nHello\r\n"),
            forwarded("utf8", "Subject: Hi\r\n\r\nCaf\u{e9}\r\n".as_bytes()),
            forwarded("bare-lf", b"Subject: Hi\n\nHello\n"),
            forwarded("long", long_line.as_bytes()),
        ];
        let draft = ComposeDraft {
            to: vec![addr(None, "bo@example.com")],
            subject: "Fwd".into(),
            ..Default::default()
        };
        let raw = build(&draft, &files);
        let mail = parse(&raw);
        let parts = &mail.subparts[1..];
        let encodings: Vec<String> = parts
            .iter()
            .map(|p| {
                use mailparse::MailHeaderMap;
                p.headers
                    .get_first_value("Content-Transfer-Encoding")
                    .unwrap()
            })
            .collect();
        assert_eq!(encodings, ["7bit", "8bit", "base64", "base64"]);
        for (part, (att, bytes)) in parts.iter().zip(&files) {
            assert_eq!(part.ctype.mimetype, "message/rfc822");
            assert_eq!(
                part.get_content_disposition().params["filename"],
                att.filename
            );
            assert_eq!(&part.get_body_raw().unwrap(), bytes, "{}", att.filename);
        }
    }

    #[test]
    fn a_pasted_image_alone_goes_beside_the_html_in_related() {
        let draft = ComposeDraft {
            to: vec![addr(None, "bo@example.com")],
            body_html: "<p>Before</p><img src=\"cid:abc@pheeme.app\"><p>After</p>".into(),
            ..Default::default()
        };
        let image = (
            StagedAttachment {
                id: "1".into(),
                filename: "image.png".into(),
                mime_type: "image/png".into(),
                size: 3,
                content_id: Some("abc@pheeme.app".into()),
            },
            vec![0x89, 0x50, 0x4e],
        );
        let raw = build(&draft, &[image]);
        let mail = parse(&raw);
        assert_eq!(mail.ctype.mimetype, "multipart/related");
        assert_eq!(mail.subparts[0].ctype.mimetype, "multipart/alternative");
        let html = mail.subparts[0].subparts[1].get_body().unwrap();
        assert!(html.contains("<img src=\"cid:abc@pheeme.app\">"));
        use mailparse::MailHeaderMap;
        assert_eq!(
            mail.subparts[1]
                .headers
                .get_first_value("Content-ID")
                .unwrap(),
            "<abc@pheeme.app>"
        );
        // Read back the way Gmail's copy is read: an inline image, not a listed file.
        let parsed = crate::gmail::mime::parse_raw(&crate::gmail::types::Message {
            id: "m".into(),
            raw: Some(crate::gmail::mime::encode_base64url(&raw)),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(parsed.attachments.len(), 1);
        assert!(parsed.attachments[0].is_inline);
        assert_eq!(
            parsed.attachments[0].content_id.as_deref(),
            Some("abc@pheeme.app")
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
