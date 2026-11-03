//! `users.history.list`, the incremental-sync feed.

use super::client::{ApiRequest, GmailClient};
use super::error::{GmailError, HISTORY_EXPIRED_REASON};
use super::types::HistoryListResponse;

impl GmailClient {
    /// One page of changes after `start_history_id`.
    ///
    /// Gmail answers 404 when it no longer keeps history that far back (about a week). The
    /// mailbox itself always exists, so any 404 here is stamped with a reason that makes
    /// [`GmailError::is_history_expired`] true, and the sync engine falls back to a full re-sync.
    pub async fn list_history(
        &self,
        start_history_id: &str,
        label_id: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<HistoryListResponse, GmailError> {
        let req = ApiRequest::get(&["history"])
            .query("startHistoryId", start_history_id)
            .query_opt("labelId", label_id)
            .query_opt("pageToken", page_token);
        self.send_json(req).await.map_err(|e| match e {
            GmailError::Api {
                status: 404,
                message,
                ..
            } => GmailError::Api {
                status: 404,
                reason: Some(HISTORY_EXPIRED_REASON.to_owned()),
                message,
            },
            other => other,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::gmail::client::test_support::client_for;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn parses_history_page() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/history"))
            .and(query_param("startHistoryId", "1204800"))
            .and(query_param("labelId", "INBOX"))
            .and(query_param("pageToken", "p1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(include_str!("fixtures/history.json"), "application/json"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client
            .list_history("1204800", Some("INBOX"), Some("p1"))
            .await
            .unwrap();
        assert_eq!(page.history.len(), 4);
        assert_eq!(page.history_id.as_deref(), Some("1204850"));
        assert_eq!(page.next_page_token.as_deref(), Some("history-page-2"));
        assert_eq!(
            page.history[0].messages_added[0].message.id,
            "18c3aa00bb11cc40"
        );
        assert_eq!(page.history[1].labels_added[0].label_ids, ["STARRED"]);
        assert_eq!(page.history[2].labels_removed[0].label_ids, ["INBOX"]);
        assert_eq!(
            page.history[3].messages_deleted[0].message.id,
            "18c3aa00bb11cc31"
        );
    }

    #[tokio::test]
    async fn nothing_new_has_no_history_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/history"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                include_str!("fixtures/history_empty.json"),
                "application/json",
            ))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client.list_history("1", None, None).await.unwrap();
        assert!(page.history.is_empty() && page.history_id.is_some());
    }

    #[tokio::test]
    async fn invalid_start_history_id_is_history_expired() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/history"))
            .respond_with(ResponseTemplate::new(404).set_body_raw(
                include_str!("fixtures/error_start_history_id.json"),
                "application/json",
            ))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client.list_history("12", None, None).await.unwrap_err();
        assert!(err.is_history_expired(), "{err:?}");
        assert_eq!(err.code(), "history_expired");
    }

    #[tokio::test]
    async fn plain_not_found_on_history_is_also_expired() {
        // Real Gmail often answers an aged-out id with a bare "notFound".
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/history"))
            .respond_with(ResponseTemplate::new(404).set_body_raw(
                include_str!("fixtures/error_history_expired.json"),
                "application/json",
            ))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let err = client.list_history("12", None, None).await.unwrap_err();
        assert!(err.is_history_expired(), "{err:?}");
    }
}
