//! Google Tasks: each account's task lists and tasks, synced into SQLite and read from there,
//! and the writes the Tasks panel makes. Tauri-free; `commands/tasks.rs` is the thin IPC
//! adapter. Runs apart from mail and calendar sync, with its own access status, so a Tasks
//! API that is off never affects either.

pub mod convert;
pub mod error;
#[cfg(test)]
pub(crate) mod fake;
pub mod service;
pub mod sync;
pub mod writes;

use crate::gmail::tasks::{
    ApiTask, ApiTaskList, TaskListsPage, TaskPlacement, TasksPage, TasksQuery,
};
use crate::gmail::{GmailClient, GmailError};
use serde_json::Value;
use std::sync::Arc;

/// The Tasks API calls sync and writes need, so tests can use [`fake::FakeTasks`].
#[async_trait::async_trait]
pub trait TasksApi: Send + Sync {
    async fn list_task_lists(&self, page_token: Option<&str>) -> Result<TaskListsPage, GmailError>;
    async fn insert_task_list(&self, title: &str) -> Result<ApiTaskList, GmailError>;
    async fn patch_task_list(&self, list_id: &str, title: &str) -> Result<ApiTaskList, GmailError>;
    async fn delete_task_list(&self, list_id: &str) -> Result<(), GmailError>;
    async fn list_tasks(
        &self,
        list_id: &str,
        query: TasksQuery<'_>,
    ) -> Result<TasksPage, GmailError>;
    async fn insert_task(
        &self,
        list_id: &str,
        body: Value,
        placement: TaskPlacement<'_>,
    ) -> Result<ApiTask, GmailError>;
    async fn patch_task(
        &self,
        list_id: &str,
        task_id: &str,
        body: Value,
    ) -> Result<ApiTask, GmailError>;
    async fn delete_task(&self, list_id: &str, task_id: &str) -> Result<(), GmailError>;
    async fn move_task(
        &self,
        list_id: &str,
        task_id: &str,
        placement: TaskPlacement<'_>,
        destination: Option<&str>,
    ) -> Result<ApiTask, GmailError>;
}

#[async_trait::async_trait]
impl TasksApi for GmailClient {
    async fn list_task_lists(&self, page_token: Option<&str>) -> Result<TaskListsPage, GmailError> {
        GmailClient::list_task_lists(self, page_token).await
    }

    async fn insert_task_list(&self, title: &str) -> Result<ApiTaskList, GmailError> {
        GmailClient::insert_task_list(self, title).await
    }

    async fn patch_task_list(&self, list_id: &str, title: &str) -> Result<ApiTaskList, GmailError> {
        GmailClient::patch_task_list(self, list_id, title).await
    }

    async fn delete_task_list(&self, list_id: &str) -> Result<(), GmailError> {
        GmailClient::delete_task_list(self, list_id).await
    }

    async fn list_tasks(
        &self,
        list_id: &str,
        query: TasksQuery<'_>,
    ) -> Result<TasksPage, GmailError> {
        GmailClient::list_tasks(self, list_id, query).await
    }

    async fn insert_task(
        &self,
        list_id: &str,
        body: Value,
        placement: TaskPlacement<'_>,
    ) -> Result<ApiTask, GmailError> {
        GmailClient::insert_task(self, list_id, body, placement).await
    }

    async fn patch_task(
        &self,
        list_id: &str,
        task_id: &str,
        body: Value,
    ) -> Result<ApiTask, GmailError> {
        GmailClient::patch_task(self, list_id, task_id, body).await
    }

    async fn delete_task(&self, list_id: &str, task_id: &str) -> Result<(), GmailError> {
        GmailClient::delete_task(self, list_id, task_id).await
    }

    async fn move_task(
        &self,
        list_id: &str,
        task_id: &str,
        placement: TaskPlacement<'_>,
        destination: Option<&str>,
    ) -> Result<ApiTask, GmailError> {
        GmailClient::move_task(self, list_id, task_id, placement, destination).await
    }
}

/// Builds the account's Tasks API client.
pub type TasksFactory = Arc<dyn Fn(&str) -> Arc<dyn TasksApi> + Send + Sync>;
