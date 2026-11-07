//! `users.drafts`: list, get, create, update, delete, send.
//!
//! Draft content goes through the media upload endpoint (like sends), so drafts with large
//! attachments work.

use super::client::{ApiRequest, GmailClient, Priority};
use super::error::GmailError;
use super::types::{Draft, DraftListResponse, Message, MessageFormat};
use reqwest::Method;
use serde_json::{json, Value};

fn draft_metadata(id: Option<&str>, thread_id: Option<&str>) -> Value {
    let mut message = json!({});
    if let Some(t) = thread_id {
        message["threadId"] = json!(t);
    }
    let mut draft = json!({ "message": message });
    if let Some(id) = id {
        draft["id"] = json!(id);
    }
    draft
}

impl GmailClient {
    /// One page of drafts: ids with their message id and thread id only.
    pub async fn list_drafts(
        &self,
        page_token: Option<&str>,
        max: u32,
    ) -> Result<DraftListResponse, GmailError> {
        self.send_json(
            ApiRequest::get(&["drafts"])
                .query("maxResults", max.to_string())
                .query_opt("pageToken", page_token),
        )
        .await
    }

    pub async fn get_draft(&self, id: &str, format: MessageFormat) -> Result<Draft, GmailError> {
        let mut draft: Draft = self
            .send_json(ApiRequest::get(&["drafts", id]).query("format", format.as_str()))
            .await?;
        if let Some(msg) = draft.message.as_mut() {
            if let Some(payload) = msg.payload.as_mut() {
                self.fill_external_bodies(&msg.id, payload, Priority::Sync)
                    .await?;
            }
        }
        Ok(draft)
    }

    /// Save a new draft from an RFC 2822 message (a reply passes its thread).
    pub async fn create_draft(
        &self,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        self.send_json(
            ApiRequest::post(&["drafts"])
                .upload_message(draft_metadata(None, thread_id), rfc822)
                .non_idempotent(),
        )
        .await
    }

    /// Replace the content of an existing draft. Gmail gives it a new message id.
    pub async fn update_draft(
        &self,
        id: &str,
        rfc822: &[u8],
        thread_id: Option<&str>,
    ) -> Result<Draft, GmailError> {
        self.send_json(
            ApiRequest::new(Method::PUT, &["drafts", id])
                .upload_message(draft_metadata(Some(id), thread_id), rfc822),
        )
        .await
    }

    pub async fn delete_draft(&self, id: &str) -> Result<(), GmailError> {
        self.send_empty(ApiRequest::new(Method::DELETE, &["drafts", id]))
            .await
    }

    /// Send an existing draft as it is saved; returns the sent message.
    pub async fn send_draft(&self, id: &str) -> Result<Message, GmailError> {
        self.send_json(
            ApiRequest::post(&["drafts", "send"])
                .json(json!({ "id": id }))
                .non_idempotent(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::client::test_support::client_for;
    use wiremock::matchers::{body_json, body_string_contains, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn create_update_send_and_delete_draft() {
        let server = MockServer::start().await;
        let draft: Value = serde_json::from_str(include_str!("fixtures/draft.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/upload/drafts"))
            .and(query_param("uploadType", "multipart"))
            .and(body_string_contains(r#"{"message":{"threadId":"t1"}}"#))
            .and(body_string_contains("\r\n\r\nSubject: one"))
            .respond_with(ResponseTemplate::new(200).set_body_json(draft.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/upload/drafts/r-8771234"))
            .and(body_string_contains(r#""id":"r-8771234""#))
            .and(body_string_contains("\r\n\r\nSubject: two"))
            .respond_with(ResponseTemplate::new(200).set_body_json(draft))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/drafts/send"))
            .and(body_json(json!({"id": "r-8771234"})))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"id": "sent1", "threadId": "t1", "labelIds": ["SENT"]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/drafts/r-8771234"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let created = client
            .create_draft(b"Subject: one\r\n\r\nx", Some("t1"))
            .await
            .unwrap();
        assert_eq!(created.id, "r-8771234");
        client
            .update_draft("r-8771234", b"Subject: two\r\n\r\nx", None)
            .await
            .unwrap();
        assert_eq!(client.send_draft("r-8771234").await.unwrap().id, "sent1");
        client.delete_draft("r-8771234").await.unwrap();
    }

    #[tokio::test]
    async fn list_and_get_drafts() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .and(query_param("maxResults", "100"))
            .and(query_param("pageToken", "p2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "drafts": [{"id": "d1", "message": {"id": "m1", "threadId": "t1"}}],
                "resultSizeEstimate": 1
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/drafts/d1"))
            .and(query_param("format", "full"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "d1", "message": {"id": "m1", "threadId": "t1", "labelIds": ["DRAFT"]}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client.list_drafts(Some("p2"), 100).await.unwrap();
        assert_eq!(page.drafts[0].message.as_ref().unwrap().id, "m1");
        let draft = client.get_draft("d1", MessageFormat::Full).await.unwrap();
        assert_eq!(draft.message.unwrap().label_ids, ["DRAFT"]);
    }
}
