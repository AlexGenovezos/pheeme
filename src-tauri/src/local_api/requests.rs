//! The tools the local API offers: their arguments ([`Request`]) and their descriptions for
//! clients ([`catalog`]), kept side by side so they can't drift (a test parses every
//! catalog entry's example).

use super::{ApiError, Permission};
use serde::Deserialize;
use serde_json::{json, Value};

pub const DEFAULT_LIMIT: i64 = 25;
pub const MAX_LIMIT: i64 = 100;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "tool", content = "args", rename_all = "snake_case")]
pub enum Request {
    ListAccounts(NoArgs),
    ListLabels(AccountArg),
    ListMailbox(ListMailbox),
    SearchMail(SearchMail),
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
}

/// Most conversations one call may change.
pub const MAX_THREADS: usize = 500;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadsArg {
    pub thread_ids: Vec<String>,
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeLabels {
    pub thread_ids: Vec<String>,
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
            | Request::GetThread(_)
            | Request::ListFilters(_) => None,
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
        }
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
            Request::GetThread(t) => format!("conversation {}{}", t.thread_id, on(&t.account)),
            Request::ListFilters(a) => format!("filters{}", on(&a.account)),
            Request::Archive(t)
            | Request::MoveToInbox(t)
            | Request::MarkRead(t)
            | Request::MarkUnread(t)
            | Request::Star(t)
            | Request::Unstar(t)
            | Request::Trash(t) => {
                format!("{}{}", conversations(t.thread_ids.len()), on(&t.account))
            }
            Request::ChangeLabels(c) => format!(
                "{}: +[{}] -[{}]{}",
                conversations(c.thread_ids.len()),
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
        }
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
    vec![
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
                Spam and Trash), or a user label's name. Answered from Pheeme's local copy, so it's instant.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "mailbox": { "type": "string", "description": "Default inbox." },
                    "account": account_prop(),
                    "unread_only": { "type": "boolean" },
                    "limit": limit,
                    "cursor": cursor
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
                the whole mailbox. Queries only Gmail understands go to Gmail automatically.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "account": account_prop(),
                    "gmail": { "type": "boolean", "description": "Use Gmail's search (default false)." },
                    "limit": limit,
                    "cursor": cursor
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            read_only: true,
            destructive: false,
            example: json!({ "query": "from:news@example.com newer_than:30d", "gmail": true }),
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
        threads_tool(
            "archive",
            "Archive",
            "Take conversations out of the inbox (they stay in All Mail and their labels).",
            false,
        ),
        threads_tool(
            "move_to_inbox",
            "Move to inbox",
            "Put archived conversations back in the inbox.",
            false,
        ),
        threads_tool("mark_read", "Mark as read", "Mark conversations as read.", false),
        threads_tool("mark_unread", "Mark as unread", "Mark conversations as unread.", false),
        threads_tool("star", "Star", "Star conversations.", false),
        threads_tool("unstar", "Unstar", "Remove the star from conversations.", false),
        threads_tool(
            "trash",
            "Move to Trash",
            "Move conversations to Trash (Gmail deletes them for good after 30 days).",
            true,
        ),
        ToolDef {
            name: "change_labels",
            title: "Change labels",
            description: "Add and remove user labels (by name) on conversations. Use archive, trash, \
                star and the other tools for Inbox, Trash, Starred and read state.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "thread_ids": thread_ids_prop(),
                    "account": write_account_prop(),
                    "add": { "type": "array", "items": { "type": "string" }, "description": "Label names to add." },
                    "remove": { "type": "array", "items": { "type": "string" }, "description": "Label names to remove." }
                },
                "required": ["thread_ids"],
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
