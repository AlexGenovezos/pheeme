//! `users.settings.filters`: list, create, delete. Needs the `gmail.settings.basic` scope.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::{Filter, FilterListResponse};
use reqwest::Method;
use serde_json::json;

impl GmailClient {
    pub async fn list_filters(&self) -> Result<Vec<Filter>, GmailError> {
        let res: FilterListResponse = self
            .send_json(ApiRequest::get(&["settings", "filters"]))
            .await?;
        Ok(res.filter)
    }

    /// Not retried when the outcome is unknown: Gmail may already have created it.
    pub async fn create_filter(&self, filter: &Filter) -> Result<Filter, GmailError> {
        let body = json!({ "criteria": filter.criteria, "action": filter.action });
        self.send_json(
            ApiRequest::post(&["settings", "filters"])
                .json(body)
                .non_idempotent(),
        )
        .await
    }

    pub async fn delete_filter(&self, id: &str) -> Result<(), GmailError> {
        self.send_empty(ApiRequest::new(
            Method::DELETE,
            &["settings", "filters", id],
        ))
        .await
    }
}

#[cfg(test)]
mod tests {
    use crate::gmail::client::test_support::client_for;
    use crate::gmail::types::{Filter, FilterAction, FilterCriteria};
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn rule(from: &str, label: &str) -> Filter {
        Filter {
            id: None,
            criteria: FilterCriteria {
                from: Some(from.into()),
                ..Default::default()
            },
            action: FilterAction {
                add_label_ids: vec![label.into()],
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn list_parses_filters_and_an_empty_answer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/settings/filters"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"filter": [
                {"id": "f1", "criteria": {"from": "a@x.com"}, "action": {"addLabelIds": ["CATEGORY_UPDATES"]}},
                {"id": "f2", "criteria": {"subject": "hi"}, "action": {"forward": "b@y.com"}}
            ]})))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/settings/filters"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let filters = client.list_filters().await.unwrap();
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0].id.as_deref(), Some("f1"));
        assert_eq!(filters[0].criteria.from.as_deref(), Some("a@x.com"));
        assert_eq!(filters[0].action.add_label_ids, ["CATEGORY_UPDATES"]);
        assert!(filters[1].criteria.other.contains_key("subject"));
        assert_eq!(filters[1].action.forward.as_deref(), Some("b@y.com"));
        assert!(client.list_filters().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_sends_only_criteria_and_action_and_is_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/settings/filters"))
            .and(body_json(json!({
                "criteria": {"from": "a@x.com"},
                "action": {"addLabelIds": ["CATEGORY_UPDATES"]}
            })))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let mut filter = rule("a@x.com", "CATEGORY_UPDATES");
        filter.id = Some("ignored".into());
        assert!(client.create_filter(&filter).await.is_err());
    }

    #[tokio::test]
    async fn create_returns_the_new_filter_and_delete_targets_its_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/settings/filters"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "f9", "criteria": {"from": "a@x.com"}, "action": {"addLabelIds": ["CATEGORY_SOCIAL"]}
            })))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/settings/filters/f9"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let created = client
            .create_filter(&rule("a@x.com", "CATEGORY_SOCIAL"))
            .await
            .unwrap();
        assert_eq!(created.id.as_deref(), Some("f9"));
        client.delete_filter("f9").await.unwrap();
    }
}
