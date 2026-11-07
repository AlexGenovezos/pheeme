//! `users.labels`: list, get, create, update, delete.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::{Label, LabelColor, LabelListResponse, LabelUpdate};
use reqwest::Method;
use serde_json::json;

impl GmailClient {
    /// All labels. Gmail omits the message/thread counters here; use [`Self::get_label`].
    pub async fn list_labels(&self) -> Result<Vec<Label>, GmailError> {
        let res: LabelListResponse = self.send_json(ApiRequest::get(&["labels"])).await?;
        Ok(res.labels)
    }

    /// One label with its `messages_*` / `threads_*` counters.
    pub async fn get_label(&self, id: &str) -> Result<Label, GmailError> {
        self.send_json(ApiRequest::get(&["labels", id])).await
    }

    pub async fn create_label(
        &self,
        name: &str,
        color: Option<LabelColor>,
    ) -> Result<Label, GmailError> {
        let mut body = json!({
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show",
        });
        if let Some(color) = color {
            body["color"] = json!(color);
        }
        self.send_json(ApiRequest::post(&["labels"]).json(body))
            .await
    }

    /// Partial update (`labels.patch`): only the `Some` fields of `updates` change.
    pub async fn update_label(&self, id: &str, updates: LabelUpdate) -> Result<Label, GmailError> {
        self.send_json(ApiRequest::new(Method::PATCH, &["labels", id]).json(json!(updates)))
            .await
    }

    /// Full replace (`labels.update`, PUT). Sends `id`, `name` and both visibilities, and
    /// `color` only when set, so replacing with `color: None` removes a label's colour.
    pub async fn replace_label(&self, label: &Label) -> Result<Label, GmailError> {
        let mut body = json!({ "id": label.id, "name": label.name });
        if let Some(v) = &label.label_list_visibility {
            body["labelListVisibility"] = json!(v);
        }
        if let Some(v) = &label.message_list_visibility {
            body["messageListVisibility"] = json!(v);
        }
        if let Some(color) = &label.color {
            body["color"] = json!(color);
        }
        self.send_json(ApiRequest::new(Method::PUT, &["labels", &label.id]).json(body))
            .await
    }

    pub async fn delete_label(&self, id: &str) -> Result<(), GmailError> {
        self.send_empty(ApiRequest::new(Method::DELETE, &["labels", id]))
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

    fn fixture(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[tokio::test]
    async fn list_and_get_label() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/labels"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(fixture(include_str!("fixtures/labels.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/labels/INBOX"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(fixture(include_str!("fixtures/label_inbox.json"))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let labels = client.list_labels().await.unwrap();
        assert!(labels
            .iter()
            .any(|l| l.id == "Label_17" && l.name == "Receipts"));
        let inbox = client.get_label("INBOX").await.unwrap();
        assert!(inbox.messages_total.is_some());
    }

    #[tokio::test]
    async fn create_update_delete_label() {
        let server = MockServer::start().await;
        let label = json!({"id": "Label_9", "name": "Work", "type": "user"});
        Mock::given(method("POST"))
            .and(path("/labels"))
            .and(body_json(json!({
                "name": "Work",
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
                "color": {"textColor": "#ffffff", "backgroundColor": "#16a766"},
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(label.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/labels/Label_9"))
            .and(body_json(json!({"name": "Work 2"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(label))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/labels/Label_9"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let color = LabelColor {
            text_color: "#ffffff".into(),
            background_color: "#16a766".into(),
        };
        client.create_label("Work", Some(color)).await.unwrap();
        let update = LabelUpdate {
            name: Some("Work 2".into()),
            ..Default::default()
        };
        client.update_label("Label_9", update).await.unwrap();
        client.delete_label("Label_9").await.unwrap();
    }

    #[tokio::test]
    async fn replace_label_puts_full_body_without_colour() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/labels/Label_9"))
            .and(body_json(json!({
                "id": "Label_9",
                "name": "Work",
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"id": "Label_9", "name": "Work", "type": "user"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let label = Label {
            id: "Label_9".into(),
            name: "Work".into(),
            label_list_visibility: Some("labelShow".into()),
            message_list_visibility: Some("show".into()),
            ..Default::default()
        };
        client.replace_label(&label).await.unwrap();
    }
}
