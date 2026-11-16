//! Gmail filters, all of them (sender rules in `sender_rules.rs` are the narrow
//! "sender → category" kind the Settings page edits). Straight to Gmail's filters API like
//! sender rules, not cached. Labels are named, so a reader (the AI assistant) never sees a
//! bare `Label_12`. Tauri-free.

use crate::db::labels;
use crate::gmail::types::Filter;
use crate::mail::{MailError, ThreadSummaryDto};
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};
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

/// Gmail search for what a filter's criteria match (Gmail's own criteria field names).
pub fn criteria_query(criteria: &serde_json::Map<String, Value>) -> Option<String> {
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
            Some("from:(a@x.com OR b@y.com) subject:(Sale) (deal) -(invoice) has:attachment larger:1000")
        );
        assert_eq!(
            criteria_query(json!({ "from": " " }).as_object().unwrap()),
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
}
