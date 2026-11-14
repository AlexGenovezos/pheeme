//! Drive links and new-file uploads. Uses the common Google auth/retry transport; uploads
//! are non-idempotent and never automatically repeated after an ambiguous failure.

use super::client::{ApiRequest, GmailClient, TokenProvider};
use super::GmailError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const DRIVE_BASE_URL: &str = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS: &str = "id,name,mimeType,modifiedTime,size,resourceKey";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub modified_time: Option<String>,
    /// Drive encodes byte sizes as strings; Google documents have no size.
    pub size: Option<String>,
    /// Needed to open some link-shared files. Kept in the link, never discarded.
    pub resource_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrivePage {
    #[serde(default)]
    pub files: Vec<DriveFile>,
    pub next_page_token: Option<String>,
}

fn quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

impl GmailClient {
    pub fn drive(tokens: Arc<dyn TokenProvider>) -> Self {
        Self::new(tokens).with_base_url(DRIVE_BASE_URL)
    }

    pub async fn drive_files(
        &self,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<DrivePage, GmailError> {
        let mut q =
            "trashed = false and mimeType != 'application/vnd.google-apps.folder'".to_owned();
        if !query.trim().is_empty() {
            q.push_str(&format!(" and name contains '{}'", quoted(query.trim())));
        }
        self.send_json(
            ApiRequest::get(&["files"])
                .query("q", q)
                .query("fields", format!("nextPageToken,files({FILE_FIELDS})"))
                .query("pageSize", "50")
                .query("orderBy", "modifiedTime desc")
                .query("spaces", "drive")
                .query("supportsAllDrives", "true")
                .query("includeItemsFromAllDrives", "true")
                .query_opt("pageToken", page_token),
        )
        .await
    }

    /// Save into My Drive. Existing folders need extra write access or the Google Picker;
    /// leaving parents unset lets this work with drive.file and no broad write scope.
    pub async fn upload_drive_file(
        &self,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> Result<DriveFile, GmailError> {
        self.send_json(
            ApiRequest::post(&["files"])
                .query("fields", FILE_FIELDS)
                .upload_file(
                    serde_json::json!({"name": name, "mimeType": mime_type}),
                    bytes,
                )
                .non_idempotent(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn search_escapes_drive_query_and_keeps_resource_keys_and_pagination() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/files"))
            .and(query_param("q", "trashed = false and mimeType != 'application/vnd.google-apps.folder' and name contains 'Alex\\'s \\\\ report'"))
            .and(query_param("pageToken", "next"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "nextPageToken": "more", "files": [{"id":"f1", "name":"Report", "mimeType":"application/pdf", "resourceKey":"key"}]
            })))
            .expect(1)
            .mount(&server).await;
        let (client, _) = client_for(&server);
        let page = client
            .drive_files("Alex's \\ report", Some("next"))
            .await
            .unwrap();
        assert_eq!(page.files[0].resource_key.as_deref(), Some("key"));
        assert_eq!(page.next_page_token.as_deref(), Some("more"));
    }

    #[tokio::test]
    async fn upload_has_metadata_and_bytes_and_never_retries_an_unknown_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/files"))
            .and(query_param("uploadType", "multipart"))
            .and(body_string_contains("\"name\":\"Report.pdf\""))
            .and(body_string_contains("%PDF"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        assert!(client
            .upload_drive_file("Report.pdf", "application/pdf", b"%PDF")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn upload_returns_the_created_file_without_setting_permissions_or_parents() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/files"))
            .and(query_param("uploadType", "multipart"))
            .and(body_string_contains(
                "{\"mimeType\":\"application/pdf\",\"name\":\"Report.pdf\"}",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"id":"new", "name":"Report.pdf", "mimeType":"application/pdf", "size":"4"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let saved = client
            .upload_drive_file("Report.pdf", "application/pdf", b"%PDF")
            .await
            .unwrap();
        assert_eq!(saved.id, "new");
        assert_eq!(saved.size.as_deref(), Some("4"));
        assert!(saved.resource_key.is_none());
    }
}
