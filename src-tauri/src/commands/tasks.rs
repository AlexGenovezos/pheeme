//! Google Tasks commands: thin adapters over [`crate::tasks::service::TasksService`].

use super::CommandError;
use crate::gmail::user_action;
use crate::tasks::service::{TaskDto, TasksAccessDto, TasksAccountDto};
use crate::tasks::writes::{TaskEdit, TaskListRef, TaskRef};
use crate::AppState;
use tauri::State;

/// Every account with its tasks access and task lists (local).
#[tauri::command]
pub async fn tasks_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<TasksAccountDto>, CommandError> {
    Ok(state.tasks.accounts().await?)
}

/// A list's tasks in the order the list shows them, subtasks after their parent (local).
#[tauri::command]
pub async fn tasks_in_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
) -> Result<Vec<TaskDto>, CommandError> {
    Ok(state.tasks.tasks(&account_id, &list_id).await?)
}

/// Every account's tasks due on `[from_date, to_date)` in shown lists (local).
#[tauri::command]
pub async fn dated_tasks(
    state: State<'_, AppState>,
    from_date: String,
    to_date: String,
) -> Result<Vec<TaskDto>, CommandError> {
    Ok(state.tasks.dated_tasks(&from_date, &to_date).await?)
}

/// Show or hide a list's dated tasks on the calendar (local).
#[tauri::command]
pub async fn set_task_list_hidden(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    hidden: bool,
) -> Result<(), CommandError> {
    Ok(state
        .tasks
        .set_list_hidden(&account_id, &list_id, hidden)
        .await?)
}

/// Sync the account's tasks now (after turning the Tasks API on, or "Check again").
#[tauri::command]
pub async fn tasks_sync_now(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<TasksAccessDto, CommandError> {
    Ok(user_action(state.tasks.sync_now(&account_id)).await?)
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
    Ok(user_action(
        state
            .tasks
            .create_task(&account_id, &list_id, edit, parent, previous),
    )
    .await?)
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
    Ok(user_action(
        state
            .tasks
            .update_task(&account_id, &list_id, &task_id, edit),
    )
    .await?)
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
    Ok(user_action(
        state
            .tasks
            .set_task_completed(&account_id, &list_id, &task_id, completed),
    )
    .await?)
}

/// Delete a task with its subtasks.
#[tauri::command]
pub async fn delete_task(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    task_id: String,
) -> Result<(), CommandError> {
    Ok(user_action(state.tasks.delete_task(&account_id, &list_id, &task_id)).await?)
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
    Ok(user_action(
        state
            .tasks
            .move_task(&account_id, &list_id, &task_id, parent, previous),
    )
    .await?)
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
    Ok(user_action(state.tasks.move_task_to_list(
        &account_id,
        &list_id,
        &task_id,
        &destination_list_id,
    ))
    .await?)
}

#[tauri::command]
pub async fn create_task_list(
    state: State<'_, AppState>,
    account_id: String,
    title: String,
) -> Result<TaskListRef, CommandError> {
    Ok(user_action(state.tasks.create_task_list(&account_id, &title)).await?)
}

#[tauri::command]
pub async fn rename_task_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
    title: String,
) -> Result<TaskListRef, CommandError> {
    Ok(user_action(state.tasks.rename_task_list(&account_id, &list_id, &title)).await?)
}

/// Delete a task list with all its tasks.
#[tauri::command]
pub async fn delete_task_list(
    state: State<'_, AppState>,
    account_id: String,
    list_id: String,
) -> Result<(), CommandError> {
    Ok(user_action(state.tasks.delete_task_list(&account_id, &list_id)).await?)
}
