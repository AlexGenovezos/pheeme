//! Gmail API shapes → SQLite rows.

use crate::db::attachments::DbAttachment;
use crate::db::labels::DbLabel;
use crate::db::messages::DbMessage;
use crate::gmail::types::{Label, Message};
use crate::gmail::{GmailError, ParsedMessage};

/// A fetched message as rows. `fully_fetched` is true for `format=full` copies.
pub fn to_db_message(
    account_id: &str,
    parsed: &ParsedMessage,
    fully_fetched: bool,
) -> (DbMessage, Vec<DbAttachment>) {
    let msg = DbMessage {
        id: parsed.id.clone(),
        account_id: account_id.to_owned(),
        thread_id: parsed.thread_id.clone(),
        label_ids: Some(json(&parsed.label_ids)),
        from_address: parsed.from.as_ref().map(|a| a.address.clone()),
        from_name: parsed.from.as_ref().and_then(|a| a.name.clone()),
        to_addresses: Some(json(&parsed.to)),
        cc_addresses: Some(json(&parsed.cc)),
        subject: parsed.subject.clone(),
        snippet: Some(parsed.snippet.clone()),
        body_html: fully_fetched.then(|| parsed.body_html.clone()).flatten(),
        body_text: fully_fetched.then(|| parsed.body_text.clone()).flatten(),
        date: parsed.date,
        size_estimate: parsed.size_estimate.map(|s| s as i64),
        has_attachment: parsed.has_attachment.into(),
        is_read: parsed.is_read.into(),
        is_starred: parsed.is_starred.into(),
        raw_headers: fully_fetched.then(|| json(&parsed.headers)),
        fully_fetched: fully_fetched.into(),
        rfc822_message_id: parsed.message_id.clone(),
    };
    let attachments = if fully_fetched {
        parsed
            .attachments
            .iter()
            .enumerate()
            .map(|(i, a)| DbAttachment {
                id: i.to_string(),
                message_id: parsed.id.clone(),
                account_id: account_id.to_owned(),
                filename: a.filename.clone(),
                mime_type: Some(a.mime_type.clone()),
                size: Some(a.size as i64),
                attachment_id: a.attachment_id.clone(),
                content_id: a.content_id.clone(),
                is_inline: a.is_inline.into(),
            })
            .collect()
    } else {
        Vec::new()
    };
    (msg, attachments)
}

/// Parse and convert one API message.
pub fn message_rows(
    account_id: &str,
    msg: &Message,
    fully_fetched: bool,
) -> Result<(DbMessage, Vec<DbAttachment>), GmailError> {
    Ok(to_db_message(account_id, &msg.parse()?, fully_fetched))
}

pub fn to_db_label(account_id: &str, label: &Label) -> DbLabel {
    let count = |n: Option<u32>| i64::from(n.unwrap_or(0));
    DbLabel {
        id: label.id.clone(),
        account_id: account_id.to_owned(),
        name: label.name.clone(),
        label_type: label.label_type.clone().unwrap_or_else(|| "user".into()),
        message_list_visibility: label.message_list_visibility.clone(),
        label_list_visibility: label.label_list_visibility.clone(),
        color_background: label.color.as_ref().map(|c| c.background_color.clone()),
        color_text: label.color.as_ref().map(|c| c.text_color.clone()),
        messages_total: count(label.messages_total),
        messages_unread: count(label.messages_unread),
        threads_total: count(label.threads_total),
        threads_unread: count(label.threads_unread),
    }
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("plain data serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::types::{Header, MessagePart, MessagePartBody};

    fn message(with_body: bool) -> Message {
        Message {
            id: "m1".into(),
            thread_id: "t1".into(),
            label_ids: vec!["INBOX".into(), "UNREAD".into()],
            snippet: "hi".into(),
            internal_date: Some("1000".into()),
            payload: Some(MessagePart {
                mime_type: "text/plain".into(),
                headers: vec![
                    Header {
                        name: "From".into(),
                        value: "Ann <ann@example.com>".into(),
                    },
                    Header {
                        name: "Subject".into(),
                        value: "Hello".into(),
                    },
                    Header {
                        name: "Message-ID".into(),
                        value: "<x@example.com>".into(),
                    },
                ],
                body: MessagePartBody {
                    data: with_body.then(|| crate::gmail::mime::encode_base64url(b"body")),
                    ..Default::default()
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn full_message_converts_with_body_and_message_id() {
        let (m, _) = message_rows("a", &message(true), true).unwrap();
        assert_eq!(m.body_text.as_deref(), Some("body"));
        assert_eq!(m.fully_fetched, 1);
        assert_eq!(m.is_read, 0);
        assert_eq!(m.from_name.as_deref(), Some("Ann"));
        assert_eq!(m.rfc822_message_id.as_deref(), Some("<x@example.com>"));
        assert_eq!(m.labels(), ["INBOX", "UNREAD"]);
        assert_eq!(m.date, Some(1000));
    }

    #[test]
    fn metadata_message_has_no_body() {
        let (m, atts) = message_rows("a", &message(false), false).unwrap();
        assert_eq!((m.body_text, m.body_html, m.fully_fetched), (None, None, 0));
        assert!(m.raw_headers.is_none());
        assert!(atts.is_empty());
        assert_eq!(m.subject.as_deref(), Some("Hello"));
    }

    #[test]
    fn row_keeps_inline_content_id() {
        use crate::gmail::mime::ParsedAttachment;
        let mut parsed = message_with_attachments();
        parsed.attachments = vec![
            ParsedAttachment {
                filename: Some("logo.png".into()),
                mime_type: "image/png".into(),
                size: 10,
                attachment_id: Some("g0".into()),
                content_id: Some("logo@x".into()),
                is_inline: true,
            },
            ParsedAttachment {
                filename: Some("a.pdf".into()),
                mime_type: "application/pdf".into(),
                size: 20,
                attachment_id: Some("g1".into()),
                content_id: None,
                is_inline: false,
            },
        ];

        let (_, atts) = to_db_message("a", &parsed, true);

        assert_eq!(atts.len(), 2);
        assert_eq!(atts[0].content_id.as_deref(), Some("logo@x"));
        assert_eq!(atts[0].is_inline, 1);
        assert_eq!(atts[1].content_id, None);
        assert_eq!(atts[1].is_inline, 0);
    }

    fn message_with_attachments() -> ParsedMessage {
        message(true).parse().unwrap()
    }
}
