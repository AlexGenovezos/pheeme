//! The tools the local API offers: their arguments ([`Request`]) and their descriptions for
//! clients ([`catalog`]), kept side by side so they can't drift (a test parses every
//! catalog entry's example). Each tool's arguments, log summary and description live in its
//! domain's file; this file holds the enum that ties them together, and what they share.

mod calendar;
mod mail;
mod tasks;

use super::{ApiError, Permission};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;

pub use calendar::*;
pub use mail::*;
pub use tasks::*;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "tool", content = "args", rename_all = "snake_case")]
pub enum Request {
    ListAccounts(NoArgs),
    ListLabels(AccountArg),
    ListMailbox(ListMailbox),
    SearchMail(SearchMail),
    CountMail(CountMail),
    GetThread(GetThread),
    ListFilters(AccountArg),
    Archive(ThreadsArg),
    MoveToInbox(ThreadsArg),
    MarkRead(ThreadsArg),
    MarkUnread(ThreadsArg),
    Star(ThreadsArg),
    Unstar(ThreadsArg),
    Trash(ThreadsArg),
    ChangeLabels(ChangeLabels),
    CreateLabel(CreateLabel),
    CreateFilter(CreateFilter),
    DeleteFilter(DeleteFilter),
    CreateDraft(CreateDraft),
    SenderReport(SenderReport),
    FilterAudit(FilterAudit),
    Unsubscribe(Unsubscribe),
    ListCalendars(AccountArg),
    ListEvents(ListEvents),
    GetEvent(GetEvent),
    FindFreeTime(FindFreeTime),
    CreateEvent(CreateEvent),
    UpdateEvent(UpdateEvent),
    DeleteEvent(DeleteEvent),
    RespondToEvent(RespondToEvent),
    ListTaskLists(AccountArg),
    ListTasks(ListTasks),
    CreateTask(CreateTask),
    UpdateTask(UpdateTask),
    DeleteTask(TaskArg),
    CreateTaskList(CreateTaskList),
}

/// Which part of the local API serves a tool. Matched exhaustively, so a new tool can't be
/// left unrouted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Mail,
    Calendar,
    Tasks,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoArgs {}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountArg {
    /// Email address or account id; all accounts when omitted.
    pub account: Option<String>,
}

impl AccountArg {
    fn summary(&self, what: &str) -> String {
        format!("{what}{}", on(&self.account))
    }
}

/// " in me@example.com" for the log; nothing without an account.
fn on(account: &Option<String>) -> String {
    account
        .as_deref()
        .map(|a| format!(" in {a}"))
        .unwrap_or_default()
}

impl Request {
    /// The request for `tool` with JSON `args` (`null` reads as no arguments).
    pub fn parse(tool: &str, args: Value) -> Result<Self, ApiError> {
        if !catalog().iter().any(|t| t.name == tool) {
            return Err(ApiError::UnknownTool(tool.to_owned()));
        }
        let args = if args.is_null() { json!({}) } else { args };
        serde_json::from_value(json!({ "tool": tool, "args": args }))
            .map_err(|e| ApiError::Invalid(format!("Arguments for {tool} don't fit: {e}.")))
    }

    /// The write group the request needs, or `None` for a read.
    pub fn permission(&self) -> Option<Permission> {
        match self {
            Request::ListAccounts(_)
            | Request::ListLabels(_)
            | Request::ListMailbox(_)
            | Request::SearchMail(_)
            | Request::CountMail(_)
            | Request::GetThread(_)
            | Request::ListFilters(_)
            | Request::SenderReport(_)
            | Request::FilterAudit(_)
            | Request::ListCalendars(_)
            | Request::ListEvents(_)
            | Request::GetEvent(_)
            | Request::FindFreeTime(_)
            | Request::ListTaskLists(_)
            | Request::ListTasks(_) => None,
            Request::Archive(_)
            | Request::MoveToInbox(_)
            | Request::MarkRead(_)
            | Request::MarkUnread(_)
            | Request::Star(_)
            | Request::Unstar(_)
            | Request::Trash(_)
            | Request::ChangeLabels(_)
            | Request::CreateLabel(_) => Some(Permission::Organize),
            Request::CreateFilter(_) | Request::DeleteFilter(_) => Some(Permission::Filters),
            Request::CreateDraft(_) => Some(Permission::Drafts),
            Request::Unsubscribe(_) => Some(Permission::Unsubscribe),
            Request::CreateEvent(_)
            | Request::UpdateEvent(_)
            | Request::DeleteEvent(_)
            | Request::RespondToEvent(_) => Some(Permission::Calendar),
            Request::CreateTask(_)
            | Request::UpdateTask(_)
            | Request::DeleteTask(_)
            | Request::CreateTaskList(_) => Some(Permission::Tasks),
        }
    }

    /// The part of the local API that serves the tool (reads and writes alike).
    pub fn domain(&self) -> Domain {
        match self {
            Request::ListAccounts(_)
            | Request::ListLabels(_)
            | Request::ListMailbox(_)
            | Request::SearchMail(_)
            | Request::CountMail(_)
            | Request::GetThread(_)
            | Request::ListFilters(_)
            | Request::Star(_)
            | Request::Unstar(_)
            | Request::MarkRead(_)
            | Request::MarkUnread(_)
            | Request::Archive(_)
            | Request::MoveToInbox(_)
            | Request::Trash(_)
            | Request::CreateLabel(_)
            | Request::ChangeLabels(_)
            | Request::CreateFilter(_)
            | Request::DeleteFilter(_)
            | Request::CreateDraft(_)
            | Request::SenderReport(_)
            | Request::FilterAudit(_)
            | Request::Unsubscribe(_) => Domain::Mail,
            Request::ListCalendars(_)
            | Request::ListEvents(_)
            | Request::GetEvent(_)
            | Request::FindFreeTime(_)
            | Request::CreateEvent(_)
            | Request::UpdateEvent(_)
            | Request::DeleteEvent(_)
            | Request::RespondToEvent(_) => Domain::Calendar,
            Request::ListTaskLists(_)
            | Request::ListTasks(_)
            | Request::CreateTask(_)
            | Request::UpdateTask(_)
            | Request::DeleteTask(_)
            | Request::CreateTaskList(_) => Domain::Tasks,
        }
    }

    /// What the call touched, in a few words, for the activity log.
    pub fn summary(&self) -> String {
        match self {
            Request::ListAccounts(_) => "accounts".into(),
            Request::ListLabels(a) => a.summary("labels"),
            Request::ListMailbox(m) => m.summary(),
            Request::SearchMail(s) => s.summary(),
            Request::CountMail(c) => c.summary(),
            Request::GetThread(t) => t.summary(),
            Request::ListFilters(a) => a.summary("filters"),
            Request::Archive(t)
            | Request::MoveToInbox(t)
            | Request::MarkRead(t)
            | Request::MarkUnread(t)
            | Request::Star(t)
            | Request::Unstar(t)
            | Request::Trash(t) => t.summary(),
            Request::ChangeLabels(c) => c.summary(),
            Request::CreateLabel(l) => l.summary(),
            Request::CreateFilter(f) => f.summary(),
            Request::DeleteFilter(d) => d.summary(),
            Request::SenderReport(r) => r.summary(),
            Request::FilterAudit(a) => a.summary(),
            Request::Unsubscribe(u) => u.summary(),
            Request::CreateDraft(d) => d.summary(),
            Request::ListCalendars(a) => a.summary("calendars"),
            Request::ListEvents(l) => l.summary(),
            Request::GetEvent(e) => e.summary(),
            Request::FindFreeTime(f) => f.summary(),
            Request::CreateEvent(c) => c.summary(),
            Request::UpdateEvent(u) => u.summary(),
            Request::DeleteEvent(d) => d.summary(),
            Request::RespondToEvent(r) => r.summary(),
            Request::ListTaskLists(a) => a.summary("task lists"),
            Request::ListTasks(l) => l.summary(),
            Request::CreateTask(c) => c.summary(),
            Request::UpdateTask(u) => u.summary(),
            Request::DeleteTask(t) => t.summary(),
            Request::CreateTaskList(l) => l.summary(),
        }
    }
}

/// A tool as clients see it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDef {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub read_only: bool,
    /// Deletes or overwrites (Trash, filter deletion).
    pub destructive: bool,
    /// Arguments that must parse, for the catalog test.
    pub example: Value,
}

fn account_prop() -> Value {
    json!({
        "type": "string",
        "description": "Email address (or id) of one connected account. Leave out for all accounts."
    })
}

fn write_account_prop() -> Value {
    json!({
        "type": "string",
        "description": "The account (email address or id). Required when more than one is connected."
    })
}

fn object(mut props: serde_json::Map<String, Value>, extra: Value, required: &[&str]) -> Value {
    if let Value::Object(extra) = extra {
        props.extend(extra);
    }
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

/// Every tool, in the order clients list them. Built once: `Request::parse` and the activity
/// log look tools up on every call.
pub fn catalog() -> &'static [ToolDef] {
    static CATALOG: LazyLock<Vec<ToolDef>> = LazyLock::new(|| {
        let mut tools = mail::tools();
        tools.extend(calendar::tools());
        tools.extend(tasks::tools());
        tools
    });
    &CATALOG
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog as MCP clients read it, plus what each tool's example parses to, must not
    /// change by accident: names, schemas, descriptions, permissions and log summaries are the
    /// contract with every connected assistant. After a deliberate change, regenerate
    /// `catalog.json` with `UPDATE_CATALOG=1 cargo test catalog_matches_snapshot`.
    #[test]
    fn catalog_matches_snapshot() {
        let entries: Vec<Value> = catalog()
            .iter()
            .map(|t| {
                let parsed = Request::parse(t.name, t.example.clone()).unwrap();
                json!({
                    "name": t.name,
                    "title": t.title,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                    "readOnly": t.read_only,
                    "destructive": t.destructive,
                    "example": t.example,
                    "permission": parsed.permission().map(|p| format!("{p:?}")),
                    "summary": parsed.summary(),
                })
            })
            .collect();
        let mut text = serde_json::to_string_pretty(&entries).unwrap();
        text.push('\n');
        if std::env::var_os("UPDATE_CATALOG").is_some() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/local_api/requests/catalog.json"
            );
            std::fs::write(path, &text).unwrap();
        }
        assert!(
            text == include_str!("catalog.json"),
            "the tool catalog changed; see catalog_matches_snapshot"
        );
    }
}
