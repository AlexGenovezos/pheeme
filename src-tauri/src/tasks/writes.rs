//! Tasks writes: add, edit, complete, delete, reorder, indent and move tasks, and create,
//! rename and delete lists. Each goes straight to the Tasks API (not the mail outbox) and
//! reaches the cache only once Google confirms it (design §6.1).

use super::convert;
use super::error::TasksError;
use super::service::TasksService;
use crate::db;
use crate::db::tasks::{DbTask, DbTaskList};
use crate::gmail::tasks::{ApiTask, TaskPlacement};
use crate::gmail::GmailError;
use crate::sync::SyncEvent;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Google's limits on a task's title and notes, and a list's title.
const MAX_TITLE: usize = 1024;
const MAX_NOTES: usize = 8192;

/// Changes to a task: an omitted (or null) field stays as it is; `""` clears notes or the due
/// date (a title can be blank).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    pub title: Option<String>,
    pub notes: Option<String>,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
}

/// Where a written task lives, returned by commands so the UI can select it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    pub account_id: String,
    pub list_id: String,
    pub id: String,
}

/// A written task list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListRef {
    pub account_id: String,
    pub list_id: String,
}

fn too_long(text: &str, max: usize) -> bool {
    text.chars().count() > max
}

/// The patch body an edit makes, checked first.
fn body(edit: &TaskEdit) -> Result<Map<String, Value>, TasksError> {
    let mut body = Map::new();
    if let Some(title) = &edit.title {
        if too_long(title, MAX_TITLE) {
            return Err(TasksError::Invalid("That title is too long.".into()));
        }
        body.insert("title".into(), json!(title));
    }
    if let Some(notes) = &edit.notes {
        if too_long(notes, MAX_NOTES) {
            return Err(TasksError::Invalid("Those details are too long.".into()));
        }
        let notes = (!notes.is_empty()).then(|| notes.clone());
        body.insert("notes".into(), json!(notes));
    }
    if let Some(due) = &edit.due {
        let due = match due.as_str() {
            "" => Value::Null,
            d => {
                let date = NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| {
                    TasksError::Invalid("The due date must be a date like 2026-11-12.".into())
                })?;
                json!(convert::due_time(&date))
            }
        };
        body.insert("due".into(), due);
    }
    Ok(body)
}

fn list_title(title: &str) -> Result<&str, TasksError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(TasksError::Invalid("A list needs a name.".into()));
    }
    if too_long(title, MAX_TITLE) {
        return Err(TasksError::Invalid("That name is too long.".into()));
    }
    Ok(title)
}

impl TasksService {
    async fn list(&self, account_id: &str, list_id: &str) -> Result<DbTaskList, TasksError> {
        db::tasks::task_lists(&self.db, Some(account_id))
            .await?
            .into_iter()
            .find(|l| l.id == list_id)
            .ok_or(TasksError::ListNotFound)
    }

    async fn stored(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
    ) -> Result<DbTask, TasksError> {
        db::tasks::task(&self.db, account_id, list_id, task_id)
            .await?
            .ok_or(TasksError::TaskNotFound)
    }

    /// Checks a placement against the cache: `parent` is a top-level task of the list (Google
    /// Tasks nests one level deep), and `previous` is a task under that same parent. `moving`
    /// is the task being moved, which can't be placed under or after itself, nor become a
    /// subtask while it has subtasks of its own.
    async fn check_placement(
        &self,
        account_id: &str,
        list_id: &str,
        moving: Option<&str>,
        parent: Option<&str>,
        previous: Option<&str>,
    ) -> Result<(), TasksError> {
        let invalid = |m: &str| Err(TasksError::Invalid(m.into()));
        if let Some(p) = parent {
            if moving == Some(p) {
                return invalid("A task can't be its own subtask.");
            }
            let parent = self.stored(account_id, list_id, p).await?;
            if parent.parent.is_some() {
                return invalid("Subtasks can't have subtasks of their own.");
            }
            if let Some(id) = moving {
                let rows = db::tasks::tasks(&self.db, account_id, list_id).await?;
                if rows.iter().any(|t| t.parent.as_deref() == Some(id)) {
                    return invalid("A task with subtasks can't become a subtask.");
                }
            }
        }
        if let Some(prev) = previous {
            if moving == Some(prev) {
                return invalid("A task can't go after itself.");
            }
            let previous = self.stored(account_id, list_id, prev).await?;
            if previous.parent.as_deref() != parent {
                return invalid("That task isn't next to this one.");
            }
        }
        Ok(())
    }

    /// Turns Google's answer into the command's. A write whose outcome is unknown, or that
    /// found nothing, asks for a sync so the panel soon shows what Google has.
    fn settle<T>(
        &self,
        account_id: &str,
        result: Result<T, GmailError>,
        missing: TasksError,
    ) -> Result<T, TasksError> {
        match result.map_err(TasksError::from) {
            Err(TasksError::TaskNotFound) => {
                self.trigger(Some(account_id.to_owned()));
                Err(missing)
            }
            Err(e @ TasksError::Unconfirmed) => {
                self.trigger(Some(account_id.to_owned()));
                Err(e)
            }
            other => other,
        }
    }

    /// Tells the UI the account's tasks changed and asks for a sync soon.
    fn changed(&self, account_id: &str) {
        self.events.emit(SyncEvent::TasksUpdated {
            account_id: account_id.to_owned(),
        });
        self.trigger(Some(account_id.to_owned()));
    }

    /// Caches Google's confirmed version of a task.
    async fn save(
        &self,
        account_id: &str,
        list_id: &str,
        task: &ApiTask,
    ) -> Result<TaskRef, TasksError> {
        let row = convert::task(account_id, list_id, task);
        db::tasks::apply_task_changes(&self.db, account_id, list_id, &[row], &[], None).await?;
        self.changed(account_id);
        Ok(TaskRef {
            account_id: account_id.to_owned(),
            list_id: list_id.to_owned(),
            id: task.id.clone(),
        })
    }

    /// Adds a task to a list, under `parent` (top level when `None`), right after `previous`
    /// (first when `None`).
    pub async fn create_task(
        &self,
        account_id: &str,
        list_id: &str,
        edit: TaskEdit,
        parent: Option<String>,
        previous: Option<String>,
    ) -> Result<TaskRef, TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.list(account_id, list_id).await?;
        let (parent, previous) = (parent.as_deref(), previous.as_deref());
        self.check_placement(account_id, list_id, None, parent, previous)
            .await?;
        let mut body = body(&edit)?;
        body.retain(|_, v| !v.is_null());
        let api = (self.api_for)(account_id);
        let result = api
            .insert_task(
                list_id,
                Value::Object(body),
                TaskPlacement { parent, previous },
            )
            .await;
        let task = self.settle(account_id, result, TasksError::ListNotFound)?;
        self.save(account_id, list_id, &task).await
    }

    /// Changes a task's title, details or due date.
    pub async fn update_task(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
        edit: TaskEdit,
    ) -> Result<TaskRef, TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.stored(account_id, list_id, task_id).await?;
        let body = body(&edit)?;
        self.patch(account_id, list_id, task_id, body).await
    }

    /// Ticks a task off, or back on.
    pub async fn set_task_completed(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
        completed: bool,
    ) -> Result<TaskRef, TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.stored(account_id, list_id, task_id).await?;
        let body = if completed {
            json!({"status": "completed"})
        } else {
            json!({"status": "needsAction", "completed": null})
        };
        let Value::Object(body) = body else {
            unreachable!("a JSON object")
        };
        self.patch(account_id, list_id, task_id, body).await
    }

    async fn patch(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
        body: Map<String, Value>,
    ) -> Result<TaskRef, TasksError> {
        if body.is_empty() {
            return Ok(TaskRef {
                account_id: account_id.to_owned(),
                list_id: list_id.to_owned(),
                id: task_id.to_owned(),
            });
        }
        let api = (self.api_for)(account_id);
        let result = api.patch_task(list_id, task_id, Value::Object(body)).await;
        let task = self.settle(account_id, result, TasksError::TaskNotFound)?;
        self.save(account_id, list_id, &task).await
    }

    /// Deletes a task with its subtasks.
    pub async fn delete_task(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
    ) -> Result<(), TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.stored(account_id, list_id, task_id).await?;
        let api = (self.api_for)(account_id);
        let result = api.delete_task(list_id, task_id).await;
        self.settle(account_id, result, TasksError::TaskNotFound)?;
        db::tasks::remove_task_with_subtasks(&self.db, account_id, list_id, task_id).await?;
        // Read the list in full next, in case Google kept a subtask after all.
        db::tasks::needs_full_sync(&self.db, account_id, list_id).await?;
        self.changed(account_id);
        Ok(())
    }

    /// Moves a task within its list: reorder (`previous`), indent (`parent` set) or outdent
    /// (`parent` cleared). Its subtasks go with it.
    pub async fn move_task(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
        parent: Option<String>,
        previous: Option<String>,
    ) -> Result<TaskRef, TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.stored(account_id, list_id, task_id).await?;
        let (parent, previous) = (parent.as_deref(), previous.as_deref());
        self.check_placement(account_id, list_id, Some(task_id), parent, previous)
            .await?;
        let api = (self.api_for)(account_id);
        let result = api
            .move_task(list_id, task_id, TaskPlacement { parent, previous }, None)
            .await;
        let task = self.settle(account_id, result, TasksError::TaskNotFound)?;
        self.save(account_id, list_id, &task).await
    }

    /// Moves a task (with its subtasks) to the top of another list of the same account.
    pub async fn move_task_to_list(
        &self,
        account_id: &str,
        list_id: &str,
        task_id: &str,
        destination_list_id: &str,
    ) -> Result<TaskRef, TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.stored(account_id, list_id, task_id).await?;
        self.list(account_id, destination_list_id).await?;
        if destination_list_id == list_id {
            return Err(TasksError::Invalid(
                "The task is already in that list.".into(),
            ));
        }
        let api = (self.api_for)(account_id);
        let result = api
            .move_task(
                list_id,
                task_id,
                TaskPlacement::default(),
                Some(destination_list_id),
            )
            .await;
        let task = self.settle(account_id, result, TasksError::TaskNotFound)?;
        db::tasks::remove_task_with_subtasks(&self.db, account_id, list_id, task_id).await?;
        // Both lists are read in full next: the subtasks arrive in the destination.
        for list in [list_id, destination_list_id] {
            db::tasks::needs_full_sync(&self.db, account_id, list).await?;
        }
        self.save(account_id, destination_list_id, &task).await
    }

    /// Creates a task list (it goes last).
    pub async fn create_task_list(
        &self,
        account_id: &str,
        title: &str,
    ) -> Result<TaskListRef, TasksError> {
        let title = list_title(title)?;
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        let api = (self.api_for)(account_id);
        let result = api.insert_task_list(title).await;
        let list = self.settle(account_id, result, TasksError::ListNotFound)?;
        db::tasks::save_task_list(&self.db, account_id, &convert::task_list(&list)).await?;
        self.changed(account_id);
        Ok(TaskListRef {
            account_id: account_id.to_owned(),
            list_id: list.id,
        })
    }

    pub async fn rename_task_list(
        &self,
        account_id: &str,
        list_id: &str,
        title: &str,
    ) -> Result<TaskListRef, TasksError> {
        let title = list_title(title)?;
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.list(account_id, list_id).await?;
        let api = (self.api_for)(account_id);
        let result = api.patch_task_list(list_id, title).await;
        let list = self.settle(account_id, result, TasksError::ListNotFound)?;
        db::tasks::save_task_list(&self.db, account_id, &convert::task_list(&list)).await?;
        self.changed(account_id);
        Ok(TaskListRef {
            account_id: account_id.to_owned(),
            list_id: list.id,
        })
    }

    /// Deletes a task list with all its tasks.
    pub async fn delete_task_list(
        &self,
        account_id: &str,
        list_id: &str,
    ) -> Result<(), TasksError> {
        let gate = self.gate(account_id);
        let _held = gate.lock().await;
        self.list(account_id, list_id).await?;
        let api = (self.api_for)(account_id);
        let result = api.delete_task_list(list_id).await;
        self.settle(account_id, result, TasksError::ListNotFound)?;
        db::tasks::delete_task_list(&self.db, account_id, list_id).await?;
        self.changed(account_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::fake::task;
    use crate::tasks::service::tests::harness;

    fn edit(title: &str) -> TaskEdit {
        TaskEdit {
            title: Some(title.into()),
            ..TaskEdit::default()
        }
    }

    fn offline() -> GmailError {
        GmailError::Offline("no network".into())
    }

    /// (title, parent title) in the cached outline.
    async fn outline(
        h: &crate::tasks::service::tests::Harness,
        list: &str,
    ) -> Vec<(String, Option<String>)> {
        let tasks = h.service.tasks("a", list).await.unwrap();
        let title_of = |id: &str| tasks.iter().find(|t| t.id == id).map(|t| t.title.clone());
        tasks
            .iter()
            .map(|t| (t.title.clone(), t.parent.as_deref().and_then(title_of)))
            .collect()
    }

    fn row(title: &str, parent: Option<&str>) -> (String, Option<String>) {
        (title.into(), parent.map(str::to_owned))
    }

    #[tokio::test]
    async fn adds_tasks_at_the_top_after_a_task_and_as_subtasks() {
        let h = harness(&["a"]).await;
        h.fake("a").put("L", task("milk", "Milk"));
        h.grant("a").await;

        let first = h
            .service
            .create_task(
                "a",
                "L",
                TaskEdit {
                    title: Some("Bread".into()),
                    notes: Some("Rye".into()),
                    due: Some("2026-11-12".into()),
                },
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(h.events.names(), vec!["tasks:updated"]);
        assert!(h.service.is_forced("a"), "a sync follows the write");
        let cached = h.service.tasks("a", "L").await.unwrap();
        let bread = cached.iter().find(|t| t.id == first.id).unwrap();
        assert_eq!(bread.notes.as_deref(), Some("Rye"));
        assert_eq!(bread.due.as_deref(), Some("2026-11-12"));
        let sent = &h.fake("a").writes()[0];
        assert_eq!(sent.body["due"], "2026-11-12T00:00:00.000Z");
        assert_eq!((sent.parent.clone(), sent.previous.clone()), (None, None));

        h.service
            .create_task("a", "L", edit("Eggs"), None, Some("milk".into()))
            .await
            .unwrap();
        h.service
            .create_task("a", "L", edit("Oat milk"), Some("milk".into()), None)
            .await
            .unwrap();
        // The cache already has the new tasks; Google's renumbering arrives with the sync.
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "L").await,
            vec![
                row("Bread", None),
                row("Milk", None),
                row("Oat milk", Some("Milk")),
                row("Eggs", None)
            ]
        );
        assert_eq!(
            h.fake("a")
                .outline("L")
                .into_iter()
                .map(|(_, _, title)| title)
                .collect::<Vec<_>>(),
            vec!["Bread", "Milk", "Oat milk", "Eggs"]
        );
    }

    #[tokio::test]
    async fn bad_input_is_refused_before_reaching_google() {
        let h = harness(&["a"]).await;
        h.fake("a").put("L", task("p", "Trip"));
        h.fake("a").put(
            "L",
            serde_json::json!({"id": "s", "title": "Pack", "parent": "p"}),
        );
        h.grant("a").await;

        let err = h
            .service
            .create_task("a", "nope", edit("x"), None, None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "not_found");
        assert_eq!(err.to_string(), "That task list isn't available any more.");
        let err = h
            .service
            .create_task("a", "L", edit("x"), Some("s".into()), None)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Subtasks can't have subtasks of their own."
        );
        let err = h
            .service
            .create_task("a", "L", edit("x"), None, Some("s".into()))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = h
            .service
            .update_task(
                "a",
                "L",
                "p",
                TaskEdit {
                    due: Some("12/11/2026".into()),
                    ..TaskEdit::default()
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = h
            .service
            .update_task("a", "L", "gone", edit("x"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "That task isn't available any more.");
        let err = h.service.create_task_list("a", "  ").await.unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = h
            .service
            .update_task("a", "L", "p", edit(&"x".repeat(1025)))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(h.fake("a").writes().is_empty());
    }

    #[tokio::test]
    async fn edits_title_notes_and_due_date_and_clears_them() {
        let h = harness(&["a"]).await;
        h.fake("a").put(
            "L",
            serde_json::json!({"id": "t", "title": "Rent", "notes": "Landlord",
                               "due": "2026-11-12T00:00:00.000Z"}),
        );
        h.grant("a").await;

        h.service
            .update_task(
                "a",
                "L",
                "t",
                TaskEdit {
                    title: Some("Pay rent".into()),
                    notes: None,
                    due: Some("2026-12-01".into()),
                },
            )
            .await
            .unwrap();
        let t = &h.service.tasks("a", "L").await.unwrap()[0];
        assert_eq!(t.title, "Pay rent");
        assert_eq!(t.notes.as_deref(), Some("Landlord"));
        assert_eq!(t.due.as_deref(), Some("2026-12-01"));

        h.service
            .update_task(
                "a",
                "L",
                "t",
                TaskEdit {
                    title: None,
                    notes: Some(String::new()),
                    due: Some(String::new()),
                },
            )
            .await
            .unwrap();
        let sent = h.fake("a").writes().pop().unwrap();
        assert_eq!(sent.body, serde_json::json!({"notes": null, "due": null}));
        let t = &h.service.tasks("a", "L").await.unwrap()[0];
        assert_eq!((t.notes.clone(), t.due.clone()), (None, None));

        // Nothing to change: no call.
        let before = h.fake("a").writes().len();
        h.service
            .update_task("a", "L", "t", TaskEdit::default())
            .await
            .unwrap();
        assert_eq!(h.fake("a").writes().len(), before);
    }

    #[tokio::test]
    async fn completes_and_uncompletes() {
        let h = harness(&["a"]).await;
        h.fake("a").put("L", task("t", "Rent"));
        h.grant("a").await;

        h.service
            .set_task_completed("a", "L", "t", true)
            .await
            .unwrap();
        let t = &h.service.tasks("a", "L").await.unwrap()[0];
        assert!(t.completed);
        assert!(t.completed_at.is_some());

        h.service
            .set_task_completed("a", "L", "t", false)
            .await
            .unwrap();
        let t = &h.service.tasks("a", "L").await.unwrap()[0];
        assert!(!t.completed);
        assert_eq!(t.completed_at, None);
        assert_eq!(
            h.fake("a").writes()[1].body,
            serde_json::json!({"status": "needsAction", "completed": null})
        );
    }

    #[tokio::test]
    async fn deletes_a_task_with_its_subtasks_and_rereads_the_list() {
        let h = harness(&["a"]).await;
        h.fake("a").put("L", task("p", "Trip"));
        h.fake("a").put(
            "L",
            serde_json::json!({"id": "s", "title": "Pack", "parent": "p"}),
        );
        h.fake("a").put("L", task("q", "Taxes"));
        h.grant("a").await;

        h.service.delete_task("a", "L", "p").await.unwrap();
        assert_eq!(outline(&h, "L").await, vec![row("Taxes", None)]);
        let list = &db::tasks::task_lists(h.db(), Some("a")).await.unwrap()[0];
        assert_eq!(list.full_synced_at, None);
        h.fake("a").reads();
        h.service.sync_now("a").await.unwrap();
        assert_eq!(h.fake("a").reads()[0].1, None, "read in full");
        assert_eq!(outline(&h, "L").await, vec![row("Taxes", None)]);
        assert_eq!(h.fake("a").task("L", "s").unwrap()["deleted"], true);
    }

    #[tokio::test]
    async fn reorders_indents_and_outdents() {
        let h = harness(&["a"]).await;
        for (id, title) in [("a1", "One"), ("a2", "Two"), ("a3", "Three")] {
            h.fake("a").put("L", task(id, title));
        }
        h.grant("a").await;

        // Reorder: Three goes first, then after One.
        h.service
            .move_task("a", "L", "a3", None, None)
            .await
            .unwrap();
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "L").await,
            vec![row("Three", None), row("One", None), row("Two", None)]
        );
        h.service
            .move_task("a", "L", "a3", None, Some("a1".into()))
            .await
            .unwrap();
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "L").await,
            vec![row("One", None), row("Three", None), row("Two", None)]
        );

        // Indent Three under One, then Two after it.
        h.service
            .move_task("a", "L", "a3", Some("a1".into()), None)
            .await
            .unwrap();
        h.service
            .move_task("a", "L", "a2", Some("a1".into()), Some("a3".into()))
            .await
            .unwrap();
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "L").await,
            vec![
                row("One", None),
                row("Three", Some("One")),
                row("Two", Some("One"))
            ]
        );

        // A task with subtasks can't be indented; a subtask can't parent one.
        h.fake("a").put("L", task("a4", "Four"));
        h.service.sync_now("a").await.unwrap();
        let err = h
            .service
            .move_task("a", "L", "a1", Some("a4".into()), None)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "A task with subtasks can't become a subtask."
        );
        let err = h
            .service
            .move_task("a", "L", "a4", Some("a3".into()), None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");

        // Outdent Two to just after One.
        h.service
            .move_task("a", "L", "a2", None, Some("a1".into()))
            .await
            .unwrap();
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "L").await,
            vec![
                row("One", None),
                row("Three", Some("One")),
                row("Two", None),
                row("Four", None)
            ]
        );
        let sent = h.fake("a").writes().pop().unwrap();
        assert_eq!(
            (sent.method, sent.parent, sent.previous, sent.destination),
            ("move", None, Some("a1".into()), None)
        );
    }

    #[tokio::test]
    async fn moves_a_task_with_its_subtasks_to_another_list() {
        let h = harness(&["a"]).await;
        h.fake("a").add_list("W", "Work");
        h.fake("a").put("L", task("p", "Report"));
        h.fake("a").put(
            "L",
            serde_json::json!({"id": "s", "title": "Charts", "parent": "p"}),
        );
        h.fake("a").put("W", task("w", "Email Sam"));
        h.grant("a").await;

        let moved = h
            .service
            .move_task_to_list("a", "L", "p", "W")
            .await
            .unwrap();
        assert_eq!(moved.list_id, "W");
        assert!(outline(&h, "L").await.is_empty());
        assert_eq!(
            outline(&h, "W").await,
            vec![row("Report", None), row("Email Sam", None)]
        );
        h.service.sync_now("a").await.unwrap();
        assert_eq!(
            outline(&h, "W").await,
            vec![
                row("Report", None),
                row("Charts", Some("Report")),
                row("Email Sam", None)
            ]
        );
        assert!(outline(&h, "L").await.is_empty());

        let err = h
            .service
            .move_task_to_list("a", "W", &moved.id, "W")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }

    #[tokio::test]
    async fn creates_renames_and_deletes_lists() {
        let h = harness(&["a"]).await;
        h.grant("a").await;

        let list = h.service.create_task_list("a", " Errands ").await.unwrap();
        assert_eq!(h.fake("a").list_titles(), vec!["My Tasks", "Errands"]);
        let titles = |accounts: Vec<super::super::service::TasksAccountDto>| {
            accounts[0]
                .lists
                .iter()
                .map(|l| l.title.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            titles(h.service.accounts().await.unwrap()),
            vec!["My Tasks", "Errands"]
        );
        let added = h
            .service
            .create_task("a", &list.list_id, edit("Post office"), None, None)
            .await
            .unwrap();
        assert_eq!(added.list_id, list.list_id);

        h.service
            .rename_task_list("a", &list.list_id, "Chores")
            .await
            .unwrap();
        assert_eq!(
            titles(h.service.accounts().await.unwrap()),
            vec!["My Tasks", "Chores"]
        );

        h.service
            .delete_task_list("a", &list.list_id)
            .await
            .unwrap();
        assert_eq!(
            titles(h.service.accounts().await.unwrap()),
            vec!["My Tasks"]
        );
        assert!(h
            .service
            .tasks("a", &list.list_id)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(h.fake("a").list_titles(), vec!["My Tasks"]);
    }

    #[tokio::test]
    async fn failures_leave_the_cache_alone_and_unknown_outcomes_sync() {
        let h = harness(&["a"]).await;
        h.fake("a").put("L", task("t", "Rent"));
        h.grant("a").await;

        // Offline: refused, nothing cached, no sync asked for.
        h.fake("a").fail_write(0, offline);
        let err = h
            .service
            .update_task("a", "L", "t", edit("Pay rent"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "network");
        assert_eq!(h.titles("a", "L").await, vec!["Rent"]);
        assert!(h.events.names().is_empty());

        // Google refused: its message, nothing cached.
        h.fake("a").fail_write(0, || GmailError::Api {
            status: 400,
            reason: None,
            message: "Invalid Value".into(),
        });
        let err = h
            .service
            .set_task_completed("a", "L", "t", true)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Google Tasks refused the change: Invalid Value"
        );
        assert!(!h.service.tasks("a", "L").await.unwrap()[0].completed);

        // The reply was lost after Google added the task: unconfirmed, and the sync that
        // follows shows it.
        h.fake("a").lose_reply(0);
        let err = h
            .service
            .create_task("a", "L", edit("Milk"), None, None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "unconfirmed");
        assert_eq!(h.titles("a", "L").await, vec!["Rent"]);
        assert!(h.service.is_forced("a"));
        h.service.tick(crate::sync::engine::now_ms()).await;
        assert_eq!(h.titles("a", "L").await, vec!["Milk", "Rent"]);

        // Deleted elsewhere: not found, and a sync is asked for.
        h.fake("a").remove("L", "t");
        let err = h
            .service
            .update_task("a", "L", "t", edit("Pay rent"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "That task isn't available any more.");
        assert!(h.service.is_forced("a"));
    }
}
