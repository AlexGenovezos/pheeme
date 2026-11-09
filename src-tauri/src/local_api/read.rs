//! The read tools, each a call into the services the UI uses. Output is shaped for a reader
//! that isn't Pheeme's UI: label names instead of ids, ISO dates, plain-text bodies.

use super::requests::{AccountArg, GetThread, ListMailbox, SearchMail, DEFAULT_LIMIT, MAX_LIMIT};
use super::{ApiError, LocalApi, Request};
use crate::accounts::AccountInfo;
use crate::compose::build::html_to_text;
use crate::filters::label_names;
use crate::mail::{MailError, MessageDetailDto, ThreadCursorDto, ThreadSummaryDto, ALL_MAIL};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Local, SecondsFormat, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

const DEFAULT_BODY_CHARS: usize = 8000;

pub(super) async fn run(api: &LocalApi, request: Request) -> Result<Value, ApiError> {
    match request {
        Request::ListAccounts(_) => list_accounts(api).await,
        Request::ListLabels(a) => list_labels(api, a).await,
        Request::ListMailbox(m) => list_mailbox(api, m).await,
        Request::SearchMail(s) => search_mail(api, s).await,
        Request::GetThread(t) => get_thread(api, t).await,
        Request::ListFilters(a) => list_filters(api, a).await,
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

/// A conversation in a list.
#[derive(Debug, Serialize)]
pub(super) struct ThreadRow {
    pub thread_id: String,
    pub account: String,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub snippet: Option<String>,
    pub unread: bool,
    pub starred: bool,
    pub has_attachment: bool,
    pub messages: i64,
    /// System labels (INBOX, CATEGORY_PROMOTIONS, TRASH...) then user label names.
    pub labels: Vec<String>,
}

/// Turns summaries into rows, naming each account's labels once.
pub(super) struct Rows<'a> {
    api: &'a LocalApi,
    emails: HashMap<String, String>,
    names: HashMap<String, HashMap<String, String>>,
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
        })
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
            let names = self.label_names(&t.account_id).await?;
            let mut labels = t.system_label_ids.clone();
            labels.extend(
                t.label_ids
                    .iter()
                    .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone())),
            );
            out.push(ThreadRow {
                account: self.email(&t.account_id),
                thread_id: t.id,
                from: sender(t.from_name.as_deref(), t.from_address.as_deref()),
                date: iso(t.date),
                subject: t.subject,
                snippet: t.snippet,
                unread: t.unread,
                starred: t.starred,
                has_attachment: t.has_attachment,
                messages: t.message_count,
                labels,
            });
        }
        Ok(out)
    }
}

/// Where the next page starts, handed to the client as an opaque string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Cursor {
    Local(ThreadCursorDto),
    Gmail(HashMap<String, String>),
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

async fn list_mailbox(api: &LocalApi, args: ListMailbox) -> Result<Value, ApiError> {
    let mailbox = args
        .mailbox
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("inbox");
    let before = match decode_cursor(args.cursor.as_deref())? {
        None => None,
        Some(Cursor::Local(c)) => Some(c),
        Some(Cursor::Gmail(_)) => {
            return Err(ApiError::Invalid("That cursor is from a search.".into()))
        }
    };
    let accounts = resolve_accounts(api, args.account.as_deref()).await?;
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
    let read_filter: Option<&[(String, String)]> = args.unread_only.then_some(&[]);
    let page = api
        .mail
        .list_threads(
            &account_ids,
            &label_id,
            also,
            before,
            Some(limit(args.limit)),
            read_filter,
        )
        .await?;
    let threads = Rows::new(api).await?.rows(page.threads).await?;
    Ok(json!({
        "mailbox": mailbox,
        "threads": threads,
        "next_cursor": page.next.map(|c| encode_cursor(&Cursor::Local(c))),
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
    let mut rows = Rows::new(api).await?;

    let local_cursor = match cursor {
        Some(Cursor::Gmail(tokens)) => {
            return gmail_search(api, &mut rows, &account_ids, query, Some(tokens)).await
        }
        Some(Cursor::Local(c)) => Some(c),
        None => None,
    };
    if args.gmail {
        return gmail_search(api, &mut rows, &account_ids, query, None).await;
    }
    let page = api
        .mail
        .search_messages(&account_ids, query, local_cursor, Some(limit(args.limit)))
        .await?;
    if !page.local {
        return gmail_search(api, &mut rows, &account_ids, query, None).await;
    }
    Ok(json!({
        "searched": "the mail cached on this computer",
        "note": "Old mail may not be cached. Search again with gmail: true to search the whole mailbox.",
        "threads": rows.rows(page.threads).await?,
        "next_cursor": page.next.map(|c| encode_cursor(&Cursor::Local(c))),
    }))
}

async fn gmail_search(
    api: &LocalApi,
    rows: &mut Rows<'_>,
    account_ids: &[String],
    query: &str,
    tokens: Option<HashMap<String, String>>,
) -> Result<Value, ApiError> {
    let page = api.mail.search_gmail(account_ids, query, tokens).await?;
    let failed: Vec<String> = page.failed.iter().map(|a| rows.email(a)).collect();
    Ok(json!({
        "searched": "Gmail",
        "threads": rows.rows(page.threads).await?,
        "failed_accounts": failed,
        "next_cursor": (!page.next.is_empty()).then(|| encode_cursor(&Cursor::Gmail(page.next))),
    }))
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
    let max = args
        .max_chars_per_message
        .unwrap_or(DEFAULT_BODY_CHARS)
        .max(200);
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
                    .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_reject_junk() {
        let local = Cursor::Local(ThreadCursorDto {
            last_message_date: 5,
            account_id: "a".into(),
            thread_id: "t".into(),
        });
        let raw = encode_cursor(&local);
        assert_eq!(decode_cursor(Some(&raw)).unwrap(), Some(local));
        let gmail = Cursor::Gmail(HashMap::from([("a".into(), "tok".into())]));
        assert_eq!(
            decode_cursor(Some(&encode_cursor(&gmail))).unwrap(),
            Some(gmail)
        );
        assert_eq!(decode_cursor(None).unwrap(), None);
        assert_eq!(decode_cursor(Some("  ")).unwrap(), None);
        assert!(decode_cursor(Some("not a cursor")).is_err());
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
