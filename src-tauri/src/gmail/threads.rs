//! `users.threads`: list, get, modify, trash.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::{MessageFormat, Thread, ThreadListResponse};
use serde_json::json;

impl GmailClient {
    /// One page of threads (`id`, `snippet`, `historyId` only; call `get_thread` for messages).
    pub async fn list_threads(
        &self,
        label_ids: &[&str],
        page_token: Option<&str>,
        max_results: u32,
    ) -> Result<ThreadListResponse, GmailError> {
        let mut req = ApiRequest::get(&["threads"]).query("maxResults", max_results.to_string());
        for label in label_ids {
            req = req.query("labelIds", *label);
        }
        self.send_json(req.query_opt("pageToken", page_token)).await
    }

    pub async fn get_thread(&self, id: &str, format: MessageFormat) -> Result<Thread, GmailError> {
        self.send_json(ApiRequest::get(&["threads", id]).query("format", format.as_str()))
            .await
    }

    pub async fn modify_thread(
        &self,
        id: &str,
        add_labels: &[&str],
        remove_labels: &[&str],
    ) -> Result<Thread, GmailError> {
        let body = json!({ "addLabelIds": add_labels, "removeLabelIds": remove_labels });
        self.send_json(ApiRequest::post(&["threads", id, "modify"]).json(body))
            .await
    }

    pub async fn trash_thread(&self, id: &str) -> Result<Thread, GmailError> {
        self.send_json(ApiRequest::post(&["threads", id, "trash"]))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::client::test_support::client_for;
    use serde_json::Value;
    use wiremock::matchers::{body_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn fixture(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[tokio::test]
    async fn list_and_get_thread() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/threads"))
            .and(query_param("labelIds", "INBOX"))
            .and(query_param("maxResults", "100"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(fixture(include_str!("fixtures/threads_list.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/threads/18c3aa00bb11cc22"))
            .and(query_param("format", "full"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(fixture(include_str!("fixtures/thread.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client.list_threads(&["INBOX"], None, 100).await.unwrap();
        assert_eq!(page.threads.len(), 2);
        assert!(page.next_page_token.is_some());

        let thread = client
            .get_thread("18c3aa00bb11cc22", MessageFormat::Full)
            .await
            .unwrap();
        assert!(thread.messages.len() >= 2);
    }

    #[tokio::test]
    async fn modify_and_trash_thread() {
        let server = MockServer::start().await;
        let body = fixture(r#"{"id":"t1","historyId":"9"}"#);
        Mock::given(method("POST"))
            .and(path("/threads/t1/modify"))
            .and(body_json(
                json!({"addLabelIds": [], "removeLabelIds": ["INBOX"]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/threads/t1/trash"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        client.modify_thread("t1", &[], &["INBOX"]).await.unwrap();
        assert_eq!(client.trash_thread("t1").await.unwrap().id, "t1");
    }
}
