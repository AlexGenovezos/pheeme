//! Google People API: the account's contacts and "Other contacts", for recipient suggestions.
//! Needs `contacts.readonly` / `contacts.other.readonly`, and the People API turned on in the
//! user's Google Cloud project. Runs on [`GmailClient`]'s plumbing (bearer, retry, refresh)
//! pointed at the People API root.

use super::client::{ApiRequest, GmailClient, TokenProvider};
use super::error::GmailError;
use serde::Deserialize;
use std::sync::Arc;

pub const PEOPLE_BASE_URL: &str = "https://people.googleapis.com/v1";

/// Largest page either list returns.
const PAGE_SIZE: &str = "1000";

/// Which of the account's contact lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContactList {
    /// The user's own contacts ("My Contacts").
    Saved,
    /// People Gmail saved from mail the user exchanged ("Other contacts").
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Person {
    pub name: Option<String>,
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeoplePage {
    pub people: Vec<Person>,
    pub next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    #[serde(default)]
    connections: Vec<ApiPerson>,
    #[serde(default)]
    other_contacts: Vec<ApiPerson>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiPerson {
    #[serde(default)]
    names: Vec<ApiName>,
    #[serde(default)]
    email_addresses: Vec<ApiEmail>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiName {
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct ApiEmail {
    value: Option<String>,
}

impl From<ApiPerson> for Person {
    fn from(p: ApiPerson) -> Self {
        Person {
            name: p
                .names
                .into_iter()
                .filter_map(|n| n.display_name)
                .map(|n| n.trim().to_owned())
                .find(|n| !n.is_empty()),
            addresses: p
                .email_addresses
                .into_iter()
                .filter_map(|e| e.value)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .collect(),
        }
    }
}

impl GmailClient {
    /// A client for the People API, signed in as the same account.
    pub fn people(tokens: Arc<dyn TokenProvider>) -> Self {
        GmailClient::new(tokens).with_base_url(PEOPLE_BASE_URL)
    }

    /// One page of `list`.
    pub async fn list_people(
        &self,
        list: ContactList,
        page_token: Option<&str>,
    ) -> Result<PeoplePage, GmailError> {
        let req = match list {
            ContactList::Saved => ApiRequest::get(&["people", "me", "connections"])
                .query("personFields", "names,emailAddresses"),
            ContactList::Other => {
                ApiRequest::get(&["otherContacts"]).query("readMask", "names,emailAddresses")
            }
        }
        .query("pageSize", PAGE_SIZE)
        .query_opt("pageToken", page_token);
        let res: ListResponse = self.send_json(req).await?;
        let people = match list {
            ContactList::Saved => res.connections,
            ContactList::Other => res.other_contacts,
        };
        Ok(PeoplePage {
            people: people.into_iter().map(Person::from).collect(),
            next_page_token: res.next_page_token.filter(|t| !t.is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn lists_saved_contacts_with_names_and_addresses() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/people/me/connections"))
            .and(query_param("personFields", "names,emailAddresses"))
            .and(query_param("pageSize", "1000"))
            .and(query_param("pageToken", "p2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "connections": [
                    {"resourceName": "people/1",
                     "names": [{"displayName": "  "}, {"displayName": "Ada Lovelace"}],
                     "emailAddresses": [{"value": "ada@x.com"}, {"value": " "}, {"value": "a@y.org"}]},
                    {"resourceName": "people/2"}
                ],
                "nextPageToken": "p3"
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client
            .list_people(ContactList::Saved, Some("p2"))
            .await
            .unwrap();
        assert_eq!(
            page.people,
            vec![
                Person {
                    name: Some("Ada Lovelace".into()),
                    addresses: vec!["ada@x.com".into(), "a@y.org".into()],
                },
                Person::default(),
            ]
        );
        assert_eq!(page.next_page_token.as_deref(), Some("p3"));
    }

    #[tokio::test]
    async fn lists_other_contacts_and_ends_without_a_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/otherContacts"))
            .and(query_param("readMask", "names,emailAddresses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "otherContacts": [{"emailAddresses": [{"value": "bob@x.com"}]}],
                "nextPageToken": ""
            })))
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);

        let page = client.list_people(ContactList::Other, None).await.unwrap();
        assert_eq!(page.people.len(), 1);
        assert_eq!(page.people[0].addresses, vec!["bob@x.com".to_owned()]);
        assert_eq!(page.next_page_token, None);
    }
}
