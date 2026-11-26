//! `users.settings.vacation`: the account's vacation responder (Gmail's out-of-office auto
//! reply). Read with `getVacation`, replaced whole with `updateVacation`. Needs the
//! `gmail.settings.basic` scope.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use reqwest::Method;
use serde::{Deserialize, Serialize};

/// Gmail's `VacationSettings`, as the API sends and takes it. The times are epoch
/// milliseconds as decimal strings (Gmail's int64 encoding).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VacationSettings {
    pub enable_auto_reply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body_plain_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body_html: Option<String>,
    pub restrict_to_contacts: bool,
    /// Workspace accounts only; Gmail refuses it for a personal account.
    pub restrict_to_domain: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
}

impl GmailClient {
    pub async fn get_vacation(&self) -> Result<VacationSettings, GmailError> {
        self.send_json(ApiRequest::get(&["settings", "vacation"]))
            .await
    }

    /// Replaces the whole responder (a `PUT`, so a retry after an unknown outcome is safe).
    pub async fn update_vacation(
        &self,
        settings: &VacationSettings,
    ) -> Result<VacationSettings, GmailError> {
        let body = serde_json::to_value(settings).map_err(|e| GmailError::Decode(e.to_string()))?;
        self.send_json(ApiRequest::new(Method::PUT, &["settings", "vacation"]).json(body))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::VacationSettings;
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_parses_gmails_answer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/settings/vacation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "enableAutoReply": true,
                "responseSubject": "Away",
                "responseBodyHtml": "<p>Back <b>Monday</b></p>",
                "restrictToContacts": true,
                "startTime": "1764633600000",
                "endTime": "1765238400000"
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let got = client.get_vacation().await.unwrap();
        assert!(got.enable_auto_reply);
        assert_eq!(got.response_subject.as_deref(), Some("Away"));
        assert_eq!(
            got.response_body_html.as_deref(),
            Some("<p>Back <b>Monday</b></p>")
        );
        assert_eq!(got.response_body_plain_text, None);
        assert!(got.restrict_to_contacts && !got.restrict_to_domain);
        assert_eq!(got.start_time.as_deref(), Some("1764633600000"));
        assert_eq!(got.end_time.as_deref(), Some("1765238400000"));
    }

    #[tokio::test]
    async fn an_untouched_responder_reads_as_off() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/settings/vacation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        assert_eq!(
            client.get_vacation().await.unwrap(),
            VacationSettings::default()
        );
    }

    #[tokio::test]
    async fn update_puts_the_whole_responder_and_leaves_out_what_is_unset() {
        let server = MockServer::start().await;
        let sent = json!({
            "enableAutoReply": true,
            "responseSubject": "Out",
            "responseBodyHtml": "<p>Hi</p>",
            "restrictToContacts": false,
            "restrictToDomain": false,
            "startTime": "1764633600000"
        });
        Mock::given(method("PUT"))
            .and(path("/settings/vacation"))
            .and(body_json(&sent))
            .respond_with(ResponseTemplate::new(200).set_body_json(&sent))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let settings = VacationSettings {
            enable_auto_reply: true,
            response_subject: Some("Out".into()),
            response_body_html: Some("<p>Hi</p>".into()),
            start_time: Some("1764633600000".into()),
            ..Default::default()
        };
        let answer = client.update_vacation(&settings).await.unwrap();
        assert_eq!(answer, settings);
    }
}
