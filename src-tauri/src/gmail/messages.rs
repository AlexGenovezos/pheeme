//! `users.messages`: list, get, modify, trash, delete, send, attachments, and parallel batch get.

use super::client::{ApiRequest, GmailClient, MAX_CONCURRENT_REQUESTS};
use super::error::GmailError;
use super::mime::{decode_base64url, encode_base64url, is_body_part};
use super::types::{AttachmentBody, Message, MessageFormat, MessageListResponse, MessagePart};
use futures::stream::{self, StreamExt};
use serde_json::json;

/// Gmail's cap on ids per `messages.batchModify` call.
pub const BATCH_MODIFY_LIMIT: usize = 1000;

impl GmailClient {
    /// One page of message ids. Pass the previous page's `next_page_token` to continue.
    pub async fn list_messages(
        &self,
        label_ids: &[&str],
        page_token: Option<&str>,
        max_results: u32,
    ) -> Result<MessageListResponse, GmailError> {
        let mut req = ApiRequest::get(&["messages"]).query("maxResults", max_results.to_string());
        for label in label_ids {
            req = req.query("labelIds", *label);
        }
        self.send_json(req.query_opt("pageToken", page_token)).await
    }

    /// One page of every message id in the mailbox, spam and trash included, newest first.
    pub async fn list_all_messages(
        &self,
        page_token: Option<&str>,
        max_results: u32,
    ) -> Result<MessageListResponse, GmailError> {
        let req = ApiRequest::get(&["messages"])
            .query("maxResults", max_results.to_string())
            .query("includeSpamTrash", "true")
            .query_opt("pageToken", page_token);
        self.send_json(req).await
    }

    /// One page of message ids matching a Gmail search (`q`), e.g. `rfc822msgid:<id@host>`.
    pub async fn search_messages(
        &self,
        q: &str,
        include_spam_trash: bool,
        page_token: Option<&str>,
        max_results: u32,
    ) -> Result<MessageListResponse, GmailError> {
        let req = ApiRequest::get(&["messages"])
            .query("q", q)
            .query("maxResults", max_results.to_string())
            .query_opt("includeSpamTrash", include_spam_trash.then_some("true"))
            .query_opt("pageToken", page_token);
        self.send_json(req).await
    }

    /// Add and remove labels on many messages (`messages.batchModify`, 1000 ids per request).
    /// Idempotent, so safe to replay.
    pub async fn batch_modify_messages(
        &self,
        ids: &[String],
        add_labels: &[String],
        remove_labels: &[String],
    ) -> Result<(), GmailError> {
        for chunk in ids.chunks(BATCH_MODIFY_LIMIT) {
            let body = json!({
                "ids": chunk,
                "addLabelIds": add_labels,
                "removeLabelIds": remove_labels,
            });
            self.send_empty(ApiRequest::post(&["messages", "batchModify"]).json(body))
                .await?;
        }
        Ok(())
    }

    pub async fn get_message(
        &self,
        id: &str,
        format: MessageFormat,
    ) -> Result<Message, GmailError> {
        let mut msg: Message = self
            .send_json(ApiRequest::get(&["messages", id]).query("format", format.as_str()))
            .await?;
        if let Some(payload) = msg.payload.as_mut() {
            self.fill_external_bodies(id, payload).await?;
        }
        Ok(msg)
    }

    /// Gmail moves large text/plain and text/html bodies out of the payload behind an
    /// `attachmentId`. Fetch them so the parser sees the body like any other.
    pub(crate) fn fill_external_bodies<'a>(
        &'a self,
        message_id: &'a str,
        part: &'a mut MessagePart,
    ) -> futures::future::BoxFuture<'a, Result<(), GmailError>> {
        Box::pin(async move {
            for child in &mut part.parts {
                self.fill_external_bodies(message_id, child).await?;
            }
            if let (true, None, Some(attachment_id)) = (
                is_body_part(part),
                &part.body.data,
                &part.body.attachment_id,
            ) {
                let bytes = self.get_attachment(message_id, attachment_id).await?;
                part.body.data = Some(encode_base64url(&bytes));
            }
            Ok(())
        })
    }

    /// Fetch many messages concurrently (at most [`MAX_CONCURRENT_REQUESTS`] in flight, shared
    /// with every other call on this client). Each request has the normal retry handling, and one
    /// failure does not affect the others.
    ///
    /// Results arrive in completion order, not input order; match on the returned id.
    pub async fn batch_get_messages(
        &self,
        ids: &[String],
        format: MessageFormat,
    ) -> Vec<(String, Result<Message, GmailError>)> {
        stream::iter(ids.iter().cloned())
            .map(|id| async move {
                let result = self.get_message(&id, format).await;
                (id, result)
            })
            .buffer_unordered(MAX_CONCURRENT_REQUESTS)
            .collect()
            .await
    }

    pub async fn modify_message(
        &self,
        id: &str,
        add_labels: &[&str],
        remove_labels: &[&str],
    ) -> Result<Message, GmailError> {
        let body = json!({ "addLabelIds": add_labels, "removeLabelIds": remove_labels });
        self.send_json(ApiRequest::post(&["messages", id, "modify"]).json(body))
            .await
    }

    pub async fn trash_message(&self, id: &str) -> Result<Message, GmailError> {
        self.send_json(ApiRequest::post(&["messages", id, "trash"]))
            .await
    }

    /// Permanently delete (bypasses Trash). Needs the full `mail.google.com` scope.
    pub async fn delete_message(&self, id: &str) -> Result<(), GmailError> {
        self.send_empty(ApiRequest::new(reqwest::Method::DELETE, &["messages", id]))
            .await
    }

    /// Send an RFC 2822 message. A reply passes its `thread_id` so Gmail files it in the
    /// conversation (its `In-Reply-To`/`References` and subject must match too).
    pub async fn send_message(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Message, GmailError> {
        let metadata = match thread_id {
            Some(t) => json!({ "threadId": t }),
            None => json!({}),
        };
        self.send_json(
            ApiRequest::post(&["messages", "send"])
                .upload_message(metadata, rfc822)
                .non_idempotent(),
        )
        .await
    }

    /// Download an attachment's bytes (Gmail returns them base64url-encoded).
    pub async fn get_attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError> {
        let body: AttachmentBody = self
            .send_json(ApiRequest::get(&[
                "messages",
                message_id,
                "attachments",
                attachment_id,
            ]))
            .await?;
        decode_base64url(&body.data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::client::test_support::client_for;
    use serde_json::Value;
    use wiremock::matchers::{
        body_json, body_string_contains, header_regex, method, path, query_param,
    };
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn fixture(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[tokio::test]
    async fn get_message_fetches_externally_stored_bodies() {
        // Gmail moves large bodies behind an attachmentId; they must parse as the body.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages/m1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "m1", "threadId": "t1", "labelIds": ["INBOX"],
                "payload": {"mimeType": "multipart/alternative", "filename": "", "headers": [],
                    "body": {"size": 0},
                    "parts": [{"partId": "0", "mimeType": "text/html", "filename": "",
                        "headers": [{"name": "Content-Type", "value": "text/html; charset=UTF-8"}],
                        "body": {"attachmentId": "big", "size": 900000}}]}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/messages/m1/attachments/big"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "size": 17, "data": encode_base64url(b"<p>big body</p>")
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let parsed = client
            .get_message("m1", MessageFormat::Full)
            .await
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(parsed.body_html.as_deref(), Some("<p>big body</p>"));
        assert!(!parsed.has_attachment);
    }

    #[tokio::test]
    async fn external_body_download_agrees_with_the_parser() {
        // `attachments` is not the `attachment` disposition, so the parser treats the part
        // as the body; the download must make the same call or the body stays empty.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages/m1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "m1", "threadId": "t1", "labelIds": ["INBOX"],
                "payload": {"mimeType": "text/plain", "filename": "",
                    "headers": [{"name": "Content-Disposition", "value": "attachments"}],
                    "body": {"attachmentId": "big", "size": 900000}}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/messages/m1/attachments/big"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "size": 8, "data": encode_base64url(b"big body")
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let parsed = client
            .get_message("m1", MessageFormat::Full)
            .await
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(parsed.body_text.as_deref(), Some("big body"));
    }

    #[tokio::test]
    async fn send_is_not_retried_after_ambiguous_5xx() {
        // Gmail may have delivered the message before failing; never re-send automatically.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/messages/send"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let err = client.send_message(b"raw", None).await.unwrap_err();
        assert!(matches!(err, GmailError::Api { status: 503, .. }));
    }

    #[tokio::test]
    async fn send_is_retried_after_429() {
        // 429 means Gmail did not act, so retrying cannot duplicate the send.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/messages/send"))
            .respond_with(ResponseTemplate::new(429))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/upload/messages/send"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"id": "m1", "threadId": "t1"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        assert_eq!(client.send_message(b"raw", None).await.unwrap().id, "m1");
    }

    #[tokio::test]
    async fn list_messages_sends_labels_and_paging() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages"))
            .and(query_param("labelIds", "INBOX"))
            .and(query_param("labelIds", "UNREAD"))
            .and(query_param("maxResults", "50"))
            .and(query_param("pageToken", "tok"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(fixture(include_str!("fixtures/messages_list.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client
            .list_messages(&["INBOX", "UNREAD"], Some("tok"), 50)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 2);
        assert_eq!(
            page.next_page_token.as_deref(),
            Some("12345678901234567890")
        );
    }

    #[tokio::test]
    async fn get_message_full_parses_end_to_end() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages/18c2f0a1b2c3d4e5"))
            .and(query_param("format", "full"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(fixture(include_str!(
                    "fixtures/message_full_multipart.json"
                ))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let msg = client
            .get_message("18c2f0a1b2c3d4e5", MessageFormat::Full)
            .await
            .unwrap();
        let parsed = msg.parse().unwrap();
        assert_eq!(parsed.attachments.len(), 2);
    }

    #[tokio::test]
    async fn modify_trash_delete_and_send_hit_the_right_endpoints() {
        let server = MockServer::start().await;
        let minimal = fixture(r#"{"id":"m1","threadId":"t1","labelIds":["TRASH"]}"#);
        Mock::given(method("POST"))
            .and(path("/messages/m1/modify"))
            .and(body_json(
                json!({"addLabelIds": ["STARRED"], "removeLabelIds": ["UNREAD"]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(minimal.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/messages/m1/trash"))
            .respond_with(ResponseTemplate::new(200).set_body_json(minimal.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/messages/m1"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/upload/messages/send"))
            .and(query_param("uploadType", "multipart"))
            .and(header_regex(
                "content-type",
                "^multipart/related; boundary=pheeme-",
            ))
            .and(body_string_contains("{\"threadId\":\"t1\"}"))
            .and(body_string_contains(
                "Content-Type: message/rfc822\r\n\r\nSubject: Hi\r\n\r\nBody\r\n--pheeme-",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(minimal))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        client
            .modify_message("m1", &["STARRED"], &["UNREAD"])
            .await
            .unwrap();
        client.trash_message("m1").await.unwrap();
        client.delete_message("m1").await.unwrap();
        assert_eq!(
            client
                .send_message(b"Subject: Hi\r\n\r\nBody", Some("t1"))
                .await
                .unwrap()
                .id,
            "m1"
        );
    }

    #[tokio::test]
    async fn get_attachment_decodes_base64url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages/m1/attachments/a1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"size": 3, "data": "-_8"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        assert_eq!(
            client.get_attachment("m1", "a1").await.unwrap(),
            b"\xfb\xff"
        );
    }

    #[tokio::test]
    async fn batch_returns_per_id_results_when_one_fails() {
        let server = MockServer::start().await;
        for id in ["ok1", "ok2"] {
            Mock::given(method("GET"))
                .and(path(format!("/messages/{id}")))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({"id": id, "threadId": "t", "labelIds": []})),
                )
                .expect(1)
                .mount(&server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/messages/gone"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(fixture(include_str!("fixtures/error_not_found.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let ids: Vec<String> = ["ok1", "gone", "ok2"].map(String::from).to_vec();
        let mut results = client
            .batch_get_messages(&ids, MessageFormat::Metadata)
            .await;
        results.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].0, "gone");
        assert!(results[0].1.as_ref().unwrap_err().is_not_found());
        assert_eq!(results[1].1.as_ref().unwrap().id, "ok1");
        assert_eq!(results[2].1.as_ref().unwrap().id, "ok2");
    }

    #[tokio::test]
    async fn batch_completes_with_more_ids_than_permits() {
        use std::time::Duration;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(40))
                    .set_body_json(json!({"id": "x", "threadId": "t"})),
            )
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let ids: Vec<String> = (0..25).map(|n| format!("m{n}")).collect();
        let results = client
            .batch_get_messages(&ids, MessageFormat::Minimal)
            .await;
        assert_eq!(results.len(), 25);
        assert!(results.iter().all(|(_, r)| r.is_ok()));
    }

    #[tokio::test]
    async fn batch_modify_posts_ids_and_labels() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages/batchModify"))
            .and(body_json(serde_json::json!({
                "ids": ["m1", "m2"],
                "addLabelIds": ["STARRED"],
                "removeLabelIds": ["INBOX"],
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .batch_modify_messages(
                &["m1".into(), "m2".into()],
                &["STARRED".into()],
                &["INBOX".into()],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn batch_modify_chunks_over_1000() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages/batchModify"))
            .respond_with(ResponseTemplate::new(204))
            .expect(2)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let ids: Vec<String> = (0..1001).map(|n| format!("m{n}")).collect();
        client
            .batch_modify_messages(&ids, &[], &["UNREAD".into()])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_all_messages_includes_spam_and_trash() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages"))
            .and(query_param("includeSpamTrash", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client.list_all_messages(None, 500).await.unwrap();
        assert!(page.messages.is_empty());
    }

    #[tokio::test]
    async fn search_messages_passes_q() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/messages"))
            .and(query_param("q", "rfc822msgid:<a@b>"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{"id": "m1", "threadId": "t1"}],
                "resultSizeEstimate": 1
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client
            .search_messages("rfc822msgid:<a@b>", false, None, 10)
            .await
            .unwrap();
        assert_eq!(page.messages[0].id, "m1");
    }
}
