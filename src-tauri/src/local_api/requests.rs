//! The tools the local API offers: their arguments ([`Request`]) and their descriptions for
//! clients ([`catalog`]), kept side by side so they can't drift (a test parses every
//! catalog entry's example).

use super::ApiError;
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
            example: json!({}),
        },
    ]
}
