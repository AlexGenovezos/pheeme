//! `users.getProfile`.

use super::client::{ApiRequest, GmailClient};
use super::error::GmailError;
use super::types::UserProfile;

impl GmailClient {
    /// The account's address and current mailbox `historyId`.
    pub async fn get_profile(&self) -> Result<UserProfile, GmailError> {
        self.send_json(ApiRequest::get(&["profile"])).await
    }
}

#[cfg(test)]
mod tests {
    use crate::gmail::client::test_support::client_for;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_profile_parses_fixture() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/profile"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(include_str!("fixtures/profile.json"), "application/json"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let profile = client.get_profile().await.unwrap();
        assert_eq!(profile.email_address, "alex@example.com");
        assert_eq!(profile.messages_total, 15234);
    }
}
