//! Gmail filters, all of them (sender rules in `sender_rules.rs` are the narrow
//! "sender → category" kind Settings › Inbox edits; they're listed here too). Straight to
//! Gmail's filters API like sender rules, not the outbox (a create replayed after an ambiguous
//! failure would make a duplicate), and not cached. Labels are named, so a reader (the AI
//! assistant) never sees a bare `Label_12`.
//!
//! The editor (Settings › Filters, Filter messages like these) works on a [`FilterSpec`]:
//! Gmail web's search-options form and its actions, one-to-one with the API. Gmail has no
//! update, so an edit creates the new filter and then deletes the old one. Tauri-free.

use crate::db::labels;
use crate::gmail::types::{Filter, FilterAction, FilterCriteria};
use crate::gmail::GmailError;
use crate::mail::{MailError, MailService, SearchChange, ThreadSummaryDto};
use crate::sender_rules::CATEGORIES;
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

/// A filter as a person would describe it (snake_case, like the rest of the local API's output).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FilterDto {
    pub id: String,
    /// Gmail's criteria fields as set (`from`, `to`, `subject`, `query`, `negatedQuery`,
    /// `hasAttachment`, `size`, `sizeComparison`, `excludeChats`).
    pub criteria: serde_json::Map<String, serde_json::Value>,
    /// What it does, one phrase each: "delete it", "skip the inbox", "apply label Receipts"...
    pub actions: Vec<String>,
    /// Sends matching mail to Trash.
    pub trashes: bool,
    /// Keeps matching mail out of the inbox.
    pub skips_inbox: bool,
    /// Marks matching mail read.
    pub marks_read: bool,
    /// Labels it adds, by name (system labels by their id).
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
    pub forward_to: Option<String>,
}

pub struct FilterService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
}

impl FilterService {
    pub fn new(db: SqlitePool, sync: Arc<SyncManager>) -> Self {
        Self { db, sync }
    }

    fn api(&self, account_id: &str) -> Arc<dyn MailApi> {
        self.sync.api(account_id)
    }

    /// Every filter on the account, in Gmail's order.
    pub async fn list(&self, account_id: &str) -> Result<Vec<FilterDto>, MailError> {
        let filters = self.api(account_id).list_filters().await?;
        let names = label_names(&self.db, account_id).await?;
        Ok(filters.iter().map(|f| describe(f, &names)).collect())
    }

    /// Label id → name for the account's cached labels, as filters are described.
    pub async fn label_names(
        &self,
        account_id: &str,
    ) -> Result<HashMap<String, String>, MailError> {
        label_names(&self.db, account_id).await
    }

    /// Create a filter in Gmail (not retried when the outcome is unknown, see
    /// [`crate::gmail::GmailClient::create_filter`]). It applies to mail that arrives from now on.
    pub async fn create(&self, account_id: &str, filter: &Filter) -> Result<FilterDto, MailError> {
        let created = self.api(account_id).create_filter(filter).await?;
        let names = label_names(&self.db, account_id).await?;
        Ok(describe(&created, &names))
    }

    /// Every filter on the account for Settings › Filters: what it matches and does in words,
    /// and the form to edit it with (`None` when the form can't show all it does).
    pub async fn entries(&self, account_id: &str) -> Result<Vec<FilterEntryDto>, MailError> {
        let filters = self.api(account_id).list_filters().await?;
        let names = label_names(&self.db, account_id).await?;
        Ok(filters.iter().map(|f| entry(f, &names)).collect())
    }

    /// Make the filter the form describes. Gmail applies it to mail that arrives from now on.
    pub async fn create_spec(
        &self,
        account_id: &str,
        spec: &FilterSpec,
    ) -> Result<FilterEntryDto, MailError> {
        let filter = spec.to_filter()?;
        // Read first: once Gmail has made the filter, nothing here may fail the save.
        let names = label_names(&self.db, account_id).await?;
        let created = self
            .api(account_id)
            .create_filter(&filter)
            .await
            .map_err(refusal)?;
        tracing::info!(account = account_id, filter = ?created.id, "filter created");
        Ok(entry(&created, &names))
    }

    /// Change filter `filter_id` to what the form describes. Gmail has no update: the new filter
    /// is created first, then the old one deleted, so a failure never leaves neither. If the
    /// delete fails, the new one is deleted again and the old one stays as it was.
    pub async fn replace(
        &self,
        account_id: &str,
        filter_id: &str,
        spec: &FilterSpec,
    ) -> Result<FilterEntryDto, MailError> {
        let filter = spec.to_filter()?;
        let api = self.api(account_id);
        let names = label_names(&self.db, account_id).await?;
        let filters = api.list_filters().await?;
        let Some(old) = filters.iter().find(|f| f.id.as_deref() == Some(filter_id)) else {
            return Err(MailError::Invalid(
                "That filter isn't in Gmail any more. Reopen Settings › Filters to see what's there."
                    .into(),
            ));
        };
        if old.criteria == filter.criteria && old.action == filter.action {
            return Ok(entry(old, &names));
        }
        let created = api.create_filter(&filter).await.map_err(refusal)?;
        let new_id = created.id.clone().unwrap_or_default();
        match api.delete_filter(filter_id).await {
            Ok(()) => {}
            Err(e) if e.is_not_found() => {}
            Err(e) => {
                tracing::warn!(account = account_id, old = filter_id, new = new_id, error = %e, "couldn't delete the old filter; taking the new one back");
                return Err(match api.delete_filter(&new_id).await {
                    Ok(()) => e.into(),
                    Err(e2) if e2.is_not_found() => e.into(),
                    Err(_) => MailError::Incomplete {
                        message: "Gmail made the changed filter but kept the old one too. Delete \
                                  the one you don't want in Settings › Filters."
                            .into(),
                        cause: e.into(),
                    },
                });
            }
        }
        tracing::info!(
            account = account_id,
            old = filter_id,
            new = new_id,
            "filter changed"
        );
        Ok(entry(&created, &names))
    }

    /// The addresses a filter can forward to: those Gmail has verified.
    pub async fn forwarding_addresses(&self, account_id: &str) -> Result<Vec<String>, MailError> {
        Ok(self
            .api(account_id)
            .list_forwarding_addresses()
            .await?
            .into_iter()
            .filter(|a| a.verification_status.as_deref() == Some("accepted"))
            .map(|a| a.forwarding_email)
            .collect())
    }

    /// Delete a filter; one that isn't there is an error, so a mistyped id isn't taken as done.
    pub async fn delete(&self, account_id: &str, filter_id: &str) -> Result<(), MailError> {
        let api = self.api(account_id);
        let filters = api.list_filters().await?;
        if !filters.iter().any(|f| f.id.as_deref() == Some(filter_id)) {
            return Err(MailError::Invalid(format!(
                "There's no filter {filter_id} on this account."
            )));
        }
        api.delete_filter(filter_id).await.map_err(MailError::from)
    }
}

/// "You already have this filter" instead of Gmail's bare `Filter already exists`.
fn refusal(e: GmailError) -> MailError {
    match &e {
        GmailError::Api {
            status: 400 | 409,
            message,
            ..
        } if message.to_ascii_lowercase().contains("already exists") => {
            MailError::Invalid("You already have a filter that does exactly this.".into())
        }
        _ => e.into(),
    }
}

/// A filter as Settings › Filters lists it (camelCase, for the window).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterEntryDto {
    pub id: String,
    /// What it matches, as the Gmail search it stands for (`from:(a@x.com) has:attachment`).
    pub matches: String,
    /// What it does, one phrase each ("skip the inbox (archive it)", "apply label Receipts").
    pub actions: Vec<String>,
    /// The form to edit it with; `None` when it does something the form can't show (two
    /// labels, say), so editing it here would lose that.
    pub spec: Option<FilterSpec>,
}

/// A saved filter, and why Also apply filter didn't reach the mail already there (the filter
/// itself is saved either way).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilterDto {
    pub filter: FilterEntryDto,
    pub apply_error: Option<String>,
}

fn entry(filter: &Filter, names: &HashMap<String, String>) -> FilterEntryDto {
    let described = describe(filter, names);
    FilterEntryDto {
        id: described.id,
        matches: criteria_query(&described.criteria).unwrap_or_default(),
        actions: described.actions,
        spec: FilterSpec::of(filter),
    }
}

/// Gmail web's filter form: its search options and the actions under "When a message is an
/// exact match for your search criteria". Empty text is unset.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterSpec {
    pub from: String,
    pub to: String,
    pub subject: String,
    /// Has the words.
    pub query: String,
    /// Doesn't have.
    pub negated_query: String,
    /// Bytes; with `size_comparison` `larger` or `smaller`.
    pub size: Option<i64>,
    pub size_comparison: Option<String>,
    pub has_attachment: bool,
    /// Don't include chats.
    pub exclude_chats: bool,
    /// Skip the Inbox (Archive it).
    pub skip_inbox: bool,
    pub mark_read: bool,
    pub star: bool,
    /// Apply the label: a user label's id.
    pub label: Option<String>,
    /// Forward it to: a verified forwarding address.
    pub forward: Option<String>,
    /// Delete it.
    pub trash: bool,
    pub never_spam: bool,
    /// `Some(true)` always mark it as important, `Some(false)` never.
    pub important: Option<bool>,
    /// Categorize as: a `CATEGORY_*` id.
    pub category: Option<String>,
}

fn text(v: &str) -> Option<String> {
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_owned())
}

impl FilterSpec {
    /// The search options as Gmail's criteria, or why they can't be.
    pub fn criteria(&self) -> Result<FilterCriteria, MailError> {
        let invalid = |m: &str| Err(MailError::Invalid(m.into()));
        let mut criteria = FilterCriteria {
            from: text(&self.from),
            ..Default::default()
        };
        for (key, value) in [
            ("to", &self.to),
            ("subject", &self.subject),
            ("query", &self.query),
            ("negatedQuery", &self.negated_query),
        ] {
            if let Some(v) = text(value) {
                criteria.other.insert(key.into(), v.into());
            }
        }
        if let Some(size) = self.size {
            let Some(cmp @ ("larger" | "smaller")) = self.size_comparison.as_deref() else {
                return invalid("Choose greater than or less than for the size.");
            };
            if size <= 0 {
                return invalid("The size has to be more than zero.");
            }
            criteria.other.insert("size".into(), size.into());
            criteria.other.insert("sizeComparison".into(), cmp.into());
        }
        if self.has_attachment {
            criteria.other.insert("hasAttachment".into(), true.into());
        }
        if criteria.from.is_none() && criteria.other.is_empty() {
            return invalid("Fill in at least one search option.");
        }
        if self.exclude_chats {
            criteria.other.insert("excludeChats".into(), true.into());
        }
        Ok(criteria)
    }

    /// The Gmail filter, or why it can't be one.
    pub fn to_filter(&self) -> Result<Filter, MailError> {
        let invalid = |m: &str| Err(MailError::Invalid(m.into()));
        let criteria = self.criteria()?;
        let mut action = FilterAction::default();
        if let Some(label) = self.label.as_deref().and_then(text) {
            if is_system(&label) {
                return invalid("Choose one of your own labels.");
            }
            action.add_label_ids.push(label);
        }
        if let Some(category) = self.category.as_deref().and_then(text) {
            if !CATEGORIES.contains(&category.as_str()) {
                return invalid("That isn't an inbox category.");
            }
            action.add_label_ids.push(category);
        }
        for (on, id) in [
            (self.star, "STARRED"),
            (self.trash, "TRASH"),
            (self.important == Some(true), "IMPORTANT"),
        ] {
            if on {
                action.add_label_ids.push(id.into());
            }
        }
        for (on, id) in [
            (self.skip_inbox, "INBOX"),
            (self.mark_read, "UNREAD"),
            (self.never_spam, "SPAM"),
            (self.important == Some(false), "IMPORTANT"),
        ] {
            if on {
                action.remove_label_ids.push(id.into());
            }
        }
        action.forward = self.forward.as_deref().and_then(text);
        if action.add_label_ids.is_empty()
            && action.remove_label_ids.is_empty()
            && action.forward.is_none()
        {
            return invalid("Choose at least one thing to do with matching mail.");
        }
        Ok(Filter {
            id: None,
            criteria,
            action,
        })
    }

    /// The form for `filter`; `None` when it has something the form can't show.
    pub fn of(filter: &Filter) -> Option<FilterSpec> {
        let mut spec = FilterSpec {
            from: filter.criteria.from.clone().unwrap_or_default(),
            ..Default::default()
        };
        for (key, value) in &filter.criteria.other {
            match (key.as_str(), value) {
                ("to", Value::String(v)) => spec.to = v.clone(),
                ("subject", Value::String(v)) => spec.subject = v.clone(),
                ("query", Value::String(v)) => spec.query = v.clone(),
                ("negatedQuery", Value::String(v)) => spec.negated_query = v.clone(),
                ("size", v) => spec.size = Some(v.as_i64()?),
                ("sizeComparison", Value::String(v)) if v == "larger" || v == "smaller" => {
                    spec.size_comparison = Some(v.clone());
                }
                ("sizeComparison", Value::String(v)) if v == "unspecified" => {}
                ("hasAttachment", Value::Bool(b)) => spec.has_attachment = *b,
                ("excludeChats", Value::Bool(b)) => spec.exclude_chats = *b,
                _ => return None,
            }
        }
        if spec.size.is_some() != spec.size_comparison.is_some() {
            return None;
        }
        let action = &filter.action;
        if !action.other.is_empty() {
            return None;
        }
        for id in &action.add_label_ids {
            let slot = match id.as_str() {
                "STARRED" => &mut spec.star,
                "TRASH" => &mut spec.trash,
                "IMPORTANT" if spec.important.is_none() => {
                    spec.important = Some(true);
                    continue;
                }
                c if CATEGORIES.contains(&c) && spec.category.is_none() => {
                    spec.category = Some(c.to_owned());
                    continue;
                }
                l if !is_system(l) && spec.label.is_none() => {
                    spec.label = Some(l.to_owned());
                    continue;
                }
                _ => return None,
            };
            *slot = true;
        }
        for id in &action.remove_label_ids {
            match id.as_str() {
                "INBOX" => spec.skip_inbox = true,
                "UNREAD" => spec.mark_read = true,
                "SPAM" => spec.never_spam = true,
                "IMPORTANT" if spec.important.is_none() => spec.important = Some(false),
                _ => return None,
            }
        }
        spec.forward = action.forward.clone();
        Some(spec)
    }
}

/// Gmail's own labels (and categories), which a filter's Apply the label can't choose.
fn is_system(id: &str) -> bool {
    id.chars().all(|c| c.is_ascii_uppercase() || c == '_')
}

/// What "Also apply filter to matching conversations" does to mail already there: Gmail web's
/// own rule, the filter's label changes on every match (forwarding and Never send it to Spam
/// only apply to new mail). A category takes the conversation out of the other tabs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExistingChange {
    pub add: Vec<String>,
    pub remove: Vec<String>,
    /// Delete it: the matches go to Trash.
    pub trash: bool,
}

impl ExistingChange {
    pub fn of(action: &FilterAction) -> Self {
        let mut add: Vec<String> = action
            .add_label_ids
            .iter()
            .filter(|l| *l != "TRASH" && *l != "SPAM")
            .cloned()
            .collect();
        let mut remove: Vec<String> = action
            .remove_label_ids
            .iter()
            .filter(|l| *l != "SPAM")
            .cloned()
            .collect();
        if let Some(category) = add.iter().find(|l| CATEGORIES.contains(&l.as_str())) {
            let others = CATEGORIES.iter().filter(|c| **c != category.as_str());
            remove.extend(others.map(|c| c.to_string()));
        }
        add.dedup();
        Self {
            add,
            remove,
            trash: action.add_label_ids.iter().any(|l| l == "TRASH"),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty() && !self.trash
    }
}

/// The search for what a filter's form matches (as Settings › Filters shows it).
pub fn spec_query(spec: &FilterSpec) -> Result<String, MailError> {
    let found = spec.criteria()?;
    let mut criteria = found.other;
    if let Some(from) = found.from {
        criteria.insert("from".into(), from.into());
    }
    criteria_query(&criteria)
        .ok_or_else(|| MailError::Invalid("Fill in at least one search option.".into()))
}

/// Gmail search pages [`FilterService::count_matches`] reads before giving up on a number.
const COUNT_PAGES: usize = 10;

impl FilterService {
    /// How many conversations in Gmail the form's search matches now (what Also apply filter
    /// changes), from Gmail's message ids alone; `None` past [`COUNT_PAGES`] pages of 500.
    pub async fn count_matches(
        &self,
        account_id: &str,
        spec: &FilterSpec,
    ) -> Result<Option<usize>, MailError> {
        let (query, spam_trash) = crate::search::gmail_query(&spec_query(spec)?);
        // As each change searches: the label sweep never reaches Spam and Trash, Delete it's
        // search does when the query asks (`in:anywhere`).
        let spam_trash = spam_trash && spec.trash;
        let api = self.api(account_id);
        let mut threads = HashSet::new();
        let mut token: Option<String> = None;
        for _ in 0..COUNT_PAGES {
            let page = api
                .search_messages(&query, spam_trash, token.as_deref(), 500)
                .await?;
            threads.extend(page.messages.into_iter().map(|m| m.thread_id));
            match page.next_page_token {
                Some(next) if !next.is_empty() => token = Some(next),
                _ => return Ok(Some(threads.len())),
            }
        }
        Ok(None)
    }
}

/// "Also apply filter to matching conversations": the filter's label changes for every match,
/// cached or not, through the change-every-match path (the outbox's sweep), and with Delete it,
/// every match Gmail's search finds to Trash.
pub async fn apply_to_existing(
    mail: &MailService,
    account_id: &str,
    spec: &FilterSpec,
) -> Result<(), MailError> {
    let filter = spec.to_filter()?;
    let change = ExistingChange::of(&filter.action);
    if change.is_empty() {
        return Ok(());
    }
    let query = spec_query(spec)?;
    // Found before anything changes: a label change queued below (Mark as read, say) can take a
    // conversation out of the search.
    let trash = if change.trash {
        mail.every_match(account_id, &query).await?
    } else {
        Vec::new()
    };
    if !change.add.is_empty() || !change.remove.is_empty() {
        let add: Vec<&str> = change.add.iter().map(String::as_str).collect();
        let remove: Vec<&str> = change.remove.iter().map(String::as_str).collect();
        mail.modify_search(
            account_id,
            &query,
            &SearchChange {
                add: &add,
                remove: &remove,
                ..Default::default()
            },
            false,
        )
        .await?;
    }
    if !trash.is_empty() {
        mail.trash_threads(account_id, &trash).await?;
    }
    Ok(())
}

/// Label id → name for the account's cached labels.
pub async fn label_names(
    db: &SqlitePool,
    account_id: &str,
) -> Result<HashMap<String, String>, MailError> {
    Ok(labels::get_labels(db, account_id)
        .await?
        .into_iter()
        .map(|l| (l.id, l.name))
        .collect())
}

pub fn describe(filter: &Filter, names: &HashMap<String, String>) -> FilterDto {
    let mut criteria = filter.criteria.other.clone();
    if let Some(from) = &filter.criteria.from {
        criteria.insert("from".into(), from.clone().into());
    }
    let action = &filter.action;
    let has = |list: &[String], id: &str| list.iter().any(|l| l == id);
    let name = |id: &String| names.get(id).cloned().unwrap_or_else(|| id.clone());
    let trashes = has(&action.add_label_ids, "TRASH");
    let skips_inbox = has(&action.remove_label_ids, "INBOX");
    let marks_read = has(&action.remove_label_ids, "UNREAD");

    let mut actions = Vec::new();
    for id in &action.add_label_ids {
        actions.push(match id.as_str() {
            "TRASH" => "delete it".to_owned(),
            "STARRED" => "star it".to_owned(),
            "IMPORTANT" => "mark it important".to_owned(),
            "SPAM" => "send it to spam".to_owned(),
            c if c.starts_with("CATEGORY_") => format!("file it under {}", category_name(c)),
            _ => format!("apply label {}", name(id)),
        });
    }
    for id in &action.remove_label_ids {
        actions.push(match id.as_str() {
            "INBOX" => "skip the inbox (archive it)".to_owned(),
            "UNREAD" => "mark it as read".to_owned(),
            "SPAM" => "never send it to spam".to_owned(),
            "IMPORTANT" => "never mark it important".to_owned(),
            _ => format!("remove label {}", name(id)),
        });
    }
    if let Some(to) = &action.forward {
        actions.push(format!("forward it to {to}"));
    }
    FilterDto {
        id: filter.id.clone().unwrap_or_default(),
        criteria,
        actions,
        trashes,
        skips_inbox,
        marks_read,
        add_labels: action.add_label_ids.iter().map(name).collect(),
        remove_labels: action.remove_label_ids.iter().map(name).collect(),
        forward_to: action.forward.clone(),
    }
}

fn category_name(id: &str) -> &str {
    match id {
        "CATEGORY_PERSONAL" => "Primary",
        "CATEGORY_SOCIAL" => "Social",
        "CATEGORY_PROMOTIONS" => "Promotions",
        "CATEGORY_UPDATES" => "Updates",
        "CATEGORY_FORUMS" => "Forums",
        other => other,
    }
}

/// Whether every `(` in `v` has its `)`, outside quoted phrases.
fn balanced(v: &str) -> bool {
    let (mut depth, mut quoted) = (0usize, false);
    for c in v.chars() {
        match c {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => match depth.checked_sub(1) {
                Some(d) => depth = d,
                None => return false,
            },
            _ => {}
        }
    }
    depth == 0 && !quoted
}

/// Gmail search for what a filter's criteria match (Gmail's own criteria field names).
pub fn criteria_query(criteria: &serde_json::Map<String, Value>) -> Option<String> {
    let text = |key: &str| {
        criteria
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    // A single plain word goes bare (`from:a@x.com`), so the local search can count it too;
    // anything else is grouped, as Gmail web writes it.
    let group = |v: &str| {
        let plain = !v.starts_with('-')
            && v.chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '@' | '.' | '_' | '+' | '-'))
            && !matches!(v, "OR" | "AND" | "AROUND");
        if plain {
            v.to_owned()
        } else if balanced(v) {
            format!("({v})")
        } else {
            // A stray `(` or `)` would close the group early and spill the rest into the search
            // around it: searched as a phrase instead.
            format!("\"{}\"", v.replace('"', ""))
        }
    };
    let mut parts = Vec::new();
    for (key, op) in [
        ("from", "from:"),
        ("to", "to:"),
        ("subject", "subject:"),
        ("query", ""),
    ] {
        if let Some(v) = text(key) {
            parts.push(format!("{op}{}", group(v)));
        }
    }
    if let Some(v) = text("negatedQuery") {
        parts.push(format!("-{}", group(v)));
    }
    if criteria.get("hasAttachment") == Some(&Value::Bool(true)) {
        parts.push("has:attachment".into());
    }
    if criteria.get("excludeChats") == Some(&Value::Bool(true)) {
        parts.push("-in:chats".into());
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
pub fn wanted_query(criteria: &str, days: i64) -> String {
    format!(
        "{criteria} {WANTED_HINTS} in:anywhere newer_than:{}d",
        days.max(WANTED_DAYS)
    )
}

/// Where each conversation sits now, counted: trash, spam, inbox or archived.
pub fn now_in(threads: &[ThreadSummaryDto]) -> BTreeMap<&'static str, usize> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::types::{FilterAction, FilterCriteria};
    use serde_json::json;

    #[test]
    fn describes_actions_in_words_with_label_names() {
        let mut criteria = FilterCriteria {
            from: Some("news@x.com".into()),
            ..Default::default()
        };
        criteria.other.insert("subject".into(), "Sale".into());
        let filter = Filter {
            id: Some("f1".into()),
            criteria,
            action: FilterAction {
                add_label_ids: vec!["TRASH".into(), "Label_7".into(), "CATEGORY_UPDATES".into()],
                remove_label_ids: vec!["INBOX".into(), "UNREAD".into()],
                forward: Some("me@else.com".into()),
                ..Default::default()
            },
        };
        let names = HashMap::from([("Label_7".to_owned(), "Receipts".to_owned())]);
        let d = describe(&filter, &names);
        assert_eq!(d.id, "f1");
        assert_eq!(d.criteria["from"], "news@x.com");
        assert_eq!(d.criteria["subject"], "Sale");
        assert!(d.trashes && d.skips_inbox && d.marks_read);
        assert_eq!(d.add_labels, ["TRASH", "Receipts", "CATEGORY_UPDATES"]);
        assert_eq!(
            d.actions,
            [
                "delete it",
                "apply label Receipts",
                "file it under Updates",
                "skip the inbox (archive it)",
                "mark it as read",
                "forward it to me@else.com",
            ]
        );
    }

    #[test]
    fn filter_criteria_become_gmail_queries() {
        let criteria = json!({
            "from": "a@x.com OR b@y.com", "subject": "Sale", "query": "deal",
            "negatedQuery": "invoice", "hasAttachment": true, "size": 1000, "sizeComparison": "larger"
        });
        assert_eq!(
            criteria_query(criteria.as_object().unwrap()).as_deref(),
            Some("from:(a@x.com OR b@y.com) subject:Sale deal -invoice has:attachment larger:1000")
        );
        let grouped = json!({ "subject": "Big sale", "query": "-x", "negatedQuery": "OR", "excludeChats": true });
        assert_eq!(
            criteria_query(grouped.as_object().unwrap()).as_deref(),
            Some("subject:(Big sale) (-x) -(OR) -in:chats")
        );
        assert_eq!(
            criteria_query(json!({ "from": " " }).as_object().unwrap()),
            None
        );
        // A stray parenthesis can't close the group and leak the rest into the search.
        let stray = json!({ "subject": "a) OR in:trash (b", "query": "x\") y" });
        assert_eq!(
            criteria_query(stray.as_object().unwrap()).as_deref(),
            Some("subject:\"a) OR in:trash (b\" \"x) y\"")
        );
        let nested = json!({ "query": "(a OR b) \"c)\"" });
        assert_eq!(
            criteria_query(nested.as_object().unwrap()).as_deref(),
            Some("((a OR b) \"c)\")")
        );
    }

    fn spec() -> FilterSpec {
        FilterSpec {
            from: "news@x.com".into(),
            skip_inbox: true,
            star: true,
            ..Default::default()
        }
    }

    #[test]
    fn the_form_round_trips_through_a_gmail_filter() {
        let full = FilterSpec {
            from: "news@x.com".into(),
            to: "me@y.com".into(),
            subject: "Sale".into(),
            query: "deal".into(),
            negated_query: "invoice".into(),
            size: Some(2 * 1024 * 1024),
            size_comparison: Some("larger".into()),
            has_attachment: true,
            exclude_chats: true,
            skip_inbox: true,
            mark_read: true,
            star: true,
            label: Some("Label_7".into()),
            forward: Some("me@else.com".into()),
            trash: true,
            never_spam: true,
            important: Some(false),
            category: Some("CATEGORY_UPDATES".into()),
        };
        let filter = full.to_filter().unwrap();
        assert_eq!(filter.criteria.from.as_deref(), Some("news@x.com"));
        assert_eq!(filter.criteria.other["size"], 2 * 1024 * 1024);
        assert_eq!(
            filter.action.add_label_ids,
            ["Label_7", "CATEGORY_UPDATES", "STARRED", "TRASH"]
        );
        assert_eq!(
            filter.action.remove_label_ids,
            ["INBOX", "UNREAD", "SPAM", "IMPORTANT"]
        );
        assert_eq!(FilterSpec::of(&filter), Some(full));

        let always = FilterSpec {
            important: Some(true),
            ..spec()
        };
        assert_eq!(FilterSpec::of(&always.to_filter().unwrap()), Some(always));
    }

    #[test]
    fn the_form_refuses_what_gmail_would() {
        let refused = |spec: FilterSpec| match spec.to_filter() {
            Err(MailError::Invalid(m)) => m,
            other => panic!("{other:?}"),
        };
        assert!(refused(FilterSpec {
            from: " ".into(),
            ..spec()
        })
        .contains("search option"));
        assert!(refused(FilterSpec {
            exclude_chats: true,
            skip_inbox: true,
            ..Default::default()
        })
        .contains("search option"));
        assert!(refused(FilterSpec {
            from: "a@x.com".into(),
            ..Default::default()
        })
        .contains("at least one thing"));
        assert!(refused(FilterSpec {
            size: Some(10),
            ..spec()
        })
        .contains("greater than"));
        assert!(refused(FilterSpec {
            size: Some(0),
            size_comparison: Some("smaller".into()),
            ..spec()
        })
        .contains("more than zero"));
        assert!(refused(FilterSpec {
            label: Some("INBOX".into()),
            ..spec()
        })
        .contains("your own labels"));
        assert!(refused(FilterSpec {
            category: Some("Label_1".into()),
            ..spec()
        })
        .contains("category"));
    }

    #[test]
    fn filters_the_form_cant_show_have_no_form() {
        let with = |f: fn(&mut Filter)| {
            let mut filter = spec().to_filter().unwrap();
            f(&mut filter);
            FilterSpec::of(&filter)
        };
        assert!(with(|_| {}).is_some());
        assert!(with(|f| f
            .action
            .add_label_ids
            .extend(["Label_1".into(), "Label_2".into()]))
        .is_none());
        assert!(with(|f| f.action.remove_label_ids.push("Label_1".into())).is_none());
        assert!(with(|f| f.action.add_label_ids.push("SPAM".into())).is_none());
        assert!(with(|f| {
            f.criteria.other.insert("size".into(), 5.into());
        })
        .is_none());
        assert!(with(|f| {
            f.criteria.other.insert("somethingNew".into(), true.into());
        })
        .is_none());
        assert!(with(|f| {
            f.action.other.insert("somethingNew".into(), true.into());
        })
        .is_none());
    }

    #[test]
    fn existing_mail_gets_the_label_changes_gmail_web_applies() {
        let filter = FilterSpec {
            from: "a@x.com".into(),
            mark_read: true,
            never_spam: true,
            forward: Some("me@else.com".into()),
            category: Some("CATEGORY_UPDATES".into()),
            trash: true,
            ..Default::default()
        }
        .to_filter()
        .unwrap();
        let change = ExistingChange::of(&filter.action);
        assert_eq!(change.add, ["CATEGORY_UPDATES"]);
        assert_eq!(
            change.remove,
            [
                "UNREAD",
                "CATEGORY_PERSONAL",
                "CATEGORY_SOCIAL",
                "CATEGORY_PROMOTIONS",
                "CATEGORY_FORUMS"
            ]
        );
        assert!(change.trash);
        let forward_only = FilterSpec {
            from: "a@x.com".into(),
            forward: Some("me@else.com".into()),
            never_spam: true,
            ..Default::default()
        };
        assert!(ExistingChange::of(&forward_only.to_filter().unwrap().action).is_empty());
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

    mod service {
        use super::*;
        use crate::db::test_support::TestDb;
        use crate::gmail::types::ForwardingAddress;
        use crate::sync::fake::{synced, FakeGmail, FakeMsg};

        struct Harness {
            _db: TestDb,
            fake: Arc<FakeGmail>,
            filters: FilterService,
            mail: MailService,
        }

        async fn setup(fake: FakeGmail) -> Harness {
            let db = TestDb::with_account("a1").await;
            let pool = db.pool.clone();
            let fake = Arc::new(fake);
            let sync = synced(&pool, fake.clone(), "a1").await;
            let mail = MailService::new(
                pool.clone(),
                sync.clone(),
                db.dir().join("cache"),
                crate::storage::test_key(),
            );
            Harness {
                filters: FilterService::new(pool, sync),
                mail,
                fake,
                _db: db,
            }
        }

        fn server_error() -> GmailError {
            GmailError::Api {
                status: 500,
                reason: None,
                message: "backend".into(),
            }
        }

        fn msg(id: &str, thread: &str, labels: &[&str], from: &str) -> FakeMsg {
            FakeMsg {
                from: from.into(),
                ..FakeMsg::new(id, thread, labels)
            }
        }

        #[tokio::test]
        async fn lists_every_filter_in_words_with_its_form() {
            let fake = FakeGmail::new();
            fake.seed_filter(spec().to_filter().unwrap());
            let mut two_labels = spec().to_filter().unwrap();
            two_labels.action.add_label_ids = vec!["Label_1".into(), "Label_2".into()];
            fake.seed_filter(two_labels);
            let h = setup(fake).await;

            let list = h.filters.entries("a1").await.unwrap();
            assert_eq!(list.len(), 2);
            assert_eq!(list[0].matches, "from:news@x.com");
            assert_eq!(list[0].actions, ["star it", "skip the inbox (archive it)"]);
            assert_eq!(list[0].spec, Some(spec()));
            assert_eq!(list[1].spec, None, "two labels don't fit the form");
        }

        #[tokio::test]
        async fn a_duplicate_is_refused_in_words() {
            let h = setup(FakeGmail::new()).await;
            h.filters.create_spec("a1", &spec()).await.unwrap();
            match h.filters.create_spec("a1", &spec()).await {
                Err(MailError::Invalid(m)) => assert!(m.contains("already have"), "{m}"),
                other => panic!("{other:?}"),
            }
            assert_eq!(h.fake.filters().len(), 1);
        }

        #[tokio::test]
        async fn an_edit_makes_the_new_filter_then_deletes_the_old() {
            let fake = FakeGmail::new();
            let old = fake.seed_filter(spec().to_filter().unwrap());
            let h = setup(fake).await;
            let changed = FilterSpec {
                mark_read: true,
                ..spec()
            };

            let entry = h.filters.replace("a1", &old, &changed).await.unwrap();
            assert_ne!(entry.id, old);
            assert_eq!(entry.spec, Some(changed.clone()));
            let held = h.fake.filters();
            assert_eq!(held.len(), 1);
            assert_eq!(held[0].id.as_deref(), Some(entry.id.as_str()));

            // Saved without a change: nothing is made or deleted.
            let creates = h.fake.calls("create_filter");
            let same = h.filters.replace("a1", &entry.id, &changed).await.unwrap();
            assert_eq!(same.id, entry.id);
            assert_eq!(h.fake.calls("create_filter"), creates);
            assert_eq!(h.fake.calls("delete_filter"), 1);
        }

        #[tokio::test]
        async fn an_edit_that_cant_delete_the_old_filter_takes_the_new_one_back() {
            let fake = FakeGmail::new();
            let old = fake.seed_filter(spec().to_filter().unwrap());
            fake.fail_next("delete_filter", server_error());
            let h = setup(fake).await;
            let changed = FilterSpec {
                mark_read: true,
                ..spec()
            };

            let err = h.filters.replace("a1", &old, &changed).await.unwrap_err();
            assert_eq!(err.code(), "api");
            let held = h.fake.filters();
            assert_eq!(held.len(), 1, "only the old filter is left");
            assert_eq!(held[0].id.as_deref(), Some(old.as_str()));
        }

        #[tokio::test]
        async fn an_edit_that_cant_clean_up_says_both_are_there() {
            let fake = FakeGmail::new();
            let old = fake.seed_filter(spec().to_filter().unwrap());
            fake.fail_next("delete_filter", server_error());
            fake.fail_next("delete_filter", server_error());
            let h = setup(fake).await;
            let changed = FilterSpec {
                mark_read: true,
                ..spec()
            };

            let err = h.filters.replace("a1", &old, &changed).await.unwrap_err();
            assert!(matches!(err, MailError::Incomplete { .. }), "{err:?}");
            assert!(err.to_string().contains("kept the old one too"));
            assert_eq!(h.fake.filters().len(), 2);
        }

        #[tokio::test]
        async fn editing_a_filter_thats_gone_changes_nothing() {
            let h = setup(FakeGmail::new()).await;
            assert!(matches!(
                h.filters.replace("a1", "filter_9", &spec()).await,
                Err(MailError::Invalid(_))
            ));
            assert_eq!(h.fake.calls("create_filter"), 0);
        }

        #[tokio::test]
        async fn only_verified_forwarding_addresses_are_offered() {
            let fake = FakeGmail::new();
            fake.set_forwarding(vec![
                ForwardingAddress {
                    forwarding_email: "me@else.com".into(),
                    verification_status: Some("accepted".into()),
                },
                ForwardingAddress {
                    forwarding_email: "new@else.com".into(),
                    verification_status: Some("pending".into()),
                },
            ]);
            let h = setup(fake).await;
            assert_eq!(
                h.filters.forwarding_addresses("a1").await.unwrap(),
                ["me@else.com"]
            );
        }

        #[tokio::test]
        async fn existing_mail_is_counted_and_changed_through_the_outbox() {
            let fake = FakeGmail::new();
            fake.seed(msg("m1", "t1", &["INBOX", "UNREAD"], "News <news@x.com>"));
            fake.seed(msg("m2", "t2", &["INBOX"], "News <news@x.com>"));
            fake.seed(msg("m3", "t3", &["INBOX"], "Friend <friend@y.com>"));
            let h = setup(fake).await;

            assert_eq!(
                h.filters.count_matches("a1", &spec()).await.unwrap(),
                Some(2)
            );
            let criteria_only = FilterSpec {
                from: "news@x.com".into(),
                ..Default::default()
            };
            assert_eq!(
                h.filters.count_matches("a1", &criteria_only).await.unwrap(),
                Some(2),
                "counted before any action is chosen"
            );
            let searches = h.fake.calls("search_messages");
            assert!(searches >= 2, "counted by Gmail, not the cache");

            apply_to_existing(&h.mail, "a1", &spec()).await.unwrap();
            let inbox = h
                .mail
                .list_threads(&["a1".into()], "INBOX", None, None, None, None)
                .await
                .unwrap();
            let ids: Vec<&str> = inbox.threads.iter().map(|t| t.id.as_str()).collect();
            assert_eq!(ids, ["t3"], "archived in the cache at once");
            for _ in 0..100 {
                if h.fake.message("m1").unwrap().labels == ["UNREAD", "STARRED"] {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert_eq!(h.fake.message("m1").unwrap().labels, ["UNREAD", "STARRED"]);
            assert_eq!(h.fake.message("m3").unwrap().labels, ["INBOX"]);
        }

        #[tokio::test]
        async fn delete_it_sends_existing_matches_to_trash() {
            let fake = FakeGmail::new();
            fake.seed(msg("m1", "t1", &["INBOX"], "News <news@x.com>"));
            fake.seed(msg("m2", "t2", &["INBOX"], "Friend <friend@y.com>"));
            let h = setup(fake).await;
            let trash = FilterSpec {
                from: "news@x.com".into(),
                trash: true,
                ..Default::default()
            };

            apply_to_existing(&h.mail, "a1", &trash).await.unwrap();
            for _ in 0..100 {
                if h.fake
                    .message("m1")
                    .unwrap()
                    .labels
                    .contains(&"TRASH".into())
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(h
                .fake
                .message("m1")
                .unwrap()
                .labels
                .contains(&"TRASH".into()));
            assert_eq!(h.fake.message("m2").unwrap().labels, ["INBOX"]);
        }
    }
}
