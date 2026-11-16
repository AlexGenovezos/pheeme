//! The Google Tasks tools: reads need only the main switch, changes the Tasks switch. Their
//! arguments, log summaries and descriptions for clients.

use super::{account_prop, object, on, write_account_prop, ToolDef};
use serde::Deserialize;
use serde_json::{json, Value};

/// Tasks listed per call by default, and at most.
pub const DEFAULT_TASKS: i64 = 100;
pub const MAX_TASKS: i64 = 500;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListTasks {
    pub account: Option<String>,
    /// Every list when omitted.
    pub list_id: Option<String>,
    #[serde(default)]
    pub include_completed: bool,
    /// `YYYY-MM-DD`: only tasks due on or before it.
    pub due_by: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTask {
    pub account: Option<String>,
    /// The account's first list when omitted.
    pub list_id: Option<String>,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<String>,
    /// Make it a subtask of this task.
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateTask {
    pub task_id: String,
    pub list_id: String,
    pub account: Option<String>,
    pub title: Option<String>,
    /// `""` clears them.
    pub notes: Option<String>,
    /// `YYYY-MM-DD`; `""` clears it.
    pub due: Option<String>,
    pub completed: Option<bool>,
    pub move_to_list_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskArg {
    pub task_id: String,
    pub list_id: String,
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskList {
    pub title: String,
    pub account: Option<String>,
}

impl ListTasks {
    pub(super) fn summary(&self) -> String {
        format!(
            "tasks in {}{}{}",
            self.list_id.as_deref().unwrap_or("every list"),
            if self.include_completed {
                " (with completed)"
            } else {
                ""
            },
            on(&self.account)
        )
    }
}

impl CreateTask {
    pub(super) fn summary(&self) -> String {
        format!("task \"{}\"{}", self.title, on(&self.account))
    }
}

impl UpdateTask {
    pub(super) fn summary(&self) -> String {
        format!(
            "task {}{}{}",
            self.task_id,
            match self.completed {
                Some(true) => " (completed)",
                Some(false) => " (not completed)",
                None => "",
            },
            on(&self.account)
        )
    }
}

impl TaskArg {
    pub(super) fn summary(&self) -> String {
        format!("task {}{}", self.task_id, on(&self.account))
    }
}

impl CreateTaskList {
    pub(super) fn summary(&self) -> String {
        format!("task list \"{}\"{}", self.title, on(&self.account))
    }
}

fn task_ref_props() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({
        "task_id": { "type": "string", "description": "task_id from list_tasks." },
        "list_id": { "type": "string", "description": "list_id from list_tasks." },
        "account": write_account_prop()
    }) else {
        unreachable!()
    };
    map
}

/// The Google Tasks tools: reads need only the main switch, changes the Tasks switch.
pub(super) fn tools() -> Vec<ToolDef> {
    let due = json!({ "type": "string", "description": "A date, YYYY-MM-DD (Google Tasks keeps no time)." });
    vec![
        ToolDef {
            name: "list_task_lists",
            title: "List task lists",
            description: "Each account's Google Tasks lists, and whether Pheeme may read its \
                tasks (access: on; otherwise the note says what the user must do).",
            input_schema: json!({
                "type": "object",
                "properties": { "account": account_prop() },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({}),
        },
        ToolDef {
            name: "list_tasks",
            title: "List tasks",
            description:
                "Tasks in a list (or every list), in the list's order with subtasks after \
                their parent, from Pheeme's local copy. Open tasks only unless include_completed; \
                due_by keeps those due on or before a date (overdue ones too).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": account_prop(),
                    "list_id": { "type": "string" },
                    "include_completed": { "type": "boolean" },
                    "due_by": due,
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_TASKS, "description": format!("Tasks (default {DEFAULT_TASKS}).") }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "due_by": "2026-11-20" }),
        },
        ToolDef {
            name: "create_task",
            title: "Add a task",
            description: "Add a task at the top of a list (default the account's first list), or \
                under parent as a subtask.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": write_account_prop(),
                    "list_id": { "type": "string" },
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": due,
                    "parent": { "type": "string", "description": "A task_id in the same list." }
                },
                "required": ["title"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "title": "Send the invoice", "due": "2026-11-20" }),
        },
        ToolDef {
            name: "update_task",
            title: "Change a task",
            description: "Change a task: give only what changes. completed ticks it off (or back \
                on); empty notes or due clears them; move_to_list_id moves it (and its subtasks) \
                to another list of the same account.",
            input_schema: object(
                task_ref_props(),
                json!({
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": due,
                    "completed": { "type": "boolean" },
                    "move_to_list_id": { "type": "string" }
                }),
                &["task_id", "list_id"],
            ),
            read_only: false,
            destructive: false,
            example: json!({ "task_id": "t1", "list_id": "L1", "completed": true }),
        },
        ToolDef {
            name: "delete_task",
            title: "Delete a task",
            description: "Delete a task and its subtasks. To tick it off instead, use update_task \
                with completed: true.",
            input_schema: object(task_ref_props(), json!({}), &["task_id", "list_id"]),
            read_only: false,
            destructive: true,
            example: json!({ "task_id": "t1", "list_id": "L1" }),
        },
        ToolDef {
            name: "create_task_list",
            title: "Create a task list",
            description: "Create a Google Tasks list.",
            input_schema: json!({
                "type": "object",
                "properties": { "title": { "type": "string" }, "account": write_account_prop() },
                "required": ["title"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "title": "Errands" }),
        },
    ]
}
