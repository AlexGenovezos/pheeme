//! Turning Gmail messages into a flat [`ParsedMessage`] that maps onto the `messages` and
//! `attachments` tables.
//!
//! Two inputs are supported:
//! - `format=full`: walk Gmail's already-decoded `payload` part tree ([`parse_payload`]).
//! - `format=raw`: parse the base64url RFC 2822 `raw` field with `mailparse` ([`parse_raw`]).
//!
//! [`parse_message`] picks whichever the message carries. Attachment content is never read;
//! only metadata is collected (fetch content with `GmailClient::get_attachment`).

use super::error::GmailError;
use super::types::{Header, Message, MessagePart};
use base64::{
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};
use mailparse::{
    addrparse_header, dateparse, parse_content_disposition, parse_content_type, parse_header,
    parse_headers, parse_mail, DispositionType, MailAddr, MailHeaderMap, ParsedMail,
};
use serde::{Deserialize, Serialize};

/// Gmail emits unpadded base64url but accepts and sometimes returns padded; take both.
const LENIENT_URL_SAFE: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn decode_base64url(data: &str) -> Result<Vec<u8>, GmailError> {
    LENIENT_URL_SAFE
        .decode(data.trim())
        .map_err(|e| GmailError::Decode(format!("invalid base64url data: {e}")))
}

/// Encode an RFC 2822 message for the `raw` field of send/draft requests.
pub fn encode_base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The `Message-ID` of a raw RFC 2822 message, angle brackets included. Reads the header
/// block only (folded headers are unfolded); a `Message-ID:` line in the body doesn't count.
pub fn rfc822_message_id(raw: &[u8]) -> Option<String> {
    let (headers, _) = parse_headers(raw).ok()?;
    headers
        .get_first_value("Message-ID")
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: String,
}

/// Attachment metadata, never content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedAttachment {
    pub filename: Option<String>,
    pub mime_type: String,
    pub size: u64,
    /// Gmail attachment id for `get_attachment`; `None` when parsed from `raw`.
    pub attachment_id: Option<String>,
    /// Content-ID without angle brackets, for resolving `cid:` URLs in the HTML body.
    pub content_id: Option<String>,
    /// Embedded in the body (has a Content-ID and is not marked `attachment`); not a paperclip.
    pub is_inline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedMessage {
    pub id: String,
    pub thread_id: String,
    pub history_id: Option<String>,
    pub label_ids: Vec<String>,
    /// Gmail's snippet with HTML entities decoded.
    pub snippet: String,
    pub from: Option<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    /// Decoded (RFC 2047) subject.
    pub subject: Option<String>,
    /// Milliseconds since the epoch: `internalDate`, falling back to the `Date` header.
    pub date: Option<i64>,
    pub size_estimate: Option<u64>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
    /// True when at least one non-inline attachment exists.
    pub has_attachment: bool,
    pub is_read: bool,
    pub is_starred: bool,
    /// Headers as sent (values not decoded).
    pub headers: Vec<Header>,
    /// `Message-ID` header value, including angle brackets.
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}

/// Parse whichever representation the message carries: `payload` (full/metadata), else `raw`,
/// else just the envelope (minimal format).
pub fn parse_message(msg: &Message) -> Result<ParsedMessage, GmailError> {
    if msg.payload.is_some() {
        parse_payload(msg)
    } else if msg.raw.is_some() {
        parse_raw(msg)
    } else {
        Ok(base(msg, Vec::new(), Body::default()))
    }
}

impl Message {
    /// See [`parse_message`].
    pub fn parse(&self) -> Result<ParsedMessage, GmailError> {
        parse_message(self)
    }
}

#[derive(Default)]
struct Body {
    text: Option<String>,
    html: Option<String>,
    attachments: Vec<ParsedAttachment>,
}

impl Body {
    fn push_text(&mut self, text: String) {
        append(&mut self.text, text);
    }

    fn push_html(&mut self, html: String) {
        append(&mut self.html, html);
    }
}

fn append(slot: &mut Option<String>, text: String) {
    if text.is_empty() {
        return;
    }
    match slot {
        Some(existing) => {
            existing.push('\n');
            existing.push_str(&text);
        }
        None => *slot = Some(text),
    }
}

/// Walk `msg.payload` (a `format=full` message).
pub fn parse_payload(msg: &Message) -> Result<ParsedMessage, GmailError> {
    let payload = msg
        .payload
        .as_ref()
        .ok_or_else(|| GmailError::Decode(format!("message {} has no payload", msg.id)))?;
    let mut body = Body::default();
    walk_payload(payload, &mut body)?;
    Ok(base(msg, payload.headers.clone(), body))
}

/// Parse `msg.raw` (a `format=raw` message).
pub fn parse_raw(msg: &Message) -> Result<ParsedMessage, GmailError> {
    let raw = msg
        .raw
        .as_deref()
        .ok_or_else(|| GmailError::Decode(format!("message {} has no raw body", msg.id)))?;
    let bytes = decode_base64url(raw)?;
    let mail = parse_mail(&bytes)
        .map_err(|e| GmailError::Decode(format!("message {} is not valid MIME: {e}", msg.id)))?;
    let headers = mail
        .headers
        .iter()
        .map(|h| Header {
            name: h.get_key(),
            value: String::from_utf8_lossy(h.get_value_raw()).trim().to_owned(),
        })
        .collect();
    let mut body = Body::default();
    walk_raw(&mail, &mut body)?;
    Ok(base(msg, headers, body))
}

/// Assemble the message from the envelope, headers and collected body.
fn base(msg: &Message, headers: Vec<Header>, body: Body) -> ParsedMessage {
    let header = |name: &str| {
        headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    };
    let from = header("From").and_then(|v| {
        parse_addresses("From", v).into_iter().next().or_else(|| {
            let raw = v.trim();
            (!raw.is_empty()).then(|| EmailAddress {
                name: None,
                address: raw.to_owned(),
            })
        })
    });
    let list = |name: &str| {
        headers
            .iter()
            .filter(|h| h.name.eq_ignore_ascii_case(name))
            .flat_map(|h| parse_addresses(name, &h.value))
            .collect::<Vec<_>>()
    };
    let date = msg.internal_date_ms().or_else(|| {
        header("Date")
            .and_then(|v| dateparse(v).ok())
            .map(|s| s * 1000)
    });
    let has_attachment = body.attachments.iter().any(|a| !a.is_inline);
    ParsedMessage {
        id: msg.id.clone(),
        thread_id: msg.thread_id.clone(),
        history_id: msg.history_id.clone(),
        label_ids: msg.label_ids.clone(),
        snippet: decode_html_entities(&msg.snippet),
        to: list("To"),
        cc: list("Cc"),
        subject: header("Subject").map(|v| decode_header_value("Subject", v)),
        from,
        date,
        size_estimate: msg.size_estimate,
        body_text: body.text,
        body_html: body.html,
        attachments: body.attachments,
        has_attachment,
        is_read: !msg.label_ids.iter().any(|l| l == "UNREAD"),
        is_starred: msg.label_ids.iter().any(|l| l == "STARRED"),
        message_id: header("Message-ID").map(|v| v.trim().to_owned()),
        in_reply_to: header("In-Reply-To").map(|v| v.trim().to_owned()),
        references: header("References")
            .map(|v| v.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default(),
        headers,
    }
}

/// How a leaf MIME part contributes to the message.
#[derive(Debug, PartialEq, Eq)]
enum PartKind {
    Text,
    Html,
    Attachment { inline: bool },
    Skip,
}

struct PartInfo<'a> {
    mime: &'a str,
    filename: Option<&'a str>,
    disposition_attachment: bool,
    content_id: Option<&'a str>,
    has_attachment_id: bool,
    has_content: bool,
}

/// A leaf part is a text body (not an attachment) when it's text/plain or text/html
/// (`mime` lowercased), unnamed and not marked `Content-Disposition: attachment`.
fn is_body(mime: &str, filename: Option<&str>, disposition_attachment: bool) -> bool {
    let named = filename.is_some_and(|f| !f.is_empty());
    (mime == "text/plain" || mime == "text/html") && !named && !disposition_attachment
}

fn is_attachment_disposition(part: &MessagePart) -> bool {
    part.header("Content-Disposition")
        .is_some_and(|d| parse_content_disposition(d).disposition == DispositionType::Attachment)
}

/// Whether a `format=full` payload part is a text body. Gmail stores large bodies
/// externally (`attachmentId`); `GmailClient::get_message` uses this to fetch them
/// before parsing, so it must agree with [`classify`].
pub(crate) fn is_body_part(part: &MessagePart) -> bool {
    is_body(
        &part.mime_type.to_ascii_lowercase(),
        Some(&part.filename),
        is_attachment_disposition(part),
    )
}

fn classify(p: &PartInfo) -> PartKind {
    let named = p.filename.is_some_and(|f| !f.is_empty());
    if is_body(p.mime, p.filename, p.disposition_attachment) {
        return if p.mime == "text/html" {
            PartKind::Html
        } else {
            PartKind::Text
        };
    }
    if named || p.disposition_attachment || p.has_attachment_id || p.has_content {
        PartKind::Attachment {
            inline: p.content_id.is_some() && !p.disposition_attachment,
        }
    } else {
        PartKind::Skip
    }
}

fn clean_content_id(raw: &str) -> Option<String> {
    let id = raw
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim();
    (!id.is_empty()).then(|| id.to_owned())
}

fn walk_payload(part: &MessagePart, out: &mut Body) -> Result<(), GmailError> {
    let mime = part.mime_type.to_ascii_lowercase();
    if mime.starts_with("multipart/") {
        for child in &part.parts {
            walk_payload(child, out)?;
        }
        return Ok(());
    }
    let disposition_attachment = is_attachment_disposition(part);
    let content_id = part.header("Content-ID").and_then(clean_content_id);
    let kind = classify(&PartInfo {
        mime: &mime,
        filename: Some(part.filename.as_str()),
        disposition_attachment,
        content_id: content_id.as_deref(),
        has_attachment_id: part.body.attachment_id.is_some(),
        has_content: part.body.size > 0 || part.body.data.is_some(),
    });
    match kind {
        PartKind::Text | PartKind::Html => {
            let Some(data) = part.body.data.as_deref() else {
                return Ok(());
            };
            let bytes = decode_base64url(data)?;
            let charset = part
                .header("Content-Type")
                .map(|v| parse_content_type(v).charset);
            let text = decode_charset(&bytes, charset.as_deref());
            if kind == PartKind::Html {
                out.push_html(text);
            } else {
                out.push_text(text);
            }
        }
        PartKind::Attachment { inline } => out.attachments.push(ParsedAttachment {
            filename: (!part.filename.is_empty()).then(|| part.filename.clone()),
            mime_type: mime,
            size: part.body.size,
            attachment_id: part.body.attachment_id.clone(),
            content_id,
            is_inline: inline,
        }),
        PartKind::Skip => {}
    }
    Ok(())
}

fn walk_raw(mail: &ParsedMail, out: &mut Body) -> Result<(), GmailError> {
    let mime = mail.ctype.mimetype.to_ascii_lowercase();
    if mime.starts_with("multipart/") {
        for child in &mail.subparts {
            walk_raw(child, out)?;
        }
        return Ok(());
    }
    let disposition = mail.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .or_else(|| mail.ctype.params.get("name"))
        .map(|f| decode_header_value("X", f))
        .filter(|f| !f.is_empty());
    let content_id = mail
        .headers
        .get_first_value("Content-ID")
        .as_deref()
        .and_then(clean_content_id);
    let disposition_attachment = disposition.disposition == DispositionType::Attachment;
    let raw_body = mail
        .get_body_raw()
        .map_err(|e| GmailError::Decode(format!("could not decode MIME part body: {e}")))?;
    let kind = classify(&PartInfo {
        mime: &mime,
        filename: filename.as_deref(),
        disposition_attachment,
        content_id: content_id.as_deref(),
        has_attachment_id: false,
        has_content: !raw_body.is_empty(),
    });
    match kind {
        PartKind::Text | PartKind::Html => {
            // `get_body` applies the part's charset; fall back to lossy UTF-8 for odd encodings.
            let text = mail
                .get_body()
                .unwrap_or_else(|_| String::from_utf8_lossy(&raw_body).into_owned());
            if kind == PartKind::Html {
                out.push_html(text);
            } else {
                out.push_text(text);
            }
        }
        PartKind::Attachment { inline } => out.attachments.push(ParsedAttachment {
            filename,
            mime_type: mime,
            size: raw_body.len() as u64,
            attachment_id: None,
            content_id,
            is_inline: inline,
        }),
        PartKind::Skip => {}
    }
    Ok(())
}

/// Decode part bytes with the declared charset. UTF-8/ASCII (or none) is the fast path;
/// anything else goes through mailparse's charset tables.
fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    let label = charset.map(str::trim).unwrap_or("");
    let plain = label.is_empty()
        || label.eq_ignore_ascii_case("utf-8")
        || label.eq_ignore_ascii_case("utf8")
        || label.eq_ignore_ascii_case("us-ascii");
    if plain {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    // Reuse mailparse's decoder by wrapping the bytes as a trivial single-part message.
    let safe_label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        .collect();
    let mut raw =
        format!("Content-Type: text/plain; charset=\"{safe_label}\"\r\n\r\n").into_bytes();
    raw.extend_from_slice(bytes);
    parse_mail(&raw)
        .ok()
        .and_then(|m| m.get_body().ok())
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// Decode RFC 2047 encoded words (and unfold) in a header value.
fn decode_header_value(name: &str, value: &str) -> String {
    let line = format!("{name}: {value}");
    parse_header(line.as_bytes())
        .map(|(h, _)| h.get_value().trim().to_owned())
        .unwrap_or_else(|_| value.trim().to_owned())
}

/// Split an address header into `(name, address)` pairs; unparseable input yields nothing.
fn parse_addresses(name: &str, value: &str) -> Vec<EmailAddress> {
    let line = format!("{name}: {value}");
    let Ok((header, _)) = parse_header(line.as_bytes()) else {
        return Vec::new();
    };
    let Ok(list) = addrparse_header(&header) else {
        return Vec::new();
    };
    let single = |s: mailparse::SingleInfo| EmailAddress {
        name: s.display_name.filter(|n| !n.trim().is_empty()),
        address: s.addr,
    };
    list.into_inner()
        .into_iter()
        .flat_map(|addr| match addr {
            MailAddr::Single(s) => vec![single(s)],
            MailAddr::Group(g) => g.addrs.into_iter().map(single).collect(),
        })
        .collect()
}

/// Gmail snippets arrive HTML-escaped (`&#39;`, `&amp;`, ...).
fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let decoded = tail.find(';').filter(|&end| end <= 10).and_then(|end| {
            let entity = &tail[1..end];
            let ch = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => entity.strip_prefix('#').and_then(|n| {
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => n.parse().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            ch.map(|c| (c, end + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(json: &str) -> Message {
        serde_json::from_str(json).expect("fixture parses")
    }

    #[test]
    fn full_nested_multipart_message() {
        let msg = message(include_str!("fixtures/message_full_multipart.json"));
        let parsed = parse_message(&msg).unwrap();

        assert_eq!(parsed.id, "18c2f0a1b2c3d4e5");
        assert_eq!(parsed.thread_id, "18c2f0a1b2c3d4e5");
        assert_eq!(
            parsed.subject.as_deref(),
            Some("Q3 plan: caf\u{e9} offsite")
        );
        let from = parsed.from.as_ref().unwrap();
        assert_eq!(from.name.as_deref(), Some("Zo\u{eb} Ng"));
        assert_eq!(from.address, "zoe@example.com");
        assert_eq!(parsed.to.len(), 2);
        assert_eq!(parsed.to[0].name.as_deref(), Some("Alex Genovezos"));
        assert_eq!(parsed.to[1].address, "bob@example.org");
        assert_eq!(parsed.cc.len(), 1);
        assert_eq!(parsed.cc[0].name, None);
        assert_eq!(parsed.cc[0].address, "carol@example.net");
        assert_eq!(parsed.date, Some(1_730_000_000_000));
        assert_eq!(
            parsed.message_id.as_deref(),
            Some("<CAF=abc123@mail.example.com>")
        );
        assert_eq!(
            parsed.in_reply_to.as_deref(),
            Some("<prev-1@mail.example.com>")
        );
        assert_eq!(
            parsed.references,
            vec!["<root@mail.example.com>", "<prev-1@mail.example.com>"]
        );
        assert_eq!(parsed.snippet, "Here's the plan & the budget");
        assert!(!parsed.is_read);
        assert!(parsed.is_starred);
        assert_eq!(
            parsed.label_ids,
            vec!["UNREAD", "STARRED", "INBOX", "IMPORTANT"]
        );
        assert_eq!(
            parsed.body_text.as_deref(),
            Some("Hi Alex,\r\n\r\nHere is the plan.\r\n")
        );
        let html = parsed.body_html.as_deref().unwrap();
        assert!(html.contains("<b>plan</b>") && html.contains("cid:logo@example.com"));

        assert_eq!(parsed.attachments.len(), 2);
        let inline = &parsed.attachments[0];
        assert!(inline.is_inline);
        assert_eq!(inline.content_id.as_deref(), Some("logo@example.com"));
        assert_eq!(inline.mime_type, "image/png");
        let pdf = &parsed.attachments[1];
        assert!(!pdf.is_inline);
        assert_eq!(pdf.filename.as_deref(), Some("budget.pdf"));
        assert_eq!(pdf.mime_type, "application/pdf");
        assert_eq!(pdf.size, 48210);
        assert_eq!(pdf.attachment_id.as_deref(), Some("ANGjdJ8attachmentid"));
        assert!(parsed.has_attachment);
        assert_eq!(
            parsed
                .headers
                .iter()
                .filter(|h| h.name == "Received")
                .count(),
            1
        );
    }

    #[test]
    fn inline_images_alone_do_not_set_has_attachment() {
        let mut msg = message(include_str!("fixtures/message_full_multipart.json"));
        // Drop the PDF (second child of multipart/mixed).
        msg.payload.as_mut().unwrap().parts.truncate(1);
        let parsed = parse_message(&msg).unwrap();
        assert_eq!(parsed.attachments.len(), 1);
        assert!(!parsed.has_attachment);
    }

    #[test]
    fn single_part_non_utf8_charset_is_decoded() {
        let msg = message(include_str!("fixtures/message_latin1.json"));
        let parsed = parse_message(&msg).unwrap();
        assert_eq!(
            parsed.body_text.as_deref(),
            Some("Caf\u{e9} cr\u{e8}me br\u{fb}l\u{e9}e")
        );
        assert!(parsed.body_html.is_none());
        assert!(parsed.is_read);
        assert!(!parsed.is_starred);
        // No internalDate in this fixture: falls back to the Date header.
        assert_eq!(parsed.date, Some(1_730_000_100_000));
    }

    #[test]
    fn raw_message_matches_payload_shape() {
        let msg = message(include_str!("fixtures/message_raw.json"));
        let parsed = parse_message(&msg).unwrap();

        assert_eq!(parsed.id, "18c2f0ffeeddcc01");
        assert_eq!(parsed.subject.as_deref(), Some("Invoice \u{2013} October"));
        let from = parsed.from.as_ref().unwrap();
        assert_eq!(from.name.as_deref(), Some("Billing Team"));
        assert_eq!(from.address, "billing@vendor.example");
        assert_eq!(parsed.to[0].address, "alex@example.com");
        assert_eq!(parsed.cc[0].address, "ap@example.com");
        assert_eq!(parsed.date, Some(1_730_100_000_000));
        assert_eq!(
            parsed.body_text.as_deref().map(str::trim),
            Some("Invoice attached. Caf\u{e9}!")
        );
        let html = parsed.body_html.as_deref().unwrap();
        assert!(html.contains("<p>Invoice attached."));
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(
            parsed.attachments[0].filename.as_deref(),
            Some("invoice.txt")
        );
        assert_eq!(parsed.attachments[0].size, 12);
        assert!(parsed.attachments[0].attachment_id.is_none());
        assert!(parsed.has_attachment);
        assert_eq!(parsed.message_id.as_deref(), Some("<raw-1@vendor.example>"));
    }

    #[test]
    fn minimal_message_has_envelope_only() {
        let msg = message(r#"{"id":"1","threadId":"2","labelIds":["INBOX"]}"#);
        let parsed = parse_message(&msg).unwrap();
        assert_eq!(parsed.thread_id, "2");
        assert!(parsed.body_text.is_none() && parsed.attachments.is_empty());
        assert!(parsed.is_read);
    }

    #[test]
    fn bad_base64_is_a_decode_error() {
        let msg = message(
            r#"{"id":"1","payload":{"mimeType":"text/plain","body":{"size":3,"data":"!!!"}}}"#,
        );
        assert_eq!(parse_message(&msg).unwrap_err().code(), "decode");
    }

    #[test]
    fn base64url_accepts_padded_and_unpadded() {
        assert_eq!(decode_base64url("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64url("aGk=").unwrap(), b"hi");
        assert_eq!(
            decode_base64url(&encode_base64url(b"\xfb\xff")).unwrap(),
            b"\xfb\xff"
        );
        assert_eq!(encode_base64url(b"\xfb\xff"), "-_8");
    }

    #[test]
    fn address_list_handles_quotes_groups_and_garbage() {
        let list = parse_addresses(
            "To",
            r#""Doe, Jane" <jane@example.com>, bare@example.com, team: a@x.com, b@x.com;"#,
        );
        let addrs: Vec<_> = list.iter().map(|a| a.address.as_str()).collect();
        assert_eq!(
            addrs,
            ["jane@example.com", "bare@example.com", "a@x.com", "b@x.com"]
        );
        assert_eq!(list[0].name.as_deref(), Some("Doe, Jane"));
        assert!(parse_addresses("To", "undisclosed-recipients:;").is_empty());
    }

    #[test]
    fn rfc822_message_id_reads_headers_only() {
        assert_eq!(
            rfc822_message_id(b"Subject: a\r\nmessage-id: <a@x>\r\n\r\nbody").as_deref(),
            Some("<a@x>")
        );
        assert_eq!(
            rfc822_message_id(b"Message-ID:\r\n <folded@x>\r\nTo: b@x\r\n\r\n").as_deref(),
            Some("<folded@x>")
        );
        assert_eq!(
            rfc822_message_id(b"Subject: a\r\n\r\nMessage-ID: <body@x>\r\n"),
            None
        );
        assert_eq!(rfc822_message_id(b"Message-ID:   \r\n\r\n"), None);
    }

    #[test]
    fn html_entities() {
        assert_eq!(
            decode_html_entities("a &amp; b &#39;c&#39; &lt;d&gt; &#x1F600;"),
            "a & b 'c' <d> \u{1f600}"
        );
        assert_eq!(decode_html_entities("AT&T & co"), "AT&T & co");
    }
}
