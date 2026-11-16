//! The mail tools (reading, searching, organizing, labels, filters, drafts, reports): their
//! arguments, their log summaries and their descriptions for clients.

use super::{account_prop, on, write_account_prop, ToolDef};
use serde::Deserialize;
use serde_json::{json, Value};

pub const DEFAULT_LIMIT: i64 = 25;
/// The sender report's default window.
pub const DEFAULT_DAYS: i64 = 90;
/// The filter audit's default window.
pub const AUDIT_DAYS: i64 = 30;
pub const MAX_LIMIT: i64 = 100;

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

impl ListMailbox {
    pub(super) fn summary(&self) -> String {
        format!(
            "{}{}{}",
            self.mailbox.as_deref().unwrap_or("inbox"),
            if self.unread_only { " (unread)" } else { "" },
            on(&self.account)
        )
    }
}

impl SearchMail {
    pub(super) fn summary(&self) -> String {
        format!(
            "\"{}\"{}{}",
            self.query,
            if self.gmail { " on Gmail" } else { "" },
            on(&self.account)
        )
    }
}

impl CountMail {
    pub(super) fn summary(&self) -> String {
        format!(
            "count {}{}{}{}",
            match &self.query {
                Some(q) => format!("\"{q}\""),
                None => self.mailbox.clone().unwrap_or_else(|| "inbox".into()),
            },
            if self.unread_only { " (unread)" } else { "" },
            self.group_by
                .as_deref()
                .map(|g| format!(" by {g}"))
                .unwrap_or_default(),
            on(&self.account)
        )
    }
}

impl GetThread {
    pub(super) fn summary(&self) -> String {
        format!("conversation {}{}", self.thread_id, on(&self.account))
    }
}

impl ThreadsArg {
    pub(super) fn summary(&self) -> String {
        format!(
            "{}{}{}",
            match &self.query {
                Some(q) => format!("every match for \"{q}\""),
                None => conversations(self.thread_ids.len()),
            },
            if self.dry_run { " (dry run)" } else { "" },
            on(&self.account)
        )
    }
}

impl ChangeLabels {
    pub(super) fn summary(&self) -> String {
        format!(
            "{}: +[{}] -[{}]{}",
            match &self.query {
                Some(q) => format!("every match for \"{q}\""),
                None => conversations(self.thread_ids.len()),
            },
            self.add.join(", "),
            self.remove.join(", "),
            on(&self.account)
        )
    }
}

impl CreateLabel {
    pub(super) fn summary(&self) -> String {
        format!("label {}{}", self.name, on(&self.account))
    }
}

impl CreateFilter {
    pub(super) fn summary(&self) -> String {
        let mut parts = Vec::new();
        for (key, value) in [
            ("from", &self.from),
            ("to", &self.to),
            ("subject", &self.subject),
            ("query", &self.query),
        ] {
            if let Some(v) = value {
                parts.push(format!("{key}:{v}"));
            }
        }
        format!("filter {}{}", parts.join(" "), on(&self.account))
    }
}

impl DeleteFilter {
    pub(super) fn summary(&self) -> String {
        format!("filter {}{}", self.filter_id, on(&self.account))
    }
}

impl SenderReport {
    pub(super) fn summary(&self) -> String {
        format!(
            "top senders, {} days{}{}",
            self.days.unwrap_or(DEFAULT_DAYS),
            self.tab
                .as_deref()
                .map(|t| format!(" in {t}"))
                .unwrap_or_default(),
            on(&self.account)
        )
    }
}

impl FilterAudit {
    pub(super) fn summary(&self) -> String {
        format!(
            "filters' catches, {} days{}",
            self.days.unwrap_or(AUDIT_DAYS),
            on(&self.account)
        )
    }
}

impl Unsubscribe {
    pub(super) fn summary(&self) -> String {
        format!("conversation {}{}", self.thread_id, on(&self.account))
    }
}

impl CreateDraft {
    pub(super) fn summary(&self) -> String {
        format!(
            "draft \"{}\"{}{}",
            self.subject.as_deref().unwrap_or(""),
            if self.reply_to_message_id.is_some() {
                " (reply)"
            } else {
                ""
            },
            on(&self.account)
        )
    }
}

fn conversations(n: usize) -> String {
    if n == 1 {
        "1 conversation".into()
    } else {
        format!("{n} conversations")
    }
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

/// The mail tools, in the order clients list them.
pub(super) fn tools() -> Vec<ToolDef> {
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
            "Put archived, trashed or spam conversations back in the inbox: this takes them out \
             of Trash (which Gmail empties after 30 days) and Spam (as Gmail's Not spam does).",
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
                Pheeme adds the user's signature (as set in Settings › Compose), so don't sign the body.",
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
