//! The tools the local API offers: their arguments ([`Request`]) and their descriptions for
//! clients ([`catalog`]), kept side by side so they can't drift (a test parses every
//! catalog entry's example).

use super::{ApiError, Permission};
use serde::Deserialize;
use serde_json::{json, Value};

pub const DEFAULT_LIMIT: i64 = 25;
/// The sender report's default window.
pub const DEFAULT_DAYS: i64 = 90;
/// The filter audit's default window.
pub const AUDIT_DAYS: i64 = 30;
pub const MAX_LIMIT: i64 = 100;

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

/// Events listed per call by default, and at most.
pub const DEFAULT_EVENTS: i64 = 50;
pub const MAX_EVENTS: i64 = 250;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListEvents {
    /// A date or date-time; the start of today when omitted.
    pub from: Option<String>,
    /// A date (that whole day counts) or date-time; a week after `from` when omitted.
    pub to: Option<String>,
    /// Words that must all appear in the title, place, description or guests.
    pub query: Option<String>,
    pub account: Option<String>,
    pub calendar_id: Option<String>,
    pub time_zone: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetEvent {
    pub event_id: String,
    /// The account's primary calendar when omitted.
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindFreeTime {
    pub from: Option<String>,
    pub to: Option<String>,
    pub duration_minutes: Option<i64>,
    /// `HH:MM`, default 09:00.
    pub day_start: Option<String>,
    /// `HH:MM`, default 17:00.
    pub day_end: Option<String>,
    #[serde(default)]
    pub weekends: bool,
    pub account: Option<String>,
    pub time_zone: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateEvent {
    pub account: Option<String>,
    pub calendar_id: Option<String>,
    pub title: String,
    pub start: String,
    pub end: Option<String>,
    pub time_zone: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub guests: Vec<String>,
    #[serde(default)]
    pub optional_guests: Vec<String>,
    #[serde(default)]
    pub add_meet: bool,
    #[serde(default)]
    pub repeat: Vec<String>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    /// this (default), following or all, for a repeating event.
    pub scope: Option<String>,
    pub title: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub time_zone: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub add_guests: Vec<String>,
    #[serde(default)]
    pub remove_guests: Vec<String>,
    /// true adds a Google Meet link, false removes it.
    pub meet: Option<bool>,
    /// Repeat rules; `[]` stops it repeating.
    pub repeat: Option<Vec<String>>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    pub scope: Option<String>,
    #[serde(default)]
    pub notify_guests: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RespondToEvent {
    pub event_id: String,
    pub calendar_id: Option<String>,
    pub account: Option<String>,
    /// accepted, tentative or declined (yes, maybe, no also read).
    pub response: String,
    pub comment: Option<String>,
    /// this (default) or all, for a repeating event.
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SenderReport {
    pub account: Option<String>,
    pub days: Option<i64>,
    pub limit: Option<i64>,
    /// Only mail in this inbox tab (primary, promotions, social, updates, forums).
    pub tab: Option<String>,
    /// `messages` (the default) or `unread`.
    pub sort_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterAudit {
    pub account: Option<String>,
    pub days: Option<i64>,
    /// Conversations shown per filter.
    pub sample: Option<usize>,
    /// Every filter, not just those that delete, archive or mark read.
    #[serde(default)]
    pub all: bool,
    /// Leave out snippets and labels.
    #[serde(default)]
    pub compact: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unsubscribe {
    pub thread_id: String,
    pub account: Option<String>,
    pub message_id: Option<String>,
}

/// Most conversations one call may change.
pub const MAX_THREADS: usize = 500;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadsArg {
    #[serde(default)]
    pub thread_ids: Vec<String>,
    /// Instead of `thread_ids`: every conversation this search finds (search_mail syntax).
    pub query: Option<String>,
    /// With `query`: count what would change, change nothing.
    #[serde(default)]
    pub dry_run: bool,
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeLabels {
    #[serde(default)]
    pub thread_ids: Vec<String>,
    /// Instead of `thread_ids`: every message this Gmail search finds.
    pub query: Option<String>,
    pub account: Option<String>,
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateLabel {
    pub name: String,
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateFilter {
    pub account: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub query: Option<String>,
    pub negated_query: Option<String>,
    pub has_attachment: Option<bool>,
    pub add_label: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub skip_inbox: bool,
    #[serde(default)]
    pub mark_read: bool,
    #[serde(default)]
    pub star: bool,
    #[serde(default)]
    pub trash: bool,
    #[serde(default)]
    pub never_spam: bool,
    pub important: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteFilter {
    pub filter_id: String,
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDraft {
    pub account: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: Option<String>,
    pub body: String,
    pub reply_to_message_id: Option<String>,
    #[serde(default)]
    pub reply_all: bool,
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

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListMailbox {
    pub mailbox: Option<String>,
    pub account: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    /// Leave out snippets and labels.
    #[serde(default)]
    pub compact: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchMail {
    pub query: String,
    pub account: Option<String>,
    /// Ask Gmail's own search instead of the local cache.
    #[serde(default)]
    pub gmail: bool,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    /// Leave out snippets and labels.
    #[serde(default)]
    pub compact: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountMail {
    /// A search (search_mail syntax); instead of `mailbox`.
    pub query: Option<String>,
    /// A mailbox as list_mailbox takes it; inbox when neither this nor `query` is given.
    pub mailbox: Option<String>,
    pub account: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
    /// sender, domain, label, tab or month; just the totals when omitted.
    pub group_by: Option<String>,
    /// Groups shown (default 25).
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetThread {
    pub thread_id: String,
    pub account: Option<String>,
    pub max_chars_per_message: Option<usize>,
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

    /// A Google Tasks tool (read or write), served by `tasks.rs`.
    pub fn is_tasks(&self) -> bool {
        matches!(
            self,
            Request::ListTaskLists(_)
                | Request::ListTasks(_)
                | Request::CreateTask(_)
                | Request::UpdateTask(_)
                | Request::DeleteTask(_)
                | Request::CreateTaskList(_)
        )
    }

    /// A calendar tool (read or write), served by `calendar.rs`.
    pub fn is_calendar(&self) -> bool {
        matches!(
            self,
            Request::ListCalendars(_)
                | Request::ListEvents(_)
                | Request::GetEvent(_)
                | Request::FindFreeTime(_)
                | Request::CreateEvent(_)
                | Request::UpdateEvent(_)
                | Request::DeleteEvent(_)
                | Request::RespondToEvent(_)
        )
    }

    /// What the call touched, in a few words, for the activity log.
    pub fn summary(&self) -> String {
        let on = |account: &Option<String>| {
            account
                .as_deref()
                .map(|a| format!(" in {a}"))
                .unwrap_or_default()
        };
        match self {
            Request::ListAccounts(_) => "accounts".into(),
            Request::ListLabels(a) => format!("labels{}", on(&a.account)),
            Request::ListMailbox(m) => format!(
                "{}{}{}",
                m.mailbox.as_deref().unwrap_or("inbox"),
                if m.unread_only { " (unread)" } else { "" },
                on(&m.account)
            ),
            Request::SearchMail(s) => format!(
                "\"{}\"{}{}",
                s.query,
                if s.gmail { " on Gmail" } else { "" },
                on(&s.account)
            ),
            Request::CountMail(c) => format!(
                "count {}{}{}{}",
                match &c.query {
                    Some(q) => format!("\"{q}\""),
                    None => c.mailbox.clone().unwrap_or_else(|| "inbox".into()),
                },
                if c.unread_only { " (unread)" } else { "" },
                c.group_by
                    .as_deref()
                    .map(|g| format!(" by {g}"))
                    .unwrap_or_default(),
                on(&c.account)
            ),
            Request::GetThread(t) => format!("conversation {}{}", t.thread_id, on(&t.account)),
            Request::ListFilters(a) => format!("filters{}", on(&a.account)),
            Request::Archive(t)
            | Request::MoveToInbox(t)
            | Request::MarkRead(t)
            | Request::MarkUnread(t)
            | Request::Star(t)
            | Request::Unstar(t)
            | Request::Trash(t) => format!(
                "{}{}{}",
                match &t.query {
                    Some(q) => format!("every match for \"{q}\""),
                    None => conversations(t.thread_ids.len()),
                },
                if t.dry_run { " (dry run)" } else { "" },
                on(&t.account)
            ),
            Request::ChangeLabels(c) => format!(
                "{}: +[{}] -[{}]{}",
                match &c.query {
                    Some(q) => format!("every match for \"{q}\""),
                    None => conversations(c.thread_ids.len()),
                },
                c.add.join(", "),
                c.remove.join(", "),
                on(&c.account)
            ),
            Request::CreateLabel(l) => format!("label {}{}", l.name, on(&l.account)),
            Request::CreateFilter(f) => {
                let mut parts = Vec::new();
                for (key, value) in [
                    ("from", &f.from),
                    ("to", &f.to),
                    ("subject", &f.subject),
                    ("query", &f.query),
                ] {
                    if let Some(v) = value {
                        parts.push(format!("{key}:{v}"));
                    }
                }
                format!("filter {}{}", parts.join(" "), on(&f.account))
            }
            Request::DeleteFilter(d) => format!("filter {}{}", d.filter_id, on(&d.account)),
            Request::SenderReport(r) => format!(
                "top senders, {} days{}{}",
                r.days.unwrap_or(DEFAULT_DAYS),
                r.tab
                    .as_deref()
                    .map(|t| format!(" in {t}"))
                    .unwrap_or_default(),
                on(&r.account)
            ),
            Request::FilterAudit(a) => format!(
                "filters' catches, {} days{}",
                a.days.unwrap_or(AUDIT_DAYS),
                on(&a.account)
            ),
            Request::Unsubscribe(u) => format!("conversation {}{}", u.thread_id, on(&u.account)),
            Request::CreateDraft(d) => format!(
                "draft \"{}\"{}{}",
                d.subject.as_deref().unwrap_or(""),
                if d.reply_to_message_id.is_some() {
                    " (reply)"
                } else {
                    ""
                },
                on(&d.account)
            ),
            Request::ListCalendars(a) => format!("calendars{}", on(&a.account)),
            Request::ListEvents(l) => format!(
                "events {} to {}{}{}",
                l.from.as_deref().unwrap_or("today"),
                l.to.as_deref().unwrap_or("a week on"),
                l.query
                    .as_deref()
                    .map(|q| format!(" matching \"{q}\""))
                    .unwrap_or_default(),
                on(&l.account)
            ),
            Request::GetEvent(e) => format!("event {}{}", e.event_id, on(&e.account)),
            Request::FindFreeTime(f) => format!(
                "free {} min, {} to {}{}",
                f.duration_minutes.unwrap_or(30),
                f.from.as_deref().unwrap_or("now"),
                f.to.as_deref().unwrap_or("a week on"),
                on(&f.account)
            ),
            Request::CreateEvent(c) => format!(
                "event \"{}\" at {}{}{}",
                c.title,
                c.start,
                guests(c.guests.len() + c.optional_guests.len(), c.notify_guests),
                on(&c.account)
            ),
            Request::UpdateEvent(u) => format!(
                "event {}{}{}",
                u.event_id,
                guests(u.add_guests.len(), u.notify_guests),
                on(&u.account)
            ),
            Request::DeleteEvent(d) => format!(
                "event {}{}{}",
                d.event_id,
                if d.notify_guests { ", guests told" } else { "" },
                on(&d.account)
            ),
            Request::RespondToEvent(r) => {
                format!("{} to event {}{}", r.response, r.event_id, on(&r.account))
            }
            Request::ListTaskLists(a) => format!("task lists{}", on(&a.account)),
            Request::ListTasks(l) => format!(
                "tasks in {}{}{}",
                l.list_id.as_deref().unwrap_or("every list"),
                if l.include_completed {
                    " (with completed)"
                } else {
                    ""
                },
                on(&l.account)
            ),
            Request::CreateTask(c) => format!("task \"{}\"{}", c.title, on(&c.account)),
            Request::UpdateTask(u) => format!(
                "task {}{}{}",
                u.task_id,
                match u.completed {
                    Some(true) => " (completed)",
                    Some(false) => " (not completed)",
                    None => "",
                },
                on(&u.account)
            ),
            Request::DeleteTask(t) => format!("task {}{}", t.task_id, on(&t.account)),
            Request::CreateTaskList(l) => format!("task list \"{}\"{}", l.title, on(&l.account)),
        }
    }
}

/// ", 2 guests (emailed)" for the log; nothing without guests.
fn guests(n: usize, notified: bool) -> String {
    match n {
        0 => String::new(),
        n => format!(
            ", {n} guest{}{}",
            if n == 1 { "" } else { "s" },
            if notified { " (emailed)" } else { "" }
        ),
    }
}

fn conversations(n: usize) -> String {
    if n == 1 {
        "1 conversation".into()
    } else {
        format!("{n} conversations")
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

fn compact_prop() -> Value {
    json!({ "type": "boolean", "description": "Leave out snippets and labels (default false)." })
}

fn paging_props() -> (Value, Value) {
    (
        json!({
            "type": "integer", "minimum": 1, "maximum": MAX_LIMIT,
            "description": format!("Conversations per page (default {DEFAULT_LIMIT}).")
        }),
        json!({
            "type": "string",
            "description": "The cursor from the previous page, to get the next one."
        }),
    )
}

/// Every tool, in the order clients list them.
pub fn catalog() -> Vec<ToolDef> {
    let (limit, cursor) = paging_props();
    let mut tools = vec![
        ToolDef {
            name: "list_accounts",
            title: "List accounts",
            description: "The Gmail accounts connected to Pheeme.",
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            read_only: true,
            destructive: false,
            example: json!({}),
        },
        ToolDef {
            name: "list_labels",
            title: "List labels",
            description: "Each account's labels (system and user) with their conversation counts.",
            input_schema: json!({
                "type": "object",
                "properties": { "account": account_prop() },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "account": "me@example.com" }),
        },
        ToolDef {
            name: "list_mailbox",
            title: "List a mailbox",
            description: "Conversations in a mailbox, newest first: inbox, primary, social, promotions, \
                updates, forums, starred, important, sent, drafts, spam, trash, all (everything outside \
                Spam and Trash), or a user label's name. Answered from Pheeme's local copy, so it's instant. \
                To count or rank (how many, who sends the most), use count_mail instead of paging through.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "mailbox": { "type": "string", "description": "Default inbox." },
                    "account": account_prop(),
                    "unread_only": { "type": "boolean" },
                    "limit": limit,
                    "cursor": cursor,
                    "compact": compact_prop()
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "mailbox": "inbox", "unread_only": true, "limit": 10 }),
        },
        ToolDef {
            name: "search_mail",
            title: "Search mail",
            description: "Search with Gmail syntax (from:, to:, subject:, label:, is:unread, has:attachment, \
                newer_than:7d, in:trash...). Searches the mail cached on this computer by default, which is \
                instant but may not hold old mail; set gmail to true to ask Gmail's own search, which covers \
                the whole mailbox. Queries only Gmail understands go to Gmail automatically. Like Gmail, it \
                leaves out Trash and Spam unless the query says in:anywhere, in:trash or in:spam.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "account": account_prop(),
                    "gmail": { "type": "boolean", "description": "Use Gmail's search (default false)." },
                    "limit": limit,
                    "cursor": cursor,
                    "compact": compact_prop()
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "query": "from:news@example.com newer_than:30d", "gmail": true }),
        },
        ToolDef {
            name: "count_mail",
            title: "Count mail",
            description: "How many conversations a mailbox or a search holds, and how many are unread, \
                optionally grouped by sender, domain (the sender's), label, tab (inbox tab) or month, \
                biggest group first. One call answers questions like \"who has the most unread mail in \
                Promotions\" (mailbox: promotions, unread_only: true, group_by: sender) without listing \
                the mail. Counts the mail on this computer (search_mail's local syntax).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "A search, as search_mail takes it. Instead of mailbox." },
                    "mailbox": { "type": "string", "description": "A mailbox, as list_mailbox takes it (default inbox)." },
                    "account": account_prop(),
                    "unread_only": { "type": "boolean" },
                    "group_by": { "type": "string", "enum": ["sender", "domain", "label", "tab", "month"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "Groups shown (default 25)." }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "mailbox": "promotions", "unread_only": true, "group_by": "sender", "limit": 10 }),
        },
        ToolDef {
            name: "get_thread",
            title: "Read a conversation",
            description: "A conversation's messages as plain text, with senders, recipients, dates, labels and \
                attachment names. Bodies not cached yet are downloaded from Gmail.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "thread_id": { "type": "string" },
                    "account": {
                        "type": "string",
                        "description": "The account the conversation is in (from the list or search result)."
                    },
                    "max_chars_per_message": {
                        "type": "integer", "minimum": 200,
                        "description": "Cut longer bodies (default 8000)."
                    }
                },
                "required": ["thread_id"],
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "thread_id": "t1", "account": "me@example.com" }),
        },
        ToolDef {
            name: "list_filters",
            title: "List Gmail filters",
            description: "Every Gmail filter (rule) on the account: what it matches and what it does, in words, \
                with flags for filters that delete mail, skip the inbox or mark it read.",
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
            name: "sender_report",
            title: "Who sends the most mail",
            description: "The senders with the most mail over the last N days (default 90), from Pheeme's \
                local copy: how many messages, how many are unread or sit in Inbox, Trash or Spam, which \
                inbox tab they land in, how often the user has written to them (you_wrote; none suggests \
                a list or notification, not a person), and whether their mail offers unsubscribe \
                (one_click, link, email, none, or unknown). Counts that are 0 are left out. Use it to \
                suggest filters or unsubscribing; for plain counts, count_mail is lighter.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": account_prop(),
                    "days": { "type": "integer", "minimum": 1, "maximum": 3650 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "Senders (default 25)." },
                    "tab": {
                        "type": "string",
                        "enum": ["primary", "social", "promotions", "updates", "forums"],
                        "description": "Only mail in this inbox tab."
                    },
                    "sort_by": { "type": "string", "enum": ["messages", "unread"], "description": "Default messages." }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "days": 30, "limit": 10 }),
        },
        ToolDef {
            name: "filter_audit",
            title: "What filters caught",
            description: "For each Gmail filter that deletes, archives or marks mail read (or every filter \
                with all: true), the mail it matched over the last N days (default 30), found with Gmail's \
                search: how much (matched, first 50), where it is now (now_in: trash, inbox, archived...) \
                and a sample. For filters that delete, archive or mark read, worth_checking lists matched \
                mail from the last year that looks wanted (starred, in Primary or Updates, or an order, \
                bill, delivery or account subject); read it before trusting the filter. Use it to find \
                filters that catch mail the user wants; fix them with delete_filter and create_filter, \
                and rescue what they trashed or archived with move_to_inbox.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": account_prop(),
                    "days": { "type": "integer", "minimum": 1, "maximum": 3650 },
                    "sample": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Conversations per filter and list (default 5)." },
                    "all": { "type": "boolean" },
                    "compact": compact_prop()
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "days": 14 }),
        },
        query_tool(
            "archive",
            "Archive",
            "Take conversations out of the inbox (they stay in All Mail and their labels).",
        ),
        threads_tool(
            "move_to_inbox",
            "Move to inbox",
            "Put archived or trashed conversations back in the inbox (this also takes them out \
             of Trash, which Gmail empties after 30 days).",
            false,
        ),
        query_tool("mark_read", "Mark as read", "Mark conversations as read."),
        query_tool("mark_unread", "Mark as unread", "Mark conversations as unread."),
        query_tool("star", "Star", "Star conversations."),
        query_tool("unstar", "Unstar", "Remove the star from conversations."),
        threads_tool(
            "trash",
            "Move to Trash",
            "Move conversations to Trash (Gmail deletes them for good after 30 days).",
            true,
        ),
        ToolDef {
            name: "change_labels",
            title: "Change labels",
            description: "Add and remove user labels (by name) on conversations: the thread_ids \
                given, or with query every message that Gmail search finds, including mail not \
                downloaded yet (use query for more than a few hundred; it is far lighter on Gmail's \
                quota). Use archive, trash, star and the other tools for Inbox, Trash, Starred and \
                read state.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "thread_ids": thread_ids_prop(),
                    "query": { "type": "string", "description": "Instead of thread_ids: a Gmail search; every message it finds is changed." },
                    "account": write_account_prop(),
                    "add": { "type": "array", "items": { "type": "string" }, "description": "Label names to add." },
                    "remove": { "type": "array", "items": { "type": "string" }, "description": "Label names to remove." }
                },
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "thread_ids": ["t1"], "add": ["Receipts"] }),
        },
        ToolDef {
            name: "create_label",
            title: "Create a label",
            description: "Create a user label. Nest it with slashes (Clients/Acme).",
            input_schema: json!({
                "type": "object",
                "properties": { "name": { "type": "string" }, "account": write_account_prop() },
                "required": ["name"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "name": "Receipts" }),
        },
        ToolDef {
            name: "create_filter",
            title: "Create a Gmail filter",
            description: "Create a Gmail filter (rule) for mail that arrives from now on. Give at least \
                one criterion (from, to, subject, query, negated_query, has_attachment) and one action. \
                Before creating one that trashes or archives mail, check what it would catch with \
                search_mail (gmail: true) using the same criteria.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": write_account_prop(),
                    "from": { "type": "string", "description": "Sender address, domain or Gmail from: value." },
                    "to": { "type": "string" },
                    "subject": { "type": "string" },
                    "query": { "type": "string", "description": "Has the words (Gmail search syntax)." },
                    "negated_query": { "type": "string", "description": "Doesn't have." },
                    "has_attachment": { "type": "boolean" },
                    "add_label": { "type": "string", "description": "A user label's name (it must exist)." },
                    "category": {
                        "type": "string",
                        "enum": ["primary", "social", "promotions", "updates", "forums"],
                        "description": "File it under an inbox tab."
                    },
                    "skip_inbox": { "type": "boolean", "description": "Archive it." },
                    "mark_read": { "type": "boolean" },
                    "star": { "type": "boolean" },
                    "trash": { "type": "boolean", "description": "Delete it." },
                    "never_spam": { "type": "boolean" },
                    "important": { "type": "boolean", "description": "true: always important; false: never." }
                },
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "from": "news@example.com", "skip_inbox": true, "add_label": "Receipts" }),
        },
        ToolDef {
            name: "delete_filter",
            title: "Delete a Gmail filter",
            description: "Delete a Gmail filter by its id (from list_filters). Mail it already filed stays where it is.",
            input_schema: json!({
                "type": "object",
                "properties": { "filter_id": { "type": "string" }, "account": write_account_prop() },
                "required": ["filter_id"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: true,
            example: json!({ "filter_id": "f1" }),
        },
        ToolDef {
            name: "unsubscribe",
            title: "Unsubscribe",
            description: "Unsubscribe from the mailing list a conversation came from, using its \
                List-Unsubscribe header. One-click unsubscribes (RFC 8058) happen at once; otherwise the \
                answer gives the link or address for the user to use themselves. Uses the newest message \
                not sent by the user, or message_id.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "thread_id": { "type": "string" },
                    "account": write_account_prop(),
                    "message_id": { "type": "string" }
                },
                "required": ["thread_id"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "thread_id": "t1" }),
        },
        ToolDef {
            name: "create_draft",
            title: "Write a draft",
            description: "Save a draft in Gmail Drafts for the user to review and send from Pheeme. \
                Assistants can't send mail. For a reply, give reply_to_message_id (a message_id from \
                get_thread): recipients, subject and the quoted original come from it, and to/cc/bcc add more. \
                Pheeme doesn't add the user's signature to assistant drafts yet.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": write_account_prop(),
                    "to": { "type": "array", "items": { "type": "string" } },
                    "cc": { "type": "array", "items": { "type": "string" } },
                    "bcc": { "type": "array", "items": { "type": "string" } },
                    "subject": { "type": "string", "description": "Ignored for replies." },
                    "body": { "type": "string", "description": "Plain text." },
                    "reply_to_message_id": { "type": "string" },
                    "reply_all": { "type": "boolean", "description": "With reply_to_message_id: reply to everyone." }
                },
                "required": ["body"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "to": ["a@example.com"], "subject": "Hi", "body": "Hello" }),
        },
    ];
    tools.extend(calendar_tools());
    tools.extend(tasks_tools());
    tools
}

fn time_zone_prop() -> Value {
    json!({
        "type": "string",
        "description": "An IANA time zone (Europe/Paris) for reading and writing times. Default: the \
            user's Google Calendar time zone."
    })
}

fn event_ref_props() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({
        "event_id": { "type": "string", "description": "event_id from list_events." },
        "calendar_id": { "type": "string", "description": "calendar_id from list_events (default the primary calendar)." },
        "account": write_account_prop()
    }) else {
        unreachable!()
    };
    map
}

fn object(mut props: serde_json::Map<String, Value>, extra: Value, required: &[&str]) -> Value {
    if let Value::Object(extra) = extra {
        props.extend(extra);
    }
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

const TIME_HELP: &str = "A date-time (2026-11-20T15:00, read in time_zone, or with an offset) or, \
    for an all-day event, a date (2026-11-20).";

const SCOPE_HELP: &str = "For a repeating event: this (the default: just this occurrence), \
    following (this and later ones) or all.";

const NOTIFY_HELP: &str = "Email the guests about it (default false: the event changes on \
    their calendars without an email). Ask the user before setting it.";

/// The calendar tools: reads need only the main switch, changes the Calendar switch.
fn calendar_tools() -> Vec<ToolDef> {
    let guests = json!({ "type": "array", "items": { "type": "string" }, "description": "Email addresses." });
    vec![
        ToolDef {
            name: "list_calendars",
            title: "List calendars",
            description: "Each account's Google calendars (id, name, primary, whether the user can \
                change them), its Calendar time zone, and whether Pheeme may read its calendar \
                (access: on; otherwise the note says what the user must do).",
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
            name: "list_events",
            title: "List events",
            description: "Events between from and to (default the next 7 days from the start of \
                today), repeating events expanded, from Pheeme's local copy of the calendars the \
                user shows. With query, only events whose title, place, description or guests \
                contain every word. Times are in the user's Calendar time zone unless time_zone \
                says otherwise.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "A date or date-time." },
                    "to": { "type": "string", "description": "A date (that whole day counts) or date-time." },
                    "query": { "type": "string" },
                    "account": account_prop(),
                    "calendar_id": { "type": "string", "description": "Only this calendar." },
                    "time_zone": time_zone_prop(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_EVENTS, "description": format!("Events (default {DEFAULT_EVENTS}).") }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "from": "2026-11-16", "to": "2026-11-20", "query": "standup" }),
        },
        ToolDef {
            name: "get_event",
            title: "Read an event",
            description: "One event in full: description, organizer, guests and their answers, \
                video call, repeat rule, and what the user may do with it (edit, answer, delete).",
            input_schema: object(event_ref_props(), json!({ "time_zone": time_zone_prop() }), &["event_id"]),
            read_only: true,
            destructive: false,
            example: json!({ "event_id": "e1", "calendar_id": "me@example.com" }),
        },
        ToolDef {
            name: "find_free_time",
            title: "Find free time",
            description: "Free slots of at least duration_minutes (default 30) between from and to \
                (default now to 7 days on), inside working hours (day_start to day_end, default \
                09:00 to 17:00, weekdays unless weekends is true). Busy means a timed event the user \
                hasn't declined and that isn't marked free, on any shown calendar of the accounts \
                (all, or account); all-day events don't count.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "A date or date-time." },
                    "to": { "type": "string", "description": "A date (that whole day counts) or date-time." },
                    "duration_minutes": { "type": "integer", "minimum": 5, "maximum": 1440 },
                    "day_start": { "type": "string", "description": "HH:MM." },
                    "day_end": { "type": "string", "description": "HH:MM." },
                    "weekends": { "type": "boolean" },
                    "account": account_prop(),
                    "time_zone": time_zone_prop(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Slots (default 20)." }
                },
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "from": "2026-11-16", "to": "2026-11-18", "duration_minutes": 60 }),
        },
        ToolDef {
            name: "create_event",
            title: "Create an event",
            description: "Create an event on a calendar (default the account's primary). end \
                defaults to an hour after start (the next day for an all-day event). Guests are \
                invited, but only emailed with notify_guests.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account": write_account_prop(),
                    "calendar_id": { "type": "string" },
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": TIME_HELP },
                    "end": { "type": "string", "description": TIME_HELP },
                    "time_zone": time_zone_prop(),
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "guests": guests,
                    "optional_guests": guests,
                    "add_meet": { "type": "boolean", "description": "Add a Google Meet link." },
                    "repeat": { "type": "array", "items": { "type": "string" }, "description": "RFC 5545 lines, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO." },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                },
                "required": ["title", "start"],
                "additionalProperties": false
            }),
            read_only: false,
            destructive: false,
            example: json!({ "title": "Lunch", "start": "2026-11-20T12:30", "guests": ["sam@example.com"] }),
        },
        ToolDef {
            name: "update_event",
            title: "Change an event",
            description: "Change an event the user may edit: give only what changes. A new start \
                alone keeps the length. add_guests and remove_guests change the guest list (those \
                already there keep their answers). Empty description or location clears it.",
            input_schema: object(
                event_ref_props(),
                json!({
                    "scope": { "type": "string", "enum": ["this", "following", "all"], "description": SCOPE_HELP },
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": TIME_HELP },
                    "end": { "type": "string", "description": TIME_HELP },
                    "time_zone": time_zone_prop(),
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "add_guests": guests,
                    "remove_guests": guests,
                    "meet": { "type": "boolean", "description": "true adds a Google Meet link, false removes it." },
                    "repeat": { "type": "array", "items": { "type": "string" }, "description": "New repeat rules; [] stops it repeating." },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                }),
                &["event_id"],
            ),
            read_only: false,
            destructive: false,
            example: json!({ "event_id": "e1", "start": "2026-11-20T14:00", "add_guests": ["sam@example.com"] }),
        },
        ToolDef {
            name: "delete_event",
            title: "Delete an event",
            description: "Delete an event (for one the user was only invited to, it leaves their \
                calendar; answer it with respond_to_event instead to tell the organizer).",
            input_schema: object(
                event_ref_props(),
                json!({
                    "scope": { "type": "string", "enum": ["this", "following", "all"], "description": SCOPE_HELP },
                    "notify_guests": { "type": "boolean", "description": NOTIFY_HELP }
                }),
                &["event_id"],
            ),
            read_only: false,
            destructive: true,
            example: json!({ "event_id": "e1", "scope": "this" }),
        },
        ToolDef {
            name: "respond_to_event",
            title: "Answer an invitation",
            description: "Answer an event the user is invited to: accepted, tentative or declined, \
                with an optional note. Google always tells the organizer.",
            input_schema: object(
                event_ref_props(),
                json!({
                    "response": { "type": "string", "enum": ["accepted", "tentative", "declined"] },
                    "comment": { "type": "string" },
                    "scope": { "type": "string", "enum": ["this", "all"], "description": "For a repeating event: this (default) or all." }
                }),
                &["event_id", "response"],
            ),
            read_only: false,
            destructive: false,
            example: json!({ "event_id": "e1", "response": "accepted" }),
        },
    ]
}

fn thread_ids_prop() -> Value {
    json!({
        "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": MAX_THREADS,
        "description": "thread_id values from list_mailbox, search_mail or get_thread."
    })
}

fn write_account_prop() -> Value {
    json!({
        "type": "string",
        "description": "The account (email address or id). Required when more than one is connected."
    })
}

/// A thread tool that also takes a search: `description` plus how `query` works.
fn query_tool(name: &'static str, title: &'static str, description: &'static str) -> ToolDef {
    ToolDef {
        input_schema: json!({
            "type": "object",
            "properties": {
                "thread_ids": thread_ids_prop(),
                "query": {
                    "type": "string",
                    "description": "Instead of thread_ids: a search (search_mail syntax, not Spam or Trash). \
                        Conversations on this computer that match change whole, at once; on Gmail, matching \
                        messages not downloaded yet change too."
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "With query: say how many cached conversations would change, and change nothing."
                },
                "account": write_account_prop()
            },
            "additionalProperties": false
        }),
        example: json!({ "query": "from:deals@example.com is:unread", "dry_run": true }),
        ..threads_tool(name, title, description, false)
    }
}

fn threads_tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    destructive: bool,
) -> ToolDef {
    ToolDef {
        name,
        title,
        description,
        input_schema: json!({
            "type": "object",
            "properties": { "thread_ids": thread_ids_prop(), "account": write_account_prop() },
            "required": ["thread_ids"],
            "additionalProperties": false
        }),
        read_only: false,
        destructive,
        example: json!({ "thread_ids": ["t1"], "account": "me@example.com" }),
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
fn tasks_tools() -> Vec<ToolDef> {
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
