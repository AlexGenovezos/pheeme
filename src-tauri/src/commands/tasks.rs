//! Google Tasks commands: thin adapters over [`crate::tasks::service::TasksService`].

use super::timing::Call;
use super::CommandError;
use crate::gmail::user_action;
use crate::tasks::service::{TaskDto, TasksAccessDto, TasksAccountDto};
use crate::tasks::writes::{TaskEdit, TaskListRef, TaskRef};
use crate::AppState;
use tauri::State;

const AREA: &str = "tasks";

/// Every account with its tasks access and task lists (local).
#[tauri::command]
pub async fn tasks_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<TasksAccountDto>, CommandError> {
    Call::read(AREA, "tasks_accounts")
        .run(async { Ok(state.tasks.accounts().await?) })
        .await
}

/// A list's tasks in the order the list shows them, subtasks after their parent (local).
#[tauri::command]
pub async fn tasks_in_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
) -> Result<Vec<TaskDto>, CommandError> {
    Call::read(AREA, "tasks_in_list")
        .account(&account_id)
        .run(async { Ok(state.tasks.tasks(&account_id, &list_id).await?) })
        .await
}

/// Every account's tasks due on `[from_date, to_date)` in shown lists (local).
#[tauri::command]
pub async fn dated_tasks(
    state: State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> Result<Vec<TaskDto>, CommandError> {
    Call::read(AREA, "dated_tasks")
        .run(async { Ok(state.tasks.dated_tasks(&from_date, &to_date).await?) })
        .await
}

/// Every account's not-completed tasks due on or before `through_date` in shown lists (local).
#[tauri::command]
pub async fn tasks_due_through(
    state: State<'_, AppState>,
    through_date: String,
) -> Result<Vec<TaskDto>, CommandError> {
    Call::read(AREA, "tasks_due_through")
        .run(async { Ok(state.tasks.due_through(&through_date).await?) })
        .await
}

/// Show or hide a list's dated tasks on the calendar (local).
#[tauri::command]
pub async fn set_task_list_hidden(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    hidden: bool,
) -> Result<(), CommandError> {
    Call::write(AREA, "set_task_list_hidden")
        .account(&account_id)
        .with("hidden", hidden)
        .run(async {
            Ok(state
                .tasks
                .set_list_hidden(&account_id, &list_id, hidden)
                .await?)
        })
        .await
}

/// Sync the account's tasks now (after turning the Tasks API on, or "Check again").
#[tauri::command]
pub async fn tasks_sync_now(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<TasksAccessDto, CommandError> {
    Call::read(AREA, "tasks_sync_now")
        .account(&account_id)
        .run(async { Ok(user_action(state.tasks.sync_now(&account_id)).await?) })
        .await
}

/// Add a task under `parent` (top level when null), after `previous` (first when null).
#[tauri::command]
pub async fn create_task(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    edit: TaskEdit,
    parent: Option<String>,
    previous: Option<String>,
) -> Result<TaskRef, CommandError> {
    Call::write(AREA, "create_task")
        .account(&account_id)
        .run(async {
            Ok(user_action(
                state
                    .tasks
                    .create_task(&account_id, &list_id, edit, parent, previous),
            )
            .await?)
        })
        .await
}

/// Change a task's title, details or due date.
#[tauri::command]
pub async fn update_task(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
    edit: TaskEdit,
) -> Result<TaskRef, CommandError> {
    Call::write(AREA, "update_task")
        .account(&account_id)
        .run(async {
            Ok(user_action(
                state
                    .tasks
                    .update_task(&account_id, &list_id, &task_id, edit),
            )
            .await?)
        })
        .await
}

/// Tick a task off, or back on.
#[tauri::command]
pub async fn set_task_completed(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
    completed: bool,
) -> Result<TaskRef, CommandError> {
    Call::write(AREA, "set_task_completed")
        .account(&account_id)
        .with("completed", completed)
        .run(async {
            Ok(user_action(state.tasks.set_task_completed(
                &account_id,
                &list_id,
                &task_id,
                completed,
            ))
            .await?)
        })
        .await
}

/// Delete a task with its subtasks.
#[tauri::command]
pub async fn delete_task(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
) -> Result<(), CommandError> {
    Call::write(AREA, "delete_task")
        .account(&account_id)
        .run(async {
            Ok(user_action(state.tasks.delete_task(&account_id, &list_id, &task_id)).await?)
        })
        .await
}

/// Reorder, indent (`parent` set) or outdent (`parent` null) a task within its list.
#[tauri::command]
pub async fn move_task(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
    parent: Option<String>,
    previous: Option<String>,
) -> Result<TaskRef, CommandError> {
    Call::write(AREA, "move_task")
        .account(&account_id)
        .run(async {
            Ok(user_action(state.tasks.move_task(
                &account_id,
                &list_id,
                &task_id,
                parent,
                previous,
            ))
            .await?)
        })
        .await
}

/// Move a task (with its subtasks) to the top of another list of the same account.
#[tauri::command]
pub async fn move_task_to_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
    destination_list_id: String,
) -> Result<TaskRef, CommandError> {
    Call::write(AREA, "move_task_to_list")
        .account(&account_id)
        .run(async {
            Ok(user_action(state.tasks.move_task_to_list(
                &account_id,
                &list_id,
                &task_id,
                &destination_list_id,
            ))
            .await?)
        })
        .await
}

#[tauri::command]
pub async fn create_task_list(
    state: State<'_, AppState>,
    account_id: String,
    title: String,
) -> Result<TaskListRef, CommandError> {
    Call::write(AREA, "create_task_list")
        .account(&account_id)
        .run(async { Ok(user_action(state.tasks.create_task_list(&account_id, &title)).await?) })
        .await
}

#[tauri::command]
pub async fn rename_task_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    title: String,
) -> Result<TaskListRef, CommandError> {
    Call::write(AREA, "rename_task_list")
        .account(&account_id)
        .run(async {
            Ok(user_action(state.tasks.rename_task_list(&account_id, &list_id, &title)).await?)
        })
        .await
}

/// Delete a task list with all its tasks.
#[tauri::command]
pub async fn delete_task_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
) -> Result<(), CommandError> {
    Call::write(AREA, "delete_task_list")
        .account(&account_id)
        .run(async { Ok(user_action(state.tasks.delete_task_list(&account_id, &list_id)).await?) })
        .await
}
