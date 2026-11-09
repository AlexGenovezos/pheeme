//! `users.settings.sendAs`: the account's addresses and their signatures. Needs the
//! `gmail.settings.basic` scope.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::{SendAs, SendAsListResponse};

impl GmailClient {
    pub async fn list_send_as(&self) -> Result<Vec<SendAs>, GmailError> {
        let res: SendAsListResponse = self
            .send_json(ApiRequest::get(&["settings", "sendAs"]))
            .await?;
        Ok(res.send_as)
    }
}

#[cfg(test)]
mod tests {
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn list_parses_addresses_and_signatures() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/settings/sendAs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"sendAs": [
                {"sendAsEmail": "me@x.com", "displayName": "Me", "signature": "<b>Me</b>",
                 "isPrimary": true, "isDefault": true, "replyToAddress": ""},
                {"sendAsEmail": "alias@x.com", "treatAsAlias": true}
            ]})))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let list = client.list_send_as().await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].send_as_email, "me@x.com");
        assert_eq!(list[0].signature.as_deref(), Some("<b>Me</b>"));
        assert!(list[0].is_primary && list[0].is_default);
        assert_eq!(list[1].signature, None);
        assert!(!list[1].is_primary);
    }
}
