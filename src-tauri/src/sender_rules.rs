//! Sender rules: Gmail filters that file a sender's future mail in an inbox category
//! ("from a@x.com → Updates"). They go straight to Gmail's filters API (not the outbox: a
//! create replayed after an ambiguous failure would make a duplicate) and aren't cached.
//! Only filters of exactly that shape are listed or changed; anything else the user made in
//! Gmail is left alone. Tauri-free; commands are thin adapters over [`SenderRuleService`].

use crate::db::{accounts, messages, threads};
use crate::gmail::types::{Filter, FilterAction, FilterCriteria};
use crate::gmail::GmailError;
use crate::mail::MailError;
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::Arc;

/// Gmail's inbox categories; Primary is `CATEGORY_PERSONAL`.
pub const CATEGORIES: [&str; 5] = [
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderRuleDto {
    /// Gmail's filter id.
    pub id: String,
    pub sender: String,
    pub category: String,
}

/// What [`SenderRuleService::save_rules`] changed, so Undo can put it back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRulesDto {
    /// Filters it created.
    pub created: Vec<String>,
    /// Rules for the same senders with another category, which it deleted.
    pub replaced: Vec<SenderRuleDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxThreadDto {
    pub thread_id: String,
    /// The thread's `CATEGORY_*` labels before the move, sorted.
    pub categories: Vec<String>,
}

pub struct SenderRuleService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
}

impl SenderRuleService {
    pub fn new(db: SqlitePool, sync: Arc<SyncManager>) -> Self {
        Self { db, sync }
    }

    fn api(&self, account_id: &str) -> Arc<dyn MailApi> {
        self.sync.engine(account_id).api.clone()
    }

    /// The account's sender rules, in Gmail's order.
    pub async fn list_rules(&self, account_id: &str) -> Result<Vec<SenderRuleDto>, MailError> {
        let filters = self.api(account_id).list_filters().await.map_err(gmail)?;
        Ok(filters.iter().filter_map(rule_of).collect())
    }

    /// The sender each thread would make a rule for: the From of its latest message not sent by
    /// the account itself. Lowercased, once each, in thread order; threads of only the account's
    /// own mail add none.
    pub async fn rule_senders(
        &self,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<Vec<String>, MailError> {
        let own = own_address(&self.db, account_id).await?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for thread_id in thread_ids {
            let sender =
                messages::latest_sender_other_than(&self.db, account_id, thread_id, &own).await?;
            if let Some(sender) = sender.map(|s| s.trim().to_lowercase()) {
                if !sender.is_empty() && seen.insert(sender.clone()) {
                    out.push(sender);
                }
            }
        }
        Ok(out)
    }

    /// Make each sender's future mail land in `category`. A sender that already has that rule
    /// keeps it; a rule of theirs for another category is replaced (the new one is created
    /// first, so a failure never leaves them with none). If anything fails, what this call
    /// already changed is put back before the error is returned.
    pub async fn save_rules(
        &self,
        account_id: &str,
        senders: &[String],
        category: &str,
    ) -> Result<SavedRulesDto, MailError> {
        check_category(category)?;
        let senders = clean_senders(senders);
        let mut saved = SavedRulesDto::default();
        if senders.is_empty() {
            return Ok(saved);
        }
        let api = self.api(account_id);
        let rules: Vec<SenderRuleDto> = api
            .list_filters()
            .await
            .map_err(gmail)?
            .iter()
            .filter_map(rule_of)
            .collect();
        for sender in &senders {
            if let Err(e) = save_one(api.as_ref(), &rules, sender, category, &mut saved).await {
                undo(api.as_ref(), &saved).await;
                return Err(gmail(e));
            }
        }
        Ok(saved)
    }

    /// Put back what [`Self::save_rules`] changed: delete what it created, recreate what it
    /// replaced.
    pub async fn undo_rules(
        &self,
        account_id: &str,
        saved: &SavedRulesDto,
    ) -> Result<(), MailError> {
        let api = self.api(account_id);
        for id in &saved.created {
            delete(api.as_ref(), id).await.map_err(gmail)?;
        }
        for rule in &saved.replaced {
            create(api.as_ref(), &rule.sender, &rule.category)
                .await
                .map_err(gmail)?;
        }
        Ok(())
    }

    /// Delete a sender rule; one that's already gone is fine.
    pub async fn delete_rule(&self, account_id: &str, rule_id: &str) -> Result<(), MailError> {
        let api = self.api(account_id);
        let filters = api.list_filters().await.map_err(gmail)?;
        match filters.iter().find(|f| f.id.as_deref() == Some(rule_id)) {
            None => Ok(()),
            Some(f) if rule_of(f).is_none() => Err(MailError::Invalid(
                "That filter isn't a sender rule, so Pheeme leaves it alone.".into(),
            )),
            Some(_) => delete(api.as_ref(), rule_id).await.map_err(gmail),
        }
    }

    /// Cached inbox threads with mail from any of `senders`, with their categories, leaving
    /// out those already in `category` (for Primary: in none of the other four).
    pub async fn inbox_threads_from(
        &self,
        account_id: &str,
        senders: &[String],
        category: &str,
    ) -> Result<Vec<InboxThreadDto>, MailError> {
        check_category(category)?;
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for sender in clean_senders(senders) {
            for id in threads::inbox_threads_from(&self.db, account_id, &sender).await? {
                if seen.insert(id.clone()) {
                    ids.push(id);
                }
            }
        }
        let keys: Vec<(String, String)> = ids
            .iter()
            .map(|id| (account_id.to_owned(), id.clone()))
            .collect();
        let labels = threads::system_label_ids_for(&self.db, &keys).await?;
        Ok(ids
            .into_iter()
            .filter_map(|thread_id| {
                let categories: Vec<String> = labels
                    .get(&(account_id.to_owned(), thread_id.clone()))
                    .into_iter()
                    .flatten()
                    .filter(|l| CATEGORIES.contains(&l.as_str()))
                    .cloned()
                    .collect();
                let there = if category == CATEGORIES[0] {
                    categories.iter().all(|c| c == CATEGORIES[0])
                } else {
                    categories.iter().any(|c| c == category)
                };
                (!there).then_some(InboxThreadDto {
                    thread_id,
                    categories,
                })
            })
            .collect())
    }
}

async fn save_one(
    api: &dyn MailApi,
    rules: &[SenderRuleDto],
    sender: &str,
    category: &str,
    saved: &mut SavedRulesDto,
) -> Result<(), GmailError> {
    let theirs = || {
        rules
            .iter()
            .filter(|r| r.sender.eq_ignore_ascii_case(sender))
    };
    if !theirs().any(|r| r.category == category) {
        if let Some(id) = create(api, sender, category).await? {
            saved.created.push(id);
        }
    }
    for old in theirs().filter(|r| r.category != category) {
        delete(api, &old.id).await?;
        saved.replaced.push(old.clone());
    }
    Ok(())
}

/// Best effort: a failed save puts back what it did before it failed.
async fn undo(api: &dyn MailApi, saved: &SavedRulesDto) {
    for id in &saved.created {
        if let Err(e) = delete(api, id).await {
            tracing::warn!(error = %e, "couldn't remove a sender rule after a failed save");
        }
    }
    for rule in &saved.replaced {
        if let Err(e) = create(api, &rule.sender, &rule.category).await {
            tracing::warn!(error = %e, "couldn't restore a sender rule after a failed save");
        }
    }
}

/// Create the rule; `None` when Gmail says it already exists (nothing new to undo).
async fn create(
    api: &dyn MailApi,
    sender: &str,
    category: &str,
) -> Result<Option<String>, GmailError> {
    let filter = Filter {
        id: None,
        criteria: FilterCriteria {
            from: Some(sender.to_owned()),
            ..Default::default()
        },
        action: FilterAction {
            add_label_ids: vec![category.to_owned()],
            ..Default::default()
        },
    };
    match api.create_filter(&filter).await {
        Ok(created) => Ok(created.id),
        Err(e) if already_exists(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

async fn delete(api: &dyn MailApi, id: &str) -> Result<(), GmailError> {
    match api.delete_filter(id).await {
        Err(e) if e.is_not_found() => Ok(()),
        other => other,
    }
}

fn already_exists(e: &GmailError) -> bool {
    matches!(e, GmailError::Api { status: 400 | 409, message, .. }
        if message.to_ascii_lowercase().contains("already exists"))
}

/// The filter as a sender rule, when that's all it is: from one sender, add one category.
fn rule_of(filter: &Filter) -> Option<SenderRuleDto> {
    let FilterCriteria { from, other } = &filter.criteria;
    let action = &filter.action;
    let sender = from.as_deref()?.trim();
    let simple = other.is_empty()
        && action.other.is_empty()
        && action.remove_label_ids.is_empty()
        && action.forward.is_none()
        && action.add_label_ids.len() == 1
        && CATEGORIES.contains(&action.add_label_ids[0].as_str())
        && is_address(sender);
    if !simple {
        return None;
    }
    Some(SenderRuleDto {
        id: filter.id.clone()?,
        sender: sender.to_owned(),
        category: action.add_label_ids[0].clone(),
    })
}

/// A single plain address (`name@example.com`), not a query or a list (`a OR b`, `a@x.com,b@y.com`,
/// `{…}`, `@x.com`).
fn is_address(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    let plain = |part: &str, extra: &[char]| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c) || extra.contains(&c))
    };
    plain(local, &['+', '%']) && plain(domain, &[]) && domain.contains('.')
}

fn clean_senders(senders: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    senders
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| is_address(s) && seen.insert(s.clone()))
        .collect()
}

fn check_category(category: &str) -> Result<(), MailError> {
    if CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err(MailError::Invalid(format!(
            "{category} isn't an inbox category."
        )))
    }
}

async fn own_address(db: &SqlitePool, account_id: &str) -> Result<String, MailError> {
    accounts::get_account(db, account_id)
        .await?
        .map(|a| a.email)
        .ok_or_else(|| MailError::Invalid("That account isn't connected any more.".into()))
}

fn gmail(e: GmailError) -> MailError {
    MailError::Sync(e.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::{FakeGmail, FakeMsg};

    struct Harness {
        _db: TestDb,
        fake: Arc<FakeGmail>,
        rules: SenderRuleService,
    }

    async fn setup(fake: FakeGmail) -> Harness {
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(fake);
        let api = fake.clone();
        let sync = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            Arc::new(RecordingEvents::default()),
        );
        sync.sync_account("a1").await.unwrap();
        Harness {
            _db: db,
            rules: SenderRuleService::new(pool, sync),
            fake,
        }
    }

    fn msg(id: &str, thread: &str, labels: &[&str], from: &str, at: i64) -> FakeMsg {
        FakeMsg {
            from: from.into(),
            ..FakeMsg::new(id, thread, labels).at(at)
        }
    }

    fn filter(from: &str, add: &[&str]) -> Filter {
        Filter {
            id: None,
            criteria: FilterCriteria {
                from: Some(from.into()),
                ..Default::default()
            },
            action: FilterAction {
                add_label_ids: add.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
        }
    }

    fn senders(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// `(sender, category)` of every filter Gmail holds.
    fn held(fake: &FakeGmail) -> Vec<(String, Vec<String>)> {
        fake.filters()
            .into_iter()
            .map(|f| (f.criteria.from.unwrap_or_default(), f.action.add_label_ids))
            .collect()
    }

    #[tokio::test]
    async fn lists_only_plain_sender_category_filters() {
        let fake = FakeGmail::new();
        let rule = fake.seed_filter(filter("news@x.com", &["CATEGORY_UPDATES"]));
        let mut subject = filter("a@x.com", &["CATEGORY_UPDATES"]);
        subject.criteria.other.insert("subject".into(), "hi".into());
        fake.seed_filter(subject);
        let mut forward = filter("b@x.com", &["CATEGORY_SOCIAL"]);
        forward.action.forward = Some("me@y.com".into());
        fake.seed_filter(forward);
        fake.seed_filter(filter("c@x.com", &["Label_1"]));
        fake.seed_filter(filter("d@x.com OR e@x.com", &["CATEGORY_SOCIAL"]));
        fake.seed_filter(filter("d@x.com,e@x.com", &["CATEGORY_SOCIAL"]));
        fake.seed_filter(filter("@x.com", &["CATEGORY_SOCIAL"]));
        fake.seed_filter(filter("d@x.com|e@x.com", &["CATEGORY_SOCIAL"]));
        let h = setup(fake).await;

        assert_eq!(
            h.rules.list_rules("a1").await.unwrap(),
            [SenderRuleDto {
                id: rule,
                sender: "news@x.com".into(),
                category: "CATEGORY_UPDATES".into()
            }]
        );
    }

    #[tokio::test]
    async fn save_creates_reuses_and_replaces() {
        let fake = FakeGmail::new();
        let same = fake.seed_filter(filter("same@x.com", &["CATEGORY_UPDATES"]));
        let other = fake.seed_filter(filter("moved@x.com", &["CATEGORY_PROMOTIONS"]));
        let h = setup(fake).await;

        let saved = h
            .rules
            .save_rules(
                "a1",
                &senders(&["New@X.com", "same@x.com", "moved@x.com", "new@x.com"]),
                "CATEGORY_UPDATES",
            )
            .await
            .unwrap();

        assert_eq!(
            saved.created.len(),
            2,
            "new@ and moved@, not same@: {saved:?}"
        );
        assert!(!saved.created.contains(&same));
        assert_eq!(
            saved.replaced,
            [SenderRuleDto {
                id: other,
                sender: "moved@x.com".into(),
                category: "CATEGORY_PROMOTIONS".into()
            }]
        );
        let mut now = held(&h.fake);
        now.sort();
        assert_eq!(
            now,
            [
                ("moved@x.com".into(), vec!["CATEGORY_UPDATES".to_string()]),
                ("new@x.com".into(), vec!["CATEGORY_UPDATES".to_string()]),
                ("same@x.com".into(), vec!["CATEGORY_UPDATES".to_string()]),
            ]
        );

        h.rules.undo_rules("a1", &saved).await.unwrap();
        let mut back = held(&h.fake);
        back.sort();
        assert_eq!(
            back,
            [
                (
                    "moved@x.com".into(),
                    vec!["CATEGORY_PROMOTIONS".to_string()]
                ),
                ("same@x.com".into(), vec!["CATEGORY_UPDATES".to_string()]),
            ],
            "Undo leaves the reused rule alone"
        );
    }

    #[tokio::test]
    async fn a_failed_save_puts_back_what_it_did() {
        let fake = FakeGmail::new();
        fake.seed_filter(filter("b@x.com", &["CATEGORY_SOCIAL"]));
        fake.fail_after(
            "create_filter",
            1,
            GmailError::Api {
                status: 500,
                reason: None,
                message: "backend".into(),
            },
        );
        let h = setup(fake).await;

        let err = h
            .rules
            .save_rules("a1", &senders(&["a@x.com", "b@x.com"]), "CATEGORY_UPDATES")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "api");
        assert_eq!(
            held(&h.fake),
            [("b@x.com".into(), vec!["CATEGORY_SOCIAL".to_string()])]
        );
    }

    #[tokio::test]
    async fn missing_scope_is_its_own_code() {
        let fake = FakeGmail::new();
        fake.fail_next(
            "list_filters",
            GmailError::Api {
                status: 403,
                reason: Some("insufficientPermissions".into()),
                message: "Request had insufficient authentication scopes.".into(),
            },
        );
        let h = setup(fake).await;
        assert_eq!(
            h.rules.list_rules("a1").await.unwrap_err().code(),
            "missing_scope"
        );
    }

    #[tokio::test]
    async fn delete_is_fine_twice_and_leaves_other_filters_alone() {
        let fake = FakeGmail::new();
        let rule = fake.seed_filter(filter("a@x.com", &["CATEGORY_UPDATES"]));
        let label = fake.seed_filter(filter("a@x.com", &["Label_1"]));
        let h = setup(fake).await;

        h.rules.delete_rule("a1", &rule).await.unwrap();
        h.rules.delete_rule("a1", &rule).await.unwrap();
        assert_eq!(
            h.rules.delete_rule("a1", &label).await.unwrap_err().code(),
            "invalid_input"
        );
        assert_eq!(h.fake.filters().len(), 1);
    }

    #[tokio::test]
    async fn rule_senders_skip_the_accounts_own_mail() {
        let fake = FakeGmail::new();
        // t1: they wrote, I replied last → them. t2: only me. t3: same sender as t1.
        fake.seed(msg("m1", "t1", &["INBOX"], "Ann <Ann@X.com>", 1_000));
        fake.seed(msg("m2", "t1", &["SENT"], "Me <me@example.com>", 2_000));
        fake.seed(msg("m3", "t2", &["SENT"], "me@example.com", 1_000));
        fake.seed(msg("m4", "t3", &["INBOX"], "ann@x.com", 1_000));
        let h = setup(fake).await;

        let found = h
            .rules
            .rule_senders("a1", &senders(&["t1", "t2", "t3"]))
            .await
            .unwrap();
        assert_eq!(found, ["ann@x.com"]);
        assert!(h
            .rules
            .rule_senders("a1", &senders(&["t2"]))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn inbox_threads_from_skips_archived_and_already_there() {
        let fake = FakeGmail::new();
        fake.seed(msg(
            "m1",
            "t1",
            &["INBOX", "CATEGORY_PERSONAL"],
            "a@x.com",
            1,
        ));
        fake.seed(msg(
            "m2",
            "t2",
            &["INBOX", "CATEGORY_UPDATES"],
            "a@x.com",
            1,
        ));
        fake.seed(msg("m3", "t3", &["CATEGORY_PERSONAL"], "a@x.com", 1));
        fake.seed(msg(
            "m4",
            "t4",
            &["INBOX", "CATEGORY_PROMOTIONS"],
            "A@x.com",
            1,
        ));
        fake.seed(msg("m5", "t5", &["INBOX"], "b@x.com", 1));
        let h = setup(fake).await;

        let mut found = h
            .rules
            .inbox_threads_from("a1", &senders(&["a@x.com"]), "CATEGORY_UPDATES")
            .await
            .unwrap();
        found.sort_by(|a, b| a.thread_id.cmp(&b.thread_id));
        assert_eq!(
            found,
            [
                InboxThreadDto {
                    thread_id: "t1".into(),
                    categories: vec!["CATEGORY_PERSONAL".into()]
                },
                InboxThreadDto {
                    thread_id: "t4".into(),
                    categories: vec!["CATEGORY_PROMOTIONS".into()]
                },
            ]
        );
        let primary = h
            .rules
            .inbox_threads_from("a1", &senders(&["a@x.com"]), "CATEGORY_PERSONAL")
            .await
            .unwrap();
        let mut ids: Vec<_> = primary.into_iter().map(|t| t.thread_id).collect();
        ids.sort();
        assert_eq!(ids, ["t2", "t4"]);
    }

    #[tokio::test]
    async fn rejects_a_label_that_isnt_a_category() {
        let h = setup(FakeGmail::new()).await;
        let err = h
            .rules
            .save_rules("a1", &senders(&["a@x.com"]), "Label_1")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(h.fake.calls("list_filters"), 0);
    }
}
