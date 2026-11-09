//! Gmail filters, all of them (sender rules in `sender_rules.rs` are the narrow
//! "sender → category" kind the Settings page edits). Straight to Gmail's filters API like
//! sender rules, not cached. Labels are named, so a reader (the AI assistant) never sees a
//! bare `Label_12`. Tauri-free.

use crate::db::labels;
use crate::gmail::types::Filter;
use crate::gmail::GmailError;
use crate::mail::MailError;
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
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
        self.sync.engine(account_id).api.clone()
    }

    /// Every filter on the account, in Gmail's order.
    pub async fn list(&self, account_id: &str) -> Result<Vec<FilterDto>, MailError> {
        let filters = self.api(account_id).list_filters().await.map_err(gmail)?;
        let names = label_names(&self.db, account_id).await?;
        Ok(filters.iter().map(|f| describe(f, &names)).collect())
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

fn gmail(e: GmailError) -> MailError {
    MailError::Sync(e.into())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::types::{FilterAction, FilterCriteria};

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
}
