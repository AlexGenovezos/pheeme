//! The read tools, each a call into the services the UI uses. Output is shaped for a reader
//! that isn't Pheeme's UI: label names instead of ids, ISO dates, plain-text bodies.

use super::requests::{
    AccountArg, CountMail, FilterAudit, GetThread, ListMailbox, SearchMail, SenderReport,
    AUDIT_DAYS, DEFAULT_DAYS, DEFAULT_LIMIT, MAX_LIMIT,
};
use super::{ApiError, LocalApi, Request};
use crate::accounts::AccountInfo;
use crate::compose::build::html_to_text;
use crate::filters::label_names;
use crate::mail::{
    MailError, MessageDetailDto, ThreadCursorDto, ThreadSummaryDto, ALL_MAIL, MAX_PAGE,
    OTHER_CATEGORIES,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Local, SecondsFormat, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

const DEFAULT_BODY_CHARS: usize = 8000;
/// Characters of a snippet a list row keeps.
const SNIPPET_CHARS: usize = 120;
/// Most characters of rows one page returns, so an answer stays well inside what an
/// assistant reads in one go (Claude Code sets a file aside past about 25k tokens). A longer
/// page stops early and its cursor continues from there.
const PAGE_CHARS: usize = 60_000;
/// Most characters of message bodies get_thread returns, shared between its messages unless
/// the caller sets `max_chars_per_message`.
const THREAD_CHARS: usize = 60_000;

pub(super) async fn run(api: &LocalApi, request: Request) -> Result<Value, ApiError> {
    match request {
        Request::ListAccounts(_) => list_accounts(api).await,
        Request::ListLabels(a) => list_labels(api, a).await,
        Request::ListMailbox(m) => list_mailbox(api, m).await,
        Request::SearchMail(s) => search_mail(api, s).await,
        Request::CountMail(c) => count_mail(api, c).await,
        Request::GetThread(t) => get_thread(api, t).await,
        Request::ListFilters(a) => list_filters(api, a).await,
        Request::SenderReport(r) => sender_report(api, r).await,
        Request::FilterAudit(a) => filter_audit(api, a).await,
        _ => Err(ApiError::Invalid("That tool changes mail.".into())),
    }
}

fn to_value(value: impl Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::Invalid(e.to_string()))
}

/// The accounts `account` names (an email address or id, any case), or all of them.
pub(super) async fn resolve_accounts(
    api: &LocalApi,
    account: Option<&str>,
) -> Result<Vec<AccountInfo>, ApiError> {
    let all = api.accounts.list_accounts().await?;
    if all.is_empty() {
        return Err(ApiError::Invalid(
            "No Gmail account is connected to Pheeme yet.".into(),
        ));
    }
    let Some(wanted) = account.map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(all);
    };
    let found: Vec<AccountInfo> = all
        .iter()
        .filter(|a| a.id == wanted || a.email.eq_ignore_ascii_case(wanted))
        .cloned()
        .collect();
    if found.is_empty() {
        let emails: Vec<&str> = all.iter().map(|a| a.email.as_str()).collect();
        return Err(ApiError::Invalid(format!(
            "No connected account is {wanted}. Connected: {}.",
            emails.join(", ")
        )));
    }
    Ok(found)
}

fn iso(ms: i64) -> Option<String> {
    (ms > 0)
        .then(|| Local.timestamp_millis_opt(ms).single())
        .flatten()
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Secs, false))
}

fn sender(name: Option<&str>, address: Option<&str>) -> Option<String> {
    match (name.filter(|n| !n.is_empty()), address) {
        (Some(n), Some(a)) => Some(format!("{n} <{a}>")),
        (None, Some(a)) => Some(a.to_owned()),
        (Some(n), None) => Some(n.to_owned()),
        (None, None) => None,
    }
}

fn address(a: &crate::gmail::mime::EmailAddress) -> String {
    sender(a.name.as_deref(), Some(&a.address)).unwrap_or_default()
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_one(n: &i64) -> bool {
    *n == 1
}

/// A conversation in a list. Kept small, since an assistant may read hundreds: flags only
/// when set, `account` only when there's a choice.
#[derive(Debug, Serialize)]
pub(super) struct ThreadRow {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub unread: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub starred: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub has_attachment: bool,
    #[serde(skip_serializing_if = "is_one")]
    pub messages: i64,
    /// Where it sits (inbox, promotions, trash...) then user label names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// A Gmail system label as the mailbox names and search syntax say it, or `None` for the
/// ones a row shows as flags (unread, starred).
fn system_label(id: &str) -> Option<String> {
    Some(
        match id {
            "UNREAD" | "STARRED" => return None,
            "CATEGORY_PERSONAL" => "primary",
            "CATEGORY_PROMOTIONS" => "promotions",
            "CATEGORY_SOCIAL" => "social",
            "CATEGORY_UPDATES" => "updates",
            "CATEGORY_FORUMS" => "forums",
            other => return Some(other.to_lowercase()),
        }
        .to_owned(),
    )
}

/// A row's labels: system labels by name (see [`system_label`]), then user labels by name.
fn label_list(system: &[String], user: &[String], names: &HashMap<String, String>) -> Vec<String> {
    system
        .iter()
        .filter_map(|id| system_label(id))
        .chain(
            user.iter()
                .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone())),
        )
        .collect()
}

/// Characters mail uses to pad its preview text that show as nothing (zero-width spaces and
/// joiners, soft hyphens, the combining grapheme joiner, Hangul fillers, BOM...).
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{2800}'
            | '\u{3164}'
            | '\u{FEFF}'
            | '\u{FFA0}'
    )
}

/// A snippet without invisible padding or runs of spaces, cut to [`SNIPPET_CHARS`].
fn clean_snippet(snippet: &str) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in snippet.chars().filter(|c| !invisible(*c)) {
        if c.is_whitespace() {
            space = !out.is_empty();
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    let (mut out, cut_short) = cut(out, SNIPPET_CHARS);
    if cut_short {
        out.truncate(out.trim_end().len());
        out.push('…');
    }
    (!out.is_empty()).then_some(out)
}

/// Turns summaries into rows, naming each account's labels once.
pub(super) struct Rows<'a> {
    api: &'a LocalApi,
    emails: HashMap<String, String>,
    names: HashMap<String, HashMap<String, String>>,
    hidden_tabs: HashMap<String, Vec<String>>,
    compact: bool,
}

impl<'a> Rows<'a> {
    pub async fn new(api: &'a LocalApi) -> Result<Self, ApiError> {
        let emails = api
            .accounts
            .list_accounts()
            .await?
            .into_iter()
            .map(|a| (a.id, a.email))
            .collect();
        Ok(Self {
            api,
            emails,
            names: HashMap::new(),
            hidden_tabs: HashMap::new(),
            compact: false,
        })
    }

    /// Rows without snippets or labels.
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    /// The inbox tabs the account hides (their mail shows under Primary).
    pub async fn hidden_tabs(&mut self, account_id: &str) -> Result<&[String], ApiError> {
        if !self.hidden_tabs.contains_key(account_id) {
            let hidden = self.api.mail.inbox_tabs(account_id).await?;
            self.hidden_tabs.insert(account_id.to_owned(), hidden);
        }
        Ok(&self.hidden_tabs[account_id])
    }

    pub async fn label_names(
        &mut self,
        account_id: &str,
    ) -> Result<&HashMap<String, String>, ApiError> {
        if !self.names.contains_key(account_id) {
            let names = label_names(&self.api.db, account_id).await?;
            self.names.insert(account_id.to_owned(), names);
        }
        Ok(&self.names[account_id])
    }

    pub fn email(&self, account_id: &str) -> String {
        self.emails
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| account_id.to_owned())
    }

    pub async fn rows(
        &mut self,
        threads: Vec<ThreadSummaryDto>,
    ) -> Result<Vec<ThreadRow>, ApiError> {
        let mut out = Vec::with_capacity(threads.len());
        for t in threads {
            out.push(self.row(t).await?);
        }
        Ok(out)
    }

    async fn row(&mut self, t: ThreadSummaryDto) -> Result<ThreadRow, ApiError> {
        let compact = self.compact;
        let account = (self.emails.len() > 1).then(|| self.email(&t.account_id));
        let labels = if compact {
            Vec::new()
        } else {
            let names = self.label_names(&t.account_id).await?;
            label_list(&t.system_label_ids, &t.label_ids, names)
        };
        Ok(ThreadRow {
            account,
            thread_id: t.id,
            from: sender(t.from_name.as_deref(), t.from_address.as_deref()),
            date: iso(t.date),
            subject: t.subject,
            snippet: t
                .snippet
                .as_deref()
                .filter(|_| !compact)
                .and_then(clean_snippet),
            unread: t.unread,
            starred: t.starred,
            has_attachment: t.has_attachment,
            messages: t.message_count,
            labels,
        })
    }

    /// Rows for `threads` up to [`PAGE_CHARS`] of JSON (at least one), and when that cut the
    /// page short, the cursor after the last row kept.
    pub async fn page(
        &mut self,
        threads: Vec<ThreadSummaryDto>,
    ) -> Result<(Vec<ThreadRow>, Option<ThreadCursorDto>), ApiError> {
        let total = threads.len();
        let mut out = Vec::with_capacity(total);
        let mut size = 0;
        let mut last = None;
        for t in threads {
            let cursor = ThreadCursorDto {
                last_message_date: t.date,
                account_id: t.account_id.clone(),
                thread_id: t.id.clone(),
            };
            let row = self.row(t).await?;
            size += serde_json::to_string(&row).map_or(0, |j| j.len() + 1);
            if size > PAGE_CHARS && !out.is_empty() {
                break;
            }
            out.push(row);
            last = Some(cursor);
        }
        Ok(if out.len() < total {
            (out, last)
        } else {
            (out, None)
        })
    }
}

/// Where the next page starts, handed to the client as an opaque string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Cursor {
    Local(ThreadCursorDto),
    /// A Gmail results page (`None`: the first) and how many of its conversations were
    /// already returned.
    Gmail {
        tokens: Option<HashMap<String, String>>,
        skip: usize,
    },
}

fn encode_cursor(cursor: &Cursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).unwrap_or_default())
}

fn decode_cursor(raw: Option<&str>) -> Result<Option<Cursor>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .map(Some)
        .ok_or_else(|| ApiError::Invalid("That cursor isn't one Pheeme gave out.".into()))
}

fn limit(requested: Option<i64>) -> i64 {
    requested.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

async fn list_accounts(api: &LocalApi) -> Result<Value, ApiError> {
    let accounts: Vec<Value> = api
        .accounts
        .list_accounts()
        .await?
        .into_iter()
        .map(|a| {
            json!({
                "account": a.email,
                "id": a.id,
                "name": a.display_name,
                "synced": a.synced,
            })
        })
        .collect();
    Ok(json!({ "accounts": accounts }))
}

async fn list_labels(api: &LocalApi, args: AccountArg) -> Result<Value, ApiError> {
    let mut out = Vec::new();
    for account in resolve_accounts(api, args.account.as_deref()).await? {
        let labels: Vec<Value> = api
            .mail
            .list_labels(&account.id)
            .await?
            .into_iter()
            .map(|l| {
                json!({
                    "name": l.name,
                    "id": l.id,
                    "type": l.label_type,
                    "conversations": l.threads_total,
                    "unread_conversations": l.threads_unread,
                })
            })
            .collect();
        out.push(json!({ "account": account.email, "labels": labels }));
    }
    Ok(json!({ "accounts": out }))
}

/// A mailbox name as the label to list (and, for an inbox tab, the category with it).
fn system_mailbox(name: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match name {
        "inbox" => ("INBOX", None),
        "primary" => ("INBOX", Some("CATEGORY_PERSONAL")),
        "social" => ("INBOX", Some("CATEGORY_SOCIAL")),
        "promotions" => ("INBOX", Some("CATEGORY_PROMOTIONS")),
        "updates" => ("INBOX", Some("CATEGORY_UPDATES")),
        "forums" => ("INBOX", Some("CATEGORY_FORUMS")),
        "starred" => ("STARRED", None),
        "important" => ("IMPORTANT", None),
        "sent" => ("SENT", None),
        "drafts" | "draft" => ("DRAFT", None),
        "spam" => ("SPAM", None),
        "trash" => ("TRASH", None),
        "all" | "all mail" => (ALL_MAIL, None),
        _ => return None,
    })
}

/// What a mailbox name lists: its label, the inbox tab's category with it, and the accounts.
struct Mailbox {
    name: String,
    label_id: String,
    also: Option<&'static str>,
    account_ids: Vec<String>,
}

async fn resolve_mailbox(
    api: &LocalApi,
    mailbox: Option<&str>,
    account: Option<&str>,
) -> Result<Mailbox, ApiError> {
    let mailbox = mailbox
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("inbox");
    let accounts = resolve_accounts(api, account).await?;
    let (label_id, also, account_ids) = match system_mailbox(&mailbox.to_lowercase()) {
        Some((_, Some(_))) if accounts.len() > 1 => {
            let emails: Vec<&str> = accounts.iter().map(|a| a.email.as_str()).collect();
            return Err(ApiError::Invalid(format!(
                "Inbox tabs are per account. Say which: {}.",
                emails.join(", ")
            )));
        }
        Some((label, also)) => (
            label.to_owned(),
            also,
            accounts.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
        ),
        None => {
            let mut matches = Vec::new();
            for account in &accounts {
                for label in api.mail.list_labels(&account.id).await? {
                    if label.id == mailbox || label.name.eq_ignore_ascii_case(mailbox) {
                        matches.push((account.clone(), label.id));
                    }
                }
            }
            match matches.len() {
                0 => {
                    return Err(ApiError::Invalid(format!(
                    "There's no mailbox or label called {mailbox}. list_labels shows the labels."
                )))
                }
                1 => {
                    let (account, label) = matches.remove(0);
                    (label, None, vec![account.id])
                }
                _ => {
                    let emails: Vec<&str> = matches.iter().map(|(a, _)| a.email.as_str()).collect();
                    return Err(ApiError::Invalid(format!(
                        "More than one account has a label called {mailbox}. Say which: {}.",
                        emails.join(", ")
                    )));
                }
            }
        }
    };
    Ok(Mailbox {
        name: mailbox.to_owned(),
        label_id,
        also,
        account_ids,
    })
}

impl Mailbox {
    /// A page of the mailbox (unread conversations only with `unread_only`).
    async fn page(
        &self,
        api: &LocalApi,
        before: Option<ThreadCursorDto>,
        limit: i64,
        unread_only: bool,
    ) -> Result<crate::mail::ThreadPageDto, ApiError> {
        let read_filter: Option<&[(String, String)]> = unread_only.then_some(&[]);
        Ok(api
            .mail
            .list_threads(
                &self.account_ids,
                &self.label_id,
                self.also,
                before,
                Some(limit),
                read_filter,
            )
            .await?)
    }
}

async fn list_mailbox(api: &LocalApi, args: ListMailbox) -> Result<Value, ApiError> {
    let before = match decode_cursor(args.cursor.as_deref())? {
        None => None,
        Some(Cursor::Local(c)) => Some(c),
        Some(Cursor::Gmail { .. }) => {
            return Err(ApiError::Invalid("That cursor is from a search.".into()))
        }
    };
    let mailbox = resolve_mailbox(api, args.mailbox.as_deref(), args.account.as_deref()).await?;
    let page = mailbox
        .page(api, before, limit(args.limit), args.unread_only)
        .await?;
    let (threads, cut) = Rows::new(api)
        .await?
        .compact(args.compact)
        .page(page.threads)
        .await?;
    Ok(json!({
        "mailbox": mailbox.name,
        "threads": threads,
        "next_cursor": cut.or(page.next).map(|c| encode_cursor(&Cursor::Local(c))),
    }))
}

async fn search_mail(api: &LocalApi, args: SearchMail) -> Result<Value, ApiError> {
    let query = args.query.trim();
    if query.is_empty() {
        return Err(ApiError::Invalid("Give a search query.".into()));
    }
    let account_ids: Vec<String> = resolve_accounts(api, args.account.as_deref())
        .await?
        .into_iter()
        .map(|a| a.id)
        .collect();
    let cursor = decode_cursor(args.cursor.as_deref())?;
    let mut rows = Rows::new(api).await?.compact(args.compact);

    let limit = limit(args.limit);
    let local_cursor = match cursor {
        Some(Cursor::Gmail { tokens, skip }) => {
            return gmail_search(api, &mut rows, &account_ids, query, tokens, skip, limit).await
        }
        Some(Cursor::Local(c)) => Some(c),
        None => None,
    };
    if args.gmail {
        return gmail_search(api, &mut rows, &account_ids, query, None, 0, limit).await;
    }
    let page = api
        .mail
        .search_messages(&account_ids, query, local_cursor, Some(limit))
        .await?;
    if !page.local {
        return gmail_search(api, &mut rows, &account_ids, query, None, 0, limit).await;
    }
    let (threads, cut) = rows.page(page.threads).await?;
    let note =
        "Old mail may not be cached. Search again with gmail: true to search the whole mailbox.";
    Ok(json!({
        "searched": "the mail cached on this computer",
        "note": match spam_trash_note(query) {
            Some(trash) => format!("{note} {trash}"),
            None => note.to_owned(),
        },
        "threads": threads,
        "next_cursor": cut.or(page.next).map(|c| encode_cursor(&Cursor::Local(c))),
    }))
}

/// How count_mail groups conversations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GroupBy {
    Sender,
    Domain,
    Label,
    Tab,
    Month,
}

impl GroupBy {
    fn parse(name: Option<&str>) -> Result<Option<Self>, ApiError> {
        let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
            return Ok(None);
        };
        Ok(Some(match name.to_lowercase().as_str() {
            "sender" | "from" => Self::Sender,
            "domain" => Self::Domain,
            "label" | "labels" => Self::Label,
            "tab" | "category" => Self::Tab,
            "month" => Self::Month,
            other => {
                return Err(ApiError::Invalid(format!(
                    "count_mail can't group by {other}: use sender, domain, label, tab or month."
                )))
            }
        }))
    }

    /// The groups a conversation counts in, each with a display name when the key isn't one.
    /// `hidden`: the account's hidden inbox tabs, whose mail shows under Primary.
    fn keys(
        self,
        t: &ThreadSummaryDto,
        names: &HashMap<String, String>,
        hidden: &[String],
    ) -> Vec<(String, Option<String>)> {
        let address = t
            .from_address
            .as_deref()
            .map(str::to_lowercase)
            .filter(|a| !a.is_empty());
        match self {
            Self::Sender => vec![(
                address.unwrap_or_else(|| "(no sender)".into()),
                t.from_name.clone().filter(|n| !n.is_empty()),
            )],
            Self::Domain => vec![(
                address
                    .as_deref()
                    .and_then(|a| a.rsplit_once('@'))
                    .map_or("(no sender)", |(_, d)| d)
                    .to_owned(),
                None,
            )],
            Self::Label => label_list(&t.system_label_ids, &t.label_ids, names)
                .into_iter()
                .map(|l| (l, None))
                .collect(),
            Self::Tab => {
                let tab = t
                    .system_label_ids
                    .iter()
                    .filter(|l| OTHER_CATEGORIES.contains(&l.as_str()) && !hidden.contains(l))
                    .find_map(|l| system_label(l))
                    .unwrap_or_else(|| "primary".into());
                vec![(tab, None)]
            }
            Self::Month => vec![(
                iso(t.date).map_or_else(|| "(no date)".into(), |d| d[..7].to_owned()),
                None,
            )],
        }
    }
}

/// count_mail's tally.
#[derive(Default)]
struct Tally {
    conversations: i64,
    unread: i64,
    groups: HashMap<String, (Option<String>, i64, i64)>,
}

impl Tally {
    async fn add(
        &mut self,
        rows: &mut Rows<'_>,
        group_by: Option<GroupBy>,
        unread_only: bool,
        threads: Vec<ThreadSummaryDto>,
    ) -> Result<(), ApiError> {
        for t in threads.iter().filter(|t| t.unread || !unread_only) {
            self.conversations += 1;
            self.unread += i64::from(t.unread);
            let Some(group_by) = group_by else { continue };
            let hidden = match group_by {
                GroupBy::Tab => rows.hidden_tabs(&t.account_id).await?.to_vec(),
                _ => Vec::new(),
            };
            let names = rows.label_names(&t.account_id).await?;
            for (key, name) in group_by.keys(t, names, &hidden) {
                let entry = self.groups.entry(key).or_insert((name, 0, 0));
                entry.1 += 1;
                entry.2 += i64::from(t.unread);
            }
        }
        Ok(())
    }

    fn finish(self, group_by: Option<GroupBy>, limit: usize) -> Value {
        let mut out = json!({
            "conversations": self.conversations,
            "unread": self.unread,
            "counted": "the mail cached on this computer",
        });
        if group_by.is_some() {
            let mut groups: Vec<_> = self.groups.into_iter().collect();
            groups.sort_by(|(ka, a), (kb, b)| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(ka.cmp(kb)));
            let more = groups.len().saturating_sub(limit);
            out["groups"] = groups
                .into_iter()
                .take(limit)
                .map(|(key, (name, conversations, unread))| {
                    let mut g =
                        json!({ "group": key, "conversations": conversations, "unread": unread });
                    if let Some(name) = name {
                        g["name"] = json!(name);
                    }
                    g
                })
                .collect();
            if more > 0 {
                out["more_groups"] = json!(more);
            }
        }
        out
    }
}

async fn count_mail(api: &LocalApi, args: CountMail) -> Result<Value, ApiError> {
    let group_by = GroupBy::parse(args.group_by.as_deref())?;
    let query = args
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    if query.is_some() && args.mailbox.is_some() {
        return Err(ApiError::Invalid("Give either query or mailbox.".into()));
    }
    let mut rows = Rows::new(api).await?;
    let mut tally = Tally::default();
    let mut before = None;
    match query {
        Some(query) => {
            let account_ids: Vec<String> = resolve_accounts(api, args.account.as_deref())
                .await?
                .into_iter()
                .map(|a| a.id)
                .collect();
            loop {
                let page = api
                    .mail
                    .search_messages(&account_ids, query, before, Some(MAX_PAGE))
                    .await?;
                if !page.local {
                    return Err(ApiError::Invalid(
                        "count_mail counts the mail on this computer, and only Gmail understands \
                         that search (OR, -word, grouping...). Rephrase it, or page through \
                         search_mail with gmail: true."
                            .into(),
                    ));
                }
                tally
                    .add(&mut rows, group_by, args.unread_only, page.threads)
                    .await?;
                match page.next {
                    Some(next) => before = Some(next),
                    None => break,
                }
            }
        }
        None => {
            let mailbox =
                resolve_mailbox(api, args.mailbox.as_deref(), args.account.as_deref()).await?;
            loop {
                let page = mailbox
                    .page(api, before, MAX_PAGE, args.unread_only)
                    .await?;
                tally
                    .add(&mut rows, group_by, args.unread_only, page.threads)
                    .await?;
                match page.next {
                    Some(next) => before = Some(next),
                    None => break,
                }
            }
        }
    }
    Ok(tally.finish(group_by, limit(args.limit) as usize))
}

/// Up to `limit` conversations of a Gmail results page, from `skip` on. Gmail's pages are
/// bigger than most limits, so the cursor returns to the same page until it's used up.
async fn gmail_search(
    api: &LocalApi,
    rows: &mut Rows<'_>,
    account_ids: &[String],
    query: &str,
    tokens: Option<HashMap<String, String>>,
    skip: usize,
    limit: i64,
) -> Result<Value, ApiError> {
    let page = api
        .mail
        .search_gmail(account_ids, query, tokens.clone())
        .await?;
    let failed: Vec<String> = page.failed.iter().map(|a| rows.email(a)).collect();
    let found = page.threads.len();
    let threads: Vec<_> = page
        .threads
        .into_iter()
        .skip(skip)
        .take(limit as usize)
        .collect();
    let (threads, cut) = rows.page(threads).await?;
    let end = skip.saturating_add(threads.len());
    let next = if cut.is_some() || end < found {
        Some(Cursor::Gmail { tokens, skip: end })
    } else if !page.next.is_empty() {
        Some(Cursor::Gmail {
            tokens: Some(page.next),
            skip: 0,
        })
    } else {
        None
    };
    let mut out = json!({
        "searched": "Gmail",
        "threads": threads,
        "failed_accounts": failed,
        "next_cursor": next.map(|c| encode_cursor(&c)),
    });
    if let Some(note) = spam_trash_note(query) {
        out["note"] = json!(note);
    }
    Ok(out)
}

/// The reminder that a search left out Trash and Spam, unless it asked for them: an empty
/// answer otherwise reads as "nothing matches" when a filter put it all in Trash.
fn spam_trash_note(query: &str) -> Option<&'static str> {
    (!crate::search::gmail_query(query).1)
        .then_some("Trash and Spam are left out; add in:anywhere to include them.")
}

/// A message, as text.
#[derive(Debug, Serialize)]
struct MessageOut {
    message_id: String,
    from: Option<String>,
    to: Vec<String>,
    cc: Vec<String>,
    date: Option<String>,
    subject: Option<String>,
    unread: bool,
    starred: bool,
    labels: Vec<String>,
    body: Option<String>,
    /// The body was cut at `max_chars_per_message`.
    body_truncated: bool,
    /// Only the headers are on this computer, and Gmail couldn't be reached for the body.
    body_missing: bool,
    attachments: Vec<Value>,
}

fn message_text(m: &MessageDetailDto) -> Option<String> {
    m.body_text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| m.body_html.as_deref().map(html_to_text))
}

fn cut(text: String, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (text[..at].to_owned(), true),
        None => (text, false),
    }
}

async fn get_thread(api: &LocalApi, args: GetThread) -> Result<Value, ApiError> {
    let thread_id = args.thread_id.trim();
    if thread_id.is_empty() {
        return Err(ApiError::Invalid("Give a thread_id.".into()));
    }
    let asked = args.max_chars_per_message.map(|m| m.max(200));
    let mut found = None;
    for account in resolve_accounts(api, args.account.as_deref()).await? {
        match api.mail.get_thread(&account.id, thread_id, false).await {
            Ok(detail) => {
                found = Some(detail);
                break;
            }
            Err(MailError::NotFound) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    let detail = found.ok_or(ApiError::Mail(MailError::NotFound))?;
    let mut rows = Rows::new(api).await?;
    let account_id = detail.thread.account_id.clone();
    let names = rows.label_names(&account_id).await?.clone();
    // Unless the caller chose, long conversations share THREAD_CHARS between their messages.
    let max = asked.unwrap_or_else(|| {
        (THREAD_CHARS / detail.messages.len().max(1)).clamp(200, DEFAULT_BODY_CHARS)
    });
    let messages: Vec<MessageOut> = detail
        .messages
        .iter()
        .map(|m| {
            let (body, body_truncated) = match message_text(m) {
                Some(text) => {
                    let (text, cut) = cut(text, max);
                    (Some(text), cut)
                }
                None => (None, false),
            };
            MessageOut {
                message_id: m.id.clone(),
                from: sender(m.from_name.as_deref(), m.from_address.as_deref()),
                to: m.to.iter().map(address).collect(),
                cc: m.cc.iter().map(address).collect(),
                date: iso(m.date),
                subject: m.subject.clone(),
                unread: m.unread,
                starred: m.starred,
                labels: m
                    .label_ids
                    .iter()
                    .filter_map(|id| match names.get(id) {
                        Some(name) => Some(name.clone()),
                        None => system_label(id),
                    })
                    .collect(),
                body,
                body_truncated,
                body_missing: !m.body_available,
                attachments: m
                    .attachments
                    .iter()
                    .filter(|a| !a.is_inline)
                    .map(|a| json!({ "filename": a.filename, "mime_type": a.mime_type, "size": a.size }))
                    .collect(),
            }
        })
        .collect();
    let thread = rows.rows(vec![detail.thread]).await?.remove(0);
    Ok(json!({
        "thread": thread,
        "messages": to_value(messages)?,
        "body_error": detail.body_error.map(|e| e.message),
    }))
}

async fn list_filters(api: &LocalApi, args: AccountArg) -> Result<Value, ApiError> {
    let mut out = Vec::new();
    for account in resolve_accounts(api, args.account.as_deref()).await? {
        let filters = api.filters.list(&account.id).await?;
        out.push(json!({ "account": account.email, "filters": to_value(filters)? }));
    }
    Ok(json!({ "accounts": out }))
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The sender report's counts an assistant can read as 0 when they're left out.
const ZERO_LEFT_OUT: [&str; 8] = [
    "unread",
    "replied",
    "starred",
    "engaged",
    "in_inbox",
    "in_trash",
    "in_spam",
    "you_wrote",
];

async fn sender_report(api: &LocalApi, args: SenderReport) -> Result<Value, ApiError> {
    let days = args.days.unwrap_or(DEFAULT_DAYS).clamp(1, 3650);
    let since = crate::sync::engine::now_ms() - days * DAY_MS;
    let tab = match args.tab.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        None => None,
        Some(t) => Some(super::write::category_id(t)?),
    };
    let by_unread = match args.sort_by.as_deref().map(str::trim) {
        None | Some("") | Some("messages") => false,
        Some("unread") => true,
        Some(other) => {
            return Err(ApiError::Invalid(format!(
                "sender_report sorts by messages or unread, not {other}."
            )))
        }
    };
    let mut out = Vec::new();
    for account in resolve_accounts(api, args.account.as_deref()).await? {
        // Primary is the mail in no shown tab: a hidden tab's mail shows there.
        let primary = tab == Some("CATEGORY_PERSONAL");
        let excludes = match primary {
            true => crate::mail::primary_excludes(&api.mail.inbox_tabs(&account.id).await?),
            false => Vec::new(),
        };
        let senders = crate::senders::report(
            &api.db,
            &account.id,
            &account.email,
            &crate::db::messages::SenderQuery {
                since_ms: since,
                limit: limit(args.limit),
                category: tab.filter(|_| !primary),
                not_in: primary.then_some(excludes.as_slice()),
                by_unread,
            },
        )
        .await?;
        let senders: Vec<Value> = senders
            .into_iter()
            .map(|s| {
                let mut v = serde_json::to_value(&s).unwrap_or_default();
                v["last_date"] = json!(iso(s.last_date));
                if let Some(fields) = v.as_object_mut() {
                    fields.retain(|k, v| {
                        !(v.is_null() || ZERO_LEFT_OUT.contains(&k.as_str()) && v == &json!(0))
                    });
                }
                v
            })
            .collect();
        out.push(json!({ "account": account.email, "senders": senders }));
    }
    Ok(json!({
        "days": days,
        "note": "Counts come from the mail on this computer, received mail only.",
        "accounts": out,
    }))
}

/// Gmail search for what a filter's criteria match (Gmail's own criteria field names).
fn filter_query(criteria: &serde_json::Map<String, Value>) -> Option<String> {
    let text = |key: &str| {
        criteria
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let mut parts = Vec::new();
    for (key, op) in [("from", "from"), ("to", "to"), ("subject", "subject")] {
        if let Some(v) = text(key) {
            parts.push(format!("{op}:({v})"));
        }
    }
    if let Some(v) = text("query") {
        parts.push(format!("({v})"));
    }
    if let Some(v) = text("negatedQuery") {
        parts.push(format!("-({v})"));
    }
    if criteria.get("hasAttachment") == Some(&Value::Bool(true)) {
        parts.push("has:attachment".into());
    }
    if let Some(size) = criteria.get("size").and_then(Value::as_i64) {
        match criteria.get("sizeComparison").and_then(Value::as_str) {
            Some("larger") => parts.push(format!("larger:{size}")),
            Some("smaller") => parts.push(format!("smaller:{size}")),
            _ => {}
        }
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// How far back filter_audit looks for wanted mail: what a filter misfiles turns up now and
/// then (an order confirmation, a statement), so a month's sample rarely shows it.
const WANTED_DAYS: i64 = 365;

/// What makes matched mail look wanted, as Gmail search: starred, in Primary or Updates, or
/// a subject that order, bill, delivery and account email uses. Marketing mostly sits in
/// Promotions, so few of its conversations qualify.
const WANTED_HINTS: &str = "{is:starred category:primary category:updates subject:(receipt OR \
    invoice OR order OR statement OR payment OR bill OR shipped OR delivered OR delivery OR \
    verify OR verification OR password OR security OR expire OR expires OR expiring OR renew \
    OR renewal OR refund OR confirmation OR confirmed OR \"action required\" OR \"action needed\")}";

/// The Gmail search for matched mail that looks wanted (see [`WANTED_HINTS`]).
fn wanted_query(criteria: &str, days: i64) -> String {
    format!(
        "{criteria} {WANTED_HINTS} in:anywhere newer_than:{}d",
        days.max(WANTED_DAYS)
    )
}

/// Where each conversation sits now, counted: trash, spam, inbox or archived.
fn now_in(threads: &[ThreadSummaryDto]) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for t in threads {
        let has = |id: &str| t.system_label_ids.iter().any(|l| l == id);
        let place = if has("TRASH") {
            "trash"
        } else if has("SPAM") {
            "spam"
        } else if has("INBOX") {
            "inbox"
        } else {
            "archived"
        };
        *counts.entry(place).or_default() += 1;
    }
    counts
}

async fn filter_audit(api: &LocalApi, args: FilterAudit) -> Result<Value, ApiError> {
    let days = args.days.unwrap_or(AUDIT_DAYS).clamp(1, 3650);
    let sample = args.sample.unwrap_or(5).clamp(1, 50);
    let mut rows = Rows::new(api).await?.compact(args.compact);
    let mut out = Vec::new();
    for account in resolve_accounts(api, args.account.as_deref()).await? {
        let accounts = std::slice::from_ref(&account.id);
        let mut audited = Vec::new();
        for filter in api.filters.list(&account.id).await? {
            let acts = filter.trashes || filter.skips_inbox || filter.marks_read;
            if !args.all && !acts {
                continue;
            }
            let Some(criteria) = filter_query(&filter.criteria) else {
                audited.push(
                    json!({ "filter": filter, "note": "Pheeme can't search for these criteria." }),
                );
                continue;
            };
            let query = format!("{criteria} in:anywhere newer_than:{days}d");
            let mut entry = match api.mail.search_gmail(accounts, &query, None).await {
                Ok(page) => {
                    let now_in = now_in(&page.threads);
                    let matched = page.threads.len();
                    let caught: Vec<_> = page.threads.into_iter().take(sample).collect();
                    json!({
                        "filter": filter,
                        "gmail_query": query,
                        "matched": matched,
                        "more": !page.next.is_empty(),
                        "now_in": now_in,
                        "caught": rows.rows(caught).await?,
                    })
                }
                Err(e) => json!({ "filter": filter, "gmail_query": query, "error": e.to_string() }),
            };
            if acts {
                let wanted = wanted_query(&criteria, days);
                match api.mail.search_gmail(accounts, &wanted, None).await {
                    Ok(page) if page.threads.is_empty() => {}
                    Ok(page) => {
                        let found: Vec<_> = page.threads.into_iter().take(sample).collect();
                        entry["worth_checking"] = json!(rows.rows(found).await?);
                        entry["worth_checking_query"] = json!(wanted);
                    }
                    Err(e) => entry["worth_checking_error"] = json!(e.to_string()),
                }
            }
            audited.push(entry);
        }
        out.push(json!({ "account": account.email, "filters": audited }));
    }
    Ok(json!({
        "days": days,
        "note": "Gmail filters act when mail arrives; 'caught' is a sample of what their criteria \
                 match now, 'matched' and 'now_in' count up to the first 50, and 'worth_checking' \
                 is matched mail from the last year that looks wanted.",
        "accounts": out,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_criteria_become_gmail_queries() {
        let criteria = json!({
            "from": "a@x.com OR b@y.com", "subject": "Sale", "query": "deal",
            "negatedQuery": "invoice", "hasAttachment": true, "size": 1000, "sizeComparison": "larger"
        });
        assert_eq!(
            filter_query(criteria.as_object().unwrap()).as_deref(),
            Some("from:(a@x.com OR b@y.com) subject:(Sale) (deal) -(invoice) has:attachment larger:1000")
        );
        assert_eq!(
            filter_query(json!({ "from": " " }).as_object().unwrap()),
            None
        );
    }

    #[test]
    fn wanted_mail_is_looked_for_over_a_year_at_least() {
        let q = wanted_query("from:(shop.com)", 30);
        assert!(q.starts_with("from:(shop.com) {is:starred category:primary category:updates subject:(receipt OR invoice"));
        assert!(
            q.ends_with("\"action needed\")} in:anywhere newer_than:365d"),
            "{q}"
        );
        assert!(!q.contains("  "), "{q}");
        assert!(wanted_query("x", 800).ends_with("newer_than:800d"));
    }

    #[test]
    fn only_searches_that_skip_trash_say_so() {
        assert!(spam_trash_note("from:shop.com").is_some());
        assert!(spam_trash_note("from:shop.com in:anywhere").is_none());
        assert!(spam_trash_note("in:trash sale").is_none());
    }

    #[test]
    fn cursors_round_trip_and_reject_junk() {
        let local = Cursor::Local(ThreadCursorDto {
            last_message_date: 5,
            account_id: "a".into(),
            thread_id: "t".into(),
        });
        let raw = encode_cursor(&local);
        assert_eq!(decode_cursor(Some(&raw)).unwrap(), Some(local));
        let gmail = Cursor::Gmail {
            tokens: Some(HashMap::from([("a".into(), "tok".into())])),
            skip: 3,
        };
        assert_eq!(
            decode_cursor(Some(&encode_cursor(&gmail))).unwrap(),
            Some(gmail)
        );
        assert_eq!(decode_cursor(None).unwrap(), None);
        assert_eq!(decode_cursor(Some("  ")).unwrap(), None);
        assert!(decode_cursor(Some("not a cursor")).is_err());
    }

    #[test]
    fn snippets_lose_invisible_padding_and_stay_short() {
        let padded = format!(
            "One last shot at $10k\u{200c} \u{200c} \u{034f}\u{00a0}{}",
            "\u{200c} ".repeat(80)
        );
        assert_eq!(
            clean_snippet(&padded).as_deref(),
            Some("One last shot at $10k")
        );
        assert_eq!(clean_snippet("\u{200b}\u{feff} "), None);
        let long = clean_snippet(&"word ".repeat(100)).unwrap();
        assert!(long.ends_with("word…"), "{long}");
        assert_eq!(long.chars().count(), SNIPPET_CHARS);
    }

    #[test]
    fn system_labels_read_like_mailbox_names() {
        let names = HashMap::from([("Label_1".to_owned(), "Receipts".to_owned())]);
        let system =
            ["CATEGORY_PROMOTIONS", "INBOX", "STARRED", "UNREAD", "TRASH"].map(String::from);
        assert_eq!(
            label_list(&system, &["Label_1".into(), "Label_9".into()], &names),
            ["promotions", "inbox", "trash", "Receipts", "Label_9"]
        );
    }

    #[test]
    fn cut_counts_characters_not_bytes() {
        assert_eq!(cut("héllo".into(), 2), ("hé".into(), true));
        assert_eq!(cut("hi".into(), 2), ("hi".into(), false));
    }

    #[test]
    fn mailbox_names_map_to_labels() {
        assert_eq!(system_mailbox("inbox"), Some(("INBOX", None)));
        assert_eq!(
            system_mailbox("promotions"),
            Some(("INBOX", Some("CATEGORY_PROMOTIONS")))
        );
        assert_eq!(system_mailbox("all"), Some((ALL_MAIL, None)));
        assert_eq!(system_mailbox("Receipts"), None);
    }
}
