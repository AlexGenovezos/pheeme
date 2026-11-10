//! Google Tasks API v1: the account's task lists and their tasks. Needs the `tasks` scope
//! (part of [`super::auth::CALENDAR_SCOPES`]) and the Tasks API turned on in the user's Google
//! Cloud project. Runs on [`GmailClient`]'s plumbing (bearer, retry, refresh) pointed at the
//! Tasks API root, as `calendar.rs` does for Calendar.

use super::client::{ApiRequest, GmailClient, TokenProvider};
use super::error::GmailError;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub const TASKS_BASE_URL: &str = "https://tasks.googleapis.com/tasks/v1";

/// Largest page `tasks.list` returns.
const TASKS_PAGE_SIZE: &str = "100";
/// Page size for `tasklists.list`.
const LISTS_PAGE_SIZE: &str = "100";

/// One of the account's task lists.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTaskList {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// RFC 3339.
    pub updated: Option<String>,
    pub etag: Option<String>,
}

/// One task, with the whole resource kept in `raw` for fields not modelled here.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiTask {
    pub id: String,
    pub title: Option<String>,
    pub notes: Option<String>,
    /// `needsAction` or `completed`.
    pub status: Option<String>,
    /// RFC 3339; only the date part means anything (Google Tasks has no due times).
    pub due: Option<String>,
    /// RFC 3339, when it was completed.
    pub completed: Option<String>,
    /// The parent task, for a subtask.
    pub parent: Option<String>,
    /// Sorts the task among its siblings (string order).
    pub position: Option<String>,
    /// RFC 3339.
    pub updated: Option<String>,
    pub deleted: bool,
    /// Completed and cleared from the list's view.
    pub hidden: bool,
    pub etag: Option<String>,
    pub web_view_link: Option<String>,
    pub raw: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFields {
    id: String,
    title: Option<String>,
    notes: Option<String>,
    status: Option<String>,
    due: Option<String>,
    completed: Option<String>,
    parent: Option<String>,
    position: Option<String>,
    updated: Option<String>,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    hidden: bool,
    etag: Option<String>,
    web_view_link: Option<String>,
}

impl TryFrom<Value> for ApiTask {
    type Error = GmailError;

    fn try_from(raw: Value) -> Result<Self, GmailError> {
        let f: TaskFields = serde_json::from_value(raw.clone())
            .map_err(|e| GmailError::Decode(format!("unexpected Google task: {e}")))?;
        Ok(ApiTask {
            id: f.id,
            title: f.title,
            notes: f.notes,
            status: f.status,
            due: f.due,
            completed: f.completed,
            parent: f.parent,
            position: f.position,
            updated: f.updated,
            deleted: f.deleted,
            hidden: f.hidden,
            etag: f.etag,
            web_view_link: f.web_view_link,
            raw,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskListsPage {
    pub items: Vec<ApiTaskList>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TasksPage {
    pub items: Vec<ApiTask>,
    pub next_page_token: Option<String>,
}

/// Which tasks `tasks.list` returns. Completed and hidden tasks always come too.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TasksQuery<'a> {
    /// Only tasks changed at or after this time (RFC 3339): an incremental sync.
    pub updated_min: Option<&'a str>,
    /// Include deleted tasks (`deleted: true`), so an incremental sync sees deletions.
    pub show_deleted: bool,
    pub page_token: Option<&'a str>,
}

/// Where a task goes among its list's tasks: under `parent` (a top-level task when `None`),
/// right after `previous` (first when `None`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaskPlacement<'a> {
    pub parent: Option<&'a str>,
    pub previous: Option<&'a str>,
}

impl TaskPlacement<'_> {
    fn apply(&self, req: ApiRequest) -> ApiRequest {
        req.query_opt("parent", self.parent)
            .query_opt("previous", self.previous)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListsResponse {
    #[serde(default)]
    items: Vec<ApiTaskList>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksResponse {
    #[serde(default)]
    items: Vec<Value>,
    next_page_token: Option<String>,
}

fn non_empty(token: Option<String>) -> Option<String> {
    token.filter(|t| !t.is_empty())
}

/// A delete of something already gone (404 or 410) counts as done.
fn already_gone(result: Result<(), GmailError>) -> Result<(), GmailError> {
    match result {
        Err(e) if e.is_not_found() || e.is_gone() => Ok(()),
        other => other,
    }
}

impl GmailClient {
    /// A client for the Tasks API, signed in as the same account.
    pub fn tasks(tokens: Arc<dyn TokenProvider>) -> Self {
        GmailClient::new(tokens).with_base_url(TASKS_BASE_URL)
    }

    /// One page of the account's task lists, in Google's order.
    pub async fn list_task_lists(
        &self,
        page_token: Option<&str>,
    ) -> Result<TaskListsPage, GmailError> {
        let req = ApiRequest::get(&["users", "@me", "lists"])
            .query("maxResults", LISTS_PAGE_SIZE)
            .query_opt("pageToken", page_token);
        let res: ListsResponse = self.send_json(req).await?;
        Ok(TaskListsPage {
            items: res.items,
            next_page_token: non_empty(res.next_page_token),
        })
    }

    /// Create a task list. Never re-sent when its outcome is unknown: it has no id of ours,
    /// so a second attempt would make a second list.
    pub async fn insert_task_list(&self, title: &str) -> Result<ApiTaskList, GmailError> {
        let req = ApiRequest::post(&["users", "@me", "lists"])
            .json(serde_json::json!({ "title": title }))
            .non_idempotent();
        self.send_json(req).await
    }

    pub async fn patch_task_list(
        &self,
        list_id: &str,
        title: &str,
    ) -> Result<ApiTaskList, GmailError> {
        let req = ApiRequest::patch(&["users", "@me", "lists", list_id])
            .json(serde_json::json!({ "title": title }));
        self.send_json(req).await
    }

    /// Delete a task list with its tasks; one already gone counts as deleted.
    pub async fn delete_task_list(&self, list_id: &str) -> Result<(), GmailError> {
        let req = ApiRequest::delete(&["users", "@me", "lists", list_id]);
        already_gone(self.send_empty(req).await)
    }

    /// One page of a list's tasks, completed and hidden ones included.
    pub async fn list_tasks(
        &self,
        list_id: &str,
        query: TasksQuery<'_>,
    ) -> Result<TasksPage, GmailError> {
        let req = ApiRequest::get(&["lists", list_id, "tasks"])
            .query("maxResults", TASKS_PAGE_SIZE)
            .query("showCompleted", "true")
            .query("showHidden", "true")
            .query(
                "showDeleted",
                if query.show_deleted { "true" } else { "false" },
            )
            .query_opt("updatedMin", query.updated_min)
            .query_opt("pageToken", query.page_token);
        let res: TasksResponse = self.send_json(req).await?;
        Ok(TasksPage {
            items: res
                .items
                .into_iter()
                .map(ApiTask::try_from)
                .collect::<Result<_, _>>()?,
            next_page_token: non_empty(res.next_page_token),
        })
    }

    /// Create a task at `placement`. Never re-sent when its outcome is unknown: Google makes
    /// the id, so a second attempt would make a second task.
    pub async fn insert_task(
        &self,
        list_id: &str,
        body: Value,
        placement: TaskPlacement<'_>,
    ) -> Result<ApiTask, GmailError> {
        let req = placement
            .apply(ApiRequest::post(&["lists", list_id, "tasks"]))
            .json(body)
            .non_idempotent();
        ApiTask::try_from(self.send_json::<Value>(req).await?)
    }

    pub async fn patch_task(
        &self,
        list_id: &str,
        task_id: &str,
        body: Value,
    ) -> Result<ApiTask, GmailError> {
        let req = ApiRequest::patch(&["lists", list_id, "tasks", task_id]).json(body);
        ApiTask::try_from(self.send_json::<Value>(req).await?)
    }

    /// Delete a task; one already gone counts as deleted.
    pub async fn delete_task(&self, list_id: &str, task_id: &str) -> Result<(), GmailError> {
        let req = ApiRequest::delete(&["lists", list_id, "tasks", task_id]);
        already_gone(self.send_empty(req).await)
    }

    /// Move a task within its list (`placement`), or to the top of `destination`. A move to
    /// another list is never re-sent when its outcome is unknown.
    pub async fn move_task(
        &self,
        list_id: &str,
        task_id: &str,
        placement: TaskPlacement<'_>,
        destination: Option<&str>,
    ) -> Result<ApiTask, GmailError> {
        let mut req = placement
            .apply(ApiRequest::post(&[
                "lists", list_id, "tasks", task_id, "move",
            ]))
            .query_opt("destinationTasklist", destination);
        if destination.is_some() {
            req = req.non_idempotent();
        }
        ApiTask::try_from(self.send_json::<Value>(req).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::{TaskPlacement, TasksQuery};
    use crate::gmail::client::test_support::client_for;
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn task_json(id: &str) -> serde_json::Value {
        json!({"id": id, "etag": "\"t2\"", "title": "Buy milk", "status": "needsAction",
               "updated": "2026-11-09T10:00:00.000Z", "position": "00000000000000000000"})
    }

    #[tokio::test]
    async fn lists_task_lists() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/@me/lists"))
            .and(query_param("maxResults", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "tasks#taskLists", "nextPageToken": "n2",
                "items": [{"kind": "tasks#taskList", "id": "L1", "title": "My Tasks",
                           "etag": "\"l1\"", "updated": "2026-11-09T10:00:00.000Z"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client.list_task_lists(None).await.unwrap();
        assert_eq!(page.next_page_token.as_deref(), Some("n2"));
        assert_eq!(page.items[0].id, "L1");
        assert_eq!(page.items[0].title, "My Tasks");
        assert_eq!(page.items[0].etag.as_deref(), Some("\"l1\""));
    }

    #[tokio::test]
    async fn incremental_list_sends_updated_min_and_parses_every_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/lists/L1/tasks"))
            .and(query_param("maxResults", "100"))
            .and(query_param("showCompleted", "true"))
            .and(query_param("showHidden", "true"))
            .and(query_param("showDeleted", "true"))
            .and(query_param("updatedMin", "2026-11-09T09:00:00.000Z"))
            .and(query_param("pageToken", "p2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {"id": "t1", "title": "Call Sam", "notes": "About the lease",
                     "status": "needsAction", "due": "2026-11-12T00:00:00.000Z",
                     "position": "00000000000000000001", "updated": "2026-11-09T10:00:00.000Z",
                     "etag": "\"a\"", "webViewLink": "https://tasks.google.com/task/x",
                     "links": [{"type": "email", "link": "https://mail.google.com/x"}]},
                    {"id": "t2", "title": "Sub", "parent": "t1", "status": "completed",
                     "completed": "2026-11-09T11:00:00.000Z", "hidden": true,
                     "position": "00000000000000000000", "updated": "2026-11-09T11:00:00.000Z",
                     "etag": "\"b\""},
                    {"id": "t3", "deleted": true, "updated": "2026-11-09T12:00:00.000Z",
                     "etag": "\"c\""}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client
            .list_tasks(
                "L1",
                TasksQuery {
                    updated_min: Some("2026-11-09T09:00:00.000Z"),
                    show_deleted: true,
                    page_token: Some("p2"),
                },
            )
            .await
            .unwrap();
        assert_eq!(page.next_page_token, None);
        let t1 = &page.items[0];
        assert_eq!(t1.notes.as_deref(), Some("About the lease"));
        assert_eq!(t1.due.as_deref(), Some("2026-11-12T00:00:00.000Z"));
        assert_eq!(
            t1.web_view_link.as_deref(),
            Some("https://tasks.google.com/task/x")
        );
        assert_eq!(t1.raw["links"][0]["type"], "email");
        let t2 = &page.items[1];
        assert_eq!(t2.parent.as_deref(), Some("t1"));
        assert!(t2.hidden);
        assert_eq!(t2.status.as_deref(), Some("completed"));
        assert!(page.items[2].deleted);
    }

    #[tokio::test]
    async fn full_list_sends_no_updated_min() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/lists/L1/tasks"))
            .and(query_param("showDeleted", "false"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let page = client
            .list_tasks("L1", TasksQuery::default())
            .await
            .unwrap();
        assert!(page.items.is_empty());
        let requests = server.received_requests().await.unwrap();
        let query = requests[0].url.query().unwrap_or_default();
        assert!(!query.contains("updatedMin"), "{query}");
        assert!(!query.contains("pageToken"), "{query}");
    }

    #[tokio::test]
    async fn insert_sends_placement_and_is_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/lists/L1/tasks"))
            .and(query_param("parent", "p"))
            .and(query_param("previous", "s"))
            .and(body_json(json!({"title": "Buy milk"})))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .insert_task(
                "L1",
                json!({"title": "Buy milk"}),
                TaskPlacement {
                    parent: Some("p"),
                    previous: Some("s"),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn patch_returns_the_task() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/lists/L1/tasks/t1"))
            .and(body_json(json!({"status": "completed"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(task_json("t1")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        let task = client
            .patch_task("L1", "t1", json!({"status": "completed"}))
            .await
            .unwrap();
        assert_eq!(task.etag.as_deref(), Some("\"t2\""));
    }

    #[tokio::test]
    async fn deletes_treat_gone_as_done() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/lists/L1/tasks/t1"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/users/@me/lists/L1"))
            .respond_with(ResponseTemplate::new(410))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client.delete_task("L1", "t1").await.unwrap();
        client.delete_task_list("L1").await.unwrap();
    }

    #[tokio::test]
    async fn move_sends_parent_previous_and_destination() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/lists/L1/tasks/t1/move"))
            .and(query_param("parent", "p"))
            .and(query_param("previous", "s"))
            .respond_with(ResponseTemplate::new(200).set_body_json(task_json("t1")))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/lists/L1/tasks/t2/move"))
            .and(query_param("destinationTasklist", "L2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(task_json("t9")))
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        client
            .move_task(
                "L1",
                "t1",
                TaskPlacement {
                    parent: Some("p"),
                    previous: Some("s"),
                },
                None,
            )
            .await
            .unwrap();
        let moved = client
            .move_task("L1", "t2", TaskPlacement::default(), Some("L2"))
            .await
            .unwrap();
        assert_eq!(moved.id, "t9");
        let requests = server.received_requests().await.unwrap();
        let first = requests[0].url.query().unwrap_or_default();
        assert!(!first.contains("destinationTasklist"), "{first}");
    }

    #[tokio::test]
    async fn task_list_writes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/users/@me/lists"))
            .and(body_json(json!({"title": "Errands"})))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"id": "L2", "title": "Errands"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/users/@me/lists/L2"))
            .and(body_json(json!({"title": "Shopping"})))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"id": "L2", "title": "Shopping"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (client, _) = client_for(&server);
        assert_eq!(client.insert_task_list("Errands").await.unwrap().id, "L2");
        assert_eq!(
            client
                .patch_task_list("L2", "Shopping")
                .await
                .unwrap()
                .title,
            "Shopping"
        );
    }
}
