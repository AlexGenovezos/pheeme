//! `users.drafts`: create, update, send.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::{Draft, Message};
use reqwest::Method;
use serde_json::json;

impl GmailClient {
    /// Save a draft from a base64url RFC 2822 message.
    pub async fn create_draft(&self, raw: &str) -> Result<Draft, GmailError> {
        self.send_json(
            ApiRequest::post(&["drafts"])
                .json(json!({ "message": { "raw": raw } }))
                .non_idempotent(),
        )
        .await
    }

    /// Replace the content of an existing draft.
    pub async fn update_draft(&self, id: &str, raw: &str) -> Result<Draft, GmailError> {
        self.send_json(
            ApiRequest::new(Method::PUT, &["drafts", id])
                .json(json!({ "id": id, "message": { "raw": raw } })),
        )
        .await
    }

    /// Send an existing draft; returns the sent message.
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
    use serde_json::Value;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn create_update_and_send_draft() {
        let server = MockServer::start().await;
        let draft: Value = serde_json::from_str(include_str!("fixtures/draft.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/drafts"))
            .and(body_json(json!({"message": {"raw": "UmF3"}})))
            .respond_with(ResponseTemplate::new(200).set_body_json(draft.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/drafts/r-8771234"))
            .and(body_json(
                json!({"id": "r-8771234", "message": {"raw": "TmV3"}}),
            ))
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
        let (client, _) = client_for(&server);

        let created = client.create_draft("UmF3").await.unwrap();
        assert_eq!(created.id, "r-8771234");
        client.update_draft("r-8771234", "TmV3").await.unwrap();
        assert_eq!(client.send_draft("r-8771234").await.unwrap().id, "sent1");
    }
}
