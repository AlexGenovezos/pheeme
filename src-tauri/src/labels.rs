//! Creating, editing and deleting labels. These go straight to Gmail's labels API (not the
//! outbox: a create replayed after an ambiguous failure would make a duplicate), and the
//! result is written to the cache at once. Tauri-free; commands are thin adapters over
//! [`LabelService`].

use crate::db::labels::{self as db_labels, DbLabel};
use crate::db::{self, threads};
use crate::gmail::palette;
use crate::gmail::types::{LabelColor, LabelUpdate};
use crate::gmail::GmailError;
use crate::mail::{LabelDto, MailError};
use crate::sync::convert::to_db_label;
use crate::sync::engine::{SyncEngine, SyncError};
use crate::sync::manager::SyncManager;
use crate::sync::SyncEvent;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

/// Gmail's *In label list* values.
const LABEL_LIST_VISIBILITIES: [&str; 3] = ["labelShow", "labelShowIfUnread", "labelHide"];
/// Gmail's *In message list* values.
const MESSAGE_LIST_VISIBILITIES: [&str; 2] = ["show", "hide"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelColorDto {
    pub background: String,
    pub text: String,
}

/// What to change on a label; `None` fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelEdit {
    /// The full new path (`Clients/Acme`); renaming a parent renames its sublabels too.
    pub name: Option<String>,
    pub color: Option<LabelColorDto>,
    /// Remove the label's colour.
    #[serde(default)]
    pub clear_color: bool,
    pub label_list_visibility: Option<String>,
    pub message_list_visibility: Option<String>,
}

/// What a delete would take with it, for the confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreviewDto {
    /// Conversations carrying the label, per Gmail; `None` when Gmail couldn't say.
    pub threads: Option<i64>,
    /// Full names of the sublabels deleted with it.
    pub sublabels: Vec<String>,
}

/// Every change holds the account's [`crate::sync::engine::LabelLock`] from reading the cache
/// through its cache write, so a label sync can't commit a snapshot from before it.
pub struct LabelService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
}

impl LabelService {
    pub fn new(db: SqlitePool, sync: Arc<SyncManager>) -> Self {
        Self { db, sync }
    }

    /// Create a user label in Gmail and cache it. `name` is the full path (`Clients/Acme`).
    pub async fn create_label(
        &self,
        account_id: &str,
        name: &str,
        color: Option<LabelColorDto>,
    ) -> Result<LabelDto, MailError> {
        let name = clean_name(name)?;
        let color = color.map(gmail_color).transpose()?;
        let engine = self.sync.engine(account_id);
        let _held = engine.label_lock.lock().await;
        let all = db_labels::get_labels(&self.db, account_id).await?;
        if is_taken(&all, &name, &[]) {
            return Err(duplicate(&name));
        }
        let created = engine
            .api
            .create_label(&name, color)
            .await
            .map_err(|e| gmail_error(e, &name))?;
        let row = to_db_label(account_id, &created);
        store(&engine, std::slice::from_ref(&row)).await?;
        self.labels_updated(account_id);
        Ok(row.into())
    }

    /// Rename, re-nest, recolour or change the visibility of a user label. Renaming a parent
    /// renames every sublabel's path too, one Gmail update each, parent first. Returns every
    /// label changed, parent first.
    pub async fn update_label(
        &self,
        account_id: &str,
        label_id: &str,
        edit: LabelEdit,
    ) -> Result<Vec<LabelDto>, MailError> {
        let engine = self.sync.engine(account_id);
        let held = engine.label_lock.lock().await;
        let (all, label) = self.user_label(account_id, label_id).await?;
        check_visibility(&edit.label_list_visibility, &LABEL_LIST_VISIBILITIES)?;
        check_visibility(&edit.message_list_visibility, &MESSAGE_LIST_VISIBILITIES)?;
        if edit.clear_color && edit.color.is_some() {
            return Err(MailError::Invalid(
                "Choose a colour or remove it, not both.".into(),
            ));
        }
        let color = edit.color.map(gmail_color).transpose()?;
        let renames = match &edit.name {
            Some(name) => renames(&all, &label, &clean_name(name)?)?,
            None => Vec::new(),
        };
        let new_name = renames.first().map(|r| r.new.clone());

        let parent = if edit.clear_color {
            // Only a full replace (PUT) can remove a colour; start from Gmail's copy so
            // nothing else is reverted.
            let mut full = engine
                .api
                .get_label(&label.id)
                .await
                .map_err(|e| gmail_error(e, &label.name))?;
            full.color = None;
            if let Some(name) = &new_name {
                full.name = name.clone();
            }
            if edit.label_list_visibility.is_some() {
                full.label_list_visibility = edit.label_list_visibility;
            }
            if edit.message_list_visibility.is_some() {
                full.message_list_visibility = edit.message_list_visibility;
            }
            engine.api.replace_label(&full).await
        } else {
            let update = LabelUpdate {
                name: new_name.clone(),
                color,
                label_list_visibility: edit.label_list_visibility,
                message_list_visibility: edit.message_list_visibility,
            };
            if update == LabelUpdate::default() {
                return Ok(vec![label.into()]);
            }
            engine.api.update_label(&label.id, update).await
        }
        .map_err(|e| gmail_error(e, new_name.as_deref().unwrap_or(&label.name)))?;

        let mut done = vec![to_db_label(account_id, &parent)];
        for (i, rename) in renames.iter().enumerate().skip(1) {
            let update = LabelUpdate {
                name: Some(rename.new.clone()),
                ..Default::default()
            };
            match engine.api.update_label(&rename.id, update).await {
                Ok(renamed) => done.push(to_db_label(account_id, &renamed)),
                Err(e) => {
                    let left: Vec<&str> = renames[i..].iter().map(|r| r.old.as_str()).collect();
                    return Err(self.cascade_failed(&engine, &held, &done, &left, e).await);
                }
            }
        }
        store(&engine, &done).await?;
        self.labels_updated(account_id);
        let mut changed = Vec::with_capacity(done.len());
        for row in done {
            let cached = db_labels::get_label(&self.db, account_id, &row.id).await?;
            changed.push(cached.unwrap_or(row).into());
        }
        Ok(changed)
    }

    /// Delete a user label and its sublabels in Gmail, deepest first, dropping each from the
    /// cache (and its conversations) as soon as Gmail confirms it.
    pub async fn delete_label(&self, account_id: &str, label_id: &str) -> Result<(), MailError> {
        let engine = self.sync.engine(account_id);
        let _held = engine.label_lock.lock().await;
        let (all, label) = self.user_label(account_id, label_id).await?;
        let mut doomed = sublabels(&all, &label.name);
        doomed.sort_by(|a, b| depth(b).cmp(&depth(a)).then_with(|| b.name.cmp(&a.name)));
        doomed.push(&label);
        for (i, target) in doomed.iter().enumerate() {
            match engine.api.delete_label(&target.id).await {
                // Already gone in Gmail: drop it here too.
                Err(e) if e.is_not_found() => {}
                Err(e) if i == 0 => return Err(MailError::Sync(e.into())),
                Err(e) => {
                    self.labels_updated(account_id);
                    let left: Vec<&str> = doomed[i..].iter().map(|l| l.name.as_str()).collect();
                    return Err(MailError::Incomplete {
                        message: format!("Couldn't delete {} ({e}).", quoted(&left)),
                        cause: e.into(),
                    });
                }
                Ok(()) => {}
            }
            self.purge(&engine, &target.id).await?;
        }
        self.labels_updated(account_id);
        Ok(())
    }

    /// What deleting `label_id` takes with it: Gmail's conversation count (`None` if Gmail
    /// can't be asked) and the sublabels deleted too.
    pub async fn delete_preview(
        &self,
        account_id: &str,
        label_id: &str,
    ) -> Result<DeletePreviewDto, MailError> {
        let (all, label) = self.user_label(account_id, label_id).await?;
        let sublabels = sublabels(&all, &label.name)
            .into_iter()
            .map(|l| l.name.clone())
            .collect();
        let threads = match self.sync.engine(account_id).api.get_label(label_id).await {
            Ok(l) => l.threads_total.map(i64::from),
            Err(e) => {
                tracing::debug!(error = %e, "no conversation count for the delete preview");
                None
            }
        };
        Ok(DeletePreviewDto { threads, sublabels })
    }

    /// The account's cached labels and the user label `label_id` among them.
    async fn user_label(
        &self,
        account_id: &str,
        label_id: &str,
    ) -> Result<(Vec<DbLabel>, DbLabel), MailError> {
        let all = db_labels::get_labels(&self.db, account_id).await?;
        let label = all
            .iter()
            .find(|l| l.id == label_id)
            .cloned()
            .ok_or(MailError::LabelNotFound)?;
        if label.label_type != "user" {
            return Err(MailError::Invalid(
                "Gmail's own labels can't be changed.".into(),
            ));
        }
        Ok((all, label))
    }

    /// A rename cascade stopped part-way: keep what Gmail did, re-read the labels from Gmail
    /// so nothing is left mismatched, and name the labels still on their old path.
    async fn cascade_failed(
        &self,
        engine: &SyncEngine,
        held: &tokio::sync::MutexGuard<'_, ()>,
        done: &[DbLabel],
        left: &[&str],
        error: GmailError,
    ) -> MailError {
        if let Err(e) = store(engine, done).await {
            tracing::warn!(error = %e, "couldn't cache the labels Gmail renamed");
        }
        if let Err(e) = engine.refresh_labels(held).await {
            tracing::warn!(error = %e, "couldn't re-read labels after a failed rename");
        }
        self.labels_updated(&engine.account_id);
        let (verb, what) = if left.len() == 1 {
            ("wasn't", "This sublabel")
        } else {
            ("weren't", "These sublabels")
        };
        MailError::Incomplete {
            message: format!("{what} {verb} renamed: {} ({error}).", quoted(left)),
            cause: error.into(),
        }
    }

    /// Drop a label Gmail deleted from the cache and recompute the threads that had it.
    async fn purge(&self, engine: &SyncEngine, label_id: &str) -> Result<(), MailError> {
        let account_id = engine.account_id.as_str();
        let guard = engine.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let affected = db_labels::purge_labels(&mut tx, account_id, &[label_id.to_owned()]).await?;
        let result = threads::recompute_threads(&mut tx, account_id, &affected).await?;
        tx.commit().await.map_err(SyncError::from)?;
        drop(guard);
        if !result.is_empty() {
            self.sync
                .emit(SyncEvent::messages_updated(account_id, result));
        }
        Ok(())
    }

    fn labels_updated(&self, account_id: &str) {
        self.sync.emit(SyncEvent::LabelsUpdated {
            account_id: account_id.to_owned(),
        });
    }
}

/// One label's path change in a rename cascade.
struct Rename {
    id: String,
    old: String,
    new: String,
}

/// Every path change renaming `label` to `name` makes (parent first, then its sublabels), or
/// none when the name is unchanged. Rejects nesting a label under itself and names taken
/// by labels outside the cascade.
fn renames(all: &[DbLabel], label: &DbLabel, name: &str) -> Result<Vec<Rename>, MailError> {
    if name == label.name {
        return Ok(Vec::new());
    }
    let own_subtree = format!("{}/", label.name.to_lowercase());
    if name.to_lowercase().starts_with(&own_subtree) {
        return Err(MailError::Invalid(
            "A label can't be nested under itself or one of its sublabels.".into(),
        ));
    }
    let mut out = vec![Rename {
        id: label.id.clone(),
        old: label.name.clone(),
        new: name.to_owned(),
    }];
    out.extend(sublabels(all, &label.name).into_iter().map(|sub| Rename {
        id: sub.id.clone(),
        old: sub.name.clone(),
        new: format!("{name}{}", &sub.name[label.name.len()..]),
    }));
    let moving: Vec<&str> = out.iter().map(|r| r.id.as_str()).collect();
    if let Some(taken) = out.iter().find(|r| is_taken(all, &r.new, &moving)) {
        return Err(duplicate(&taken.new));
    }
    Ok(out)
}

/// User labels nested anywhere under `name`, sorted by name (so parents come first).
fn sublabels<'a>(all: &'a [DbLabel], name: &str) -> Vec<&'a DbLabel> {
    let prefix = format!("{name}/");
    let mut subs: Vec<&DbLabel> = all
        .iter()
        .filter(|l| l.label_type == "user" && l.name.starts_with(&prefix))
        .collect();
    subs.sort_by(|a, b| a.name.cmp(&b.name));
    subs
}

fn depth(label: &DbLabel) -> usize {
    label.name.matches('/').count()
}

/// `name` trimmed, or why it can't be a label name.
fn clean_name(name: &str) -> Result<String, MailError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(MailError::Invalid("Enter a name for the label.".into()));
    }
    if name.split('/').any(|part| part.trim().is_empty()) {
        return Err(MailError::Invalid(
            r#"A label name can't start or end with "/" or have an empty part between two "/"."#
                .into(),
        ));
    }
    Ok(name.to_owned())
}

/// Whether a label other than `except` already has `name`, ignoring case (as Gmail does).
fn is_taken(all: &[DbLabel], name: &str, except: &[&str]) -> bool {
    all.iter()
        .any(|l| !except.contains(&l.id.as_str()) && l.name.eq_ignore_ascii_case(name))
}

fn duplicate(name: &str) -> MailError {
    MailError::Invalid(format!(r#"A label named "{name}" already exists."#))
}

fn gmail_color(color: LabelColorDto) -> Result<LabelColor, MailError> {
    if palette::is_allowed(&color.background) && palette::is_allowed(&color.text) {
        Ok(LabelColor {
            text_color: color.text,
            background_color: color.background,
        })
    } else {
        Err(MailError::Invalid(
            "Pick a colour from Gmail's label palette.".into(),
        ))
    }
}

fn check_visibility(value: &Option<String>, allowed: &[&str]) -> Result<(), MailError> {
    match value {
        Some(v) if !allowed.contains(&v.as_str()) => Err(MailError::Invalid(format!(
            "Gmail doesn't have a \"{v}\" visibility."
        ))),
        _ => Ok(()),
    }
}

/// A Gmail failure for the label called `name`; Gmail's name clash (409) gets the same
/// message as the local duplicate check, in case the cache was behind.
fn gmail_error(error: GmailError, name: &str) -> MailError {
    match error {
        GmailError::Api { status: 409, .. } => duplicate(name),
        e => MailError::Sync(e.into()),
    }
}

fn quoted(names: &[&str]) -> String {
    names
        .iter()
        .map(|n| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Cache labels Gmail returned (counters are kept; see [`db_labels::upsert_label_tx`]).
async fn store(engine: &SyncEngine, rows: &[DbLabel]) -> Result<(), MailError> {
    let _guard = engine.write_lock.lock().await;
    let mut tx = db::begin_write(&engine.db).await?;
    for row in rows {
        db_labels::upsert_label_tx(&mut tx, row).await?;
    }
    tx.commit().await.map_err(SyncError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::labels as db_labels;
    use crate::db::test_support::TestDb;
    use crate::gmail::GmailError;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::{FakeGmail, FakeMsg};
    use crate::sync::MailApi;

    struct Harness {
        _db: TestDb,
        pool: SqlitePool,
        sync: Arc<SyncManager>,
        fake: Arc<FakeGmail>,
        events: Arc<RecordingEvents>,
        labels: LabelService,
    }

    /// An account `a1` synced once against `fake`, events cleared.
    async fn setup(fake: FakeGmail) -> Harness {
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(fake);
        let events = Arc::new(RecordingEvents::default());
        let api = fake.clone();
        let sync = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
        );
        sync.sync_account("a1").await.unwrap();
        events.take();
        Harness {
            _db: db,
            labels: LabelService::new(pool.clone(), sync.clone()),
            sync,
            pool,
            fake,
            events,
        }
    }

    fn with_labels(labels: &[(&str, &str)]) -> FakeGmail {
        let fake = FakeGmail::new();
        for (id, name) in labels {
            fake.add_user_label(id, name, None);
        }
        fake
    }

    /// The cached user labels, `id → name`, sorted by name.
    async fn cached(pool: &SqlitePool) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = db_labels::get_labels(pool, "a1")
            .await
            .unwrap()
            .into_iter()
            .filter(|l| l.label_type == "user")
            .map(|l| (l.id, l.name))
            .collect();
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        rows
    }

    /// Gmail's user labels, `id → name`, sorted by name.
    async fn in_gmail(fake: &FakeGmail) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = fake
            .list_labels()
            .await
            .unwrap()
            .into_iter()
            .filter(|l| l.label_type.as_deref() == Some("user"))
            .map(|l| (l.id, l.name))
            .collect();
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        rows
    }

    async fn cached_label(pool: &SqlitePool, id: &str) -> DbLabel {
        db_labels::get_label(pool, "a1", id).await.unwrap().unwrap()
    }

    fn named(name: &str) -> LabelEdit {
        LabelEdit {
            name: Some(name.into()),
            ..Default::default()
        }
    }

    fn green() -> LabelColorDto {
        LabelColorDto {
            background: "#16a766".into(),
            text: "#ffffff".into(),
        }
    }

    #[tokio::test]
    async fn create_writes_cache_and_emits() {
        let h = setup(FakeGmail::new()).await;

        let label = h
            .labels
            .create_label("a1", "  Clients/Acme ", Some(green()))
            .await
            .unwrap();

        assert_eq!(label.name, "Clients/Acme");
        assert_eq!(label.label_type, "user");
        assert_eq!(label.color_background.as_deref(), Some("#16a766"));
        let row = cached_label(&h.pool, &label.id).await;
        assert_eq!(row.label_type, "user");
        assert_eq!(row.name, "Clients/Acme");
        assert_eq!(row.color_text.as_deref(), Some("#ffffff"));
        assert_eq!(in_gmail(&h.fake).await, cached(&h.pool).await);
        assert_eq!(h.events.names(), ["sync:labels_updated"]);
    }

    /// A label sync that read `labels.list` before a create mustn't commit after it and
    /// purge the new label: the create waits for the sync, then writes.
    #[tokio::test]
    async fn create_survives_a_concurrent_label_sync() {
        let h = setup(FakeGmail::new()).await;
        let gate = h.fake.hold_get_labels();
        let counted = h.fake.calls("get_label");
        let sync = h.sync.clone();
        let syncing = tokio::spawn(async move { sync.engine("a1").sync_labels().await });
        // The sync has its (old) list and waits in the counter requests.
        while h.fake.calls("get_label") == counted {
            tokio::task::yield_now().await;
        }
        let labels = LabelService::new(h.pool.clone(), h.sync.clone());
        let creating = tokio::spawn(async move { labels.create_label("a1", "Work", None).await });
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let raced_ahead = h.fake.calls("create_label");

        gate.add_permits(1);
        syncing.await.unwrap().unwrap();
        let created = creating.await.unwrap().unwrap();

        assert_eq!(cached(&h.pool).await, [(created.id, "Work".into())]);
        assert_eq!(cached(&h.pool).await, in_gmail(&h.fake).await);
        assert_eq!(raced_ahead, 0, "the create waits for the label sync");
    }

    #[tokio::test]
    async fn create_rejects_invalid_names() {
        let h = setup(FakeGmail::new()).await;
        for name in ["", "   ", "/a", "a/", "a//b", "a/ /b"] {
            let err = h.labels.create_label("a1", name, None).await.unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{name:?}");
        }
        assert_eq!(h.fake.calls("create_label"), 0);
        assert!(cached(&h.pool).await.is_empty());
    }

    #[tokio::test]
    async fn create_rejects_disallowed_colour() {
        let h = setup(FakeGmail::new()).await;
        let color = LabelColorDto {
            background: "#123456".into(),
            text: "#ffffff".into(),
        };
        let err = h
            .labels
            .create_label("a1", "Work", Some(color))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(h.fake.calls("create_label"), 0);
    }

    #[tokio::test]
    async fn create_rejects_case_insensitive_duplicate() {
        let h = setup(with_labels(&[("L1", "Receipts")])).await;

        let err = h
            .labels
            .create_label("a1", "receipts", None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(
            err.to_string(),
            r#"A label named "receipts" already exists."#
        );
        // System labels count too.
        let err = h
            .labels
            .create_label("a1", "inbox", None)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), r#"A label named "inbox" already exists."#);
        assert_eq!(h.fake.calls("create_label"), 0);
    }

    #[tokio::test]
    async fn create_offline_changes_nothing() {
        let h = setup(with_labels(&[("L1", "Receipts")])).await;
        let before = cached(&h.pool).await;
        h.fake
            .fail_next("create_label", GmailError::Offline("no route".into()));

        let err = h.labels.create_label("a1", "Work", None).await.unwrap_err();

        // Offline maps to the app-wide `network` code (GmailError::code).
        assert_eq!(err.code(), "network");
        assert_eq!(cached(&h.pool).await, before);
        assert!(h.events.take().is_empty());
    }

    #[tokio::test]
    async fn rename_cascades_to_sublabels() {
        let h = setup(with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Clients/Acme/Q4"),
            ("L4", "Clientsx"),
        ]))
        .await;

        let changed = h
            .labels
            .update_label("a1", "L1", named("Customers"))
            .await
            .unwrap();

        let names: Vec<&str> = changed.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Customers", "Customers/Acme", "Customers/Acme/Q4"]);
        let expected: Vec<(String, String)> = [
            ("L4", "Clientsx"),
            ("L1", "Customers"),
            ("L2", "Customers/Acme"),
            ("L3", "Customers/Acme/Q4"),
        ]
        .iter()
        .map(|(i, n)| (i.to_string(), n.to_string()))
        .collect();
        assert_eq!(cached(&h.pool).await, expected);
        assert_eq!(in_gmail(&h.fake).await, expected);
        assert_eq!(h.events.names(), ["sync:labels_updated"]);
    }

    #[tokio::test]
    async fn renest_moves_subtree() {
        let h = setup(with_labels(&[
            ("L1", "Clients"),
            ("L2", "Acme"),
            ("L3", "Acme/Q4"),
        ]))
        .await;

        h.labels
            .update_label("a1", "L2", named("Clients/Acme"))
            .await
            .unwrap();

        let names: Vec<String> = cached(&h.pool).await.into_iter().map(|l| l.1).collect();
        assert_eq!(names, ["Clients", "Clients/Acme", "Clients/Acme/Q4"]);
        assert_eq!(in_gmail(&h.fake).await, cached(&h.pool).await);
    }

    #[tokio::test]
    async fn rename_rejects_into_own_subtree() {
        let h = setup(with_labels(&[("L1", "Clients"), ("L2", "Clients/Acme")])).await;

        let err = h
            .labels
            .update_label("a1", "L1", named("Clients/Acme/Clients"))
            .await
            .unwrap_err();

        assert_eq!(err.code(), "invalid_input");
        assert_eq!(h.fake.calls("update_label"), 0);
    }

    #[tokio::test]
    async fn rename_rejects_duplicates_and_bad_names() {
        let h = setup(with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Customers/Acme"),
            ("L4", "Work"),
        ]))
        .await;

        let err = h
            .labels
            .update_label("a1", "L4", named("clients"))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            r#"A label named "clients" already exists."#
        );
        // A sublabel's new path would collide.
        let err = h
            .labels
            .update_label("a1", "L1", named("Customers"))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            r#"A label named "Customers/Acme" already exists."#
        );
        let err = h
            .labels
            .update_label("a1", "L4", named("a//b"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(h.fake.calls("update_label"), 0);

        // Changing only the case of its own name is fine.
        h.labels
            .update_label("a1", "L4", named("WORK"))
            .await
            .unwrap();
        assert_eq!(cached_label(&h.pool, "L4").await.name, "WORK");
    }

    #[tokio::test]
    async fn rename_cascade_partial_failure_resyncs() {
        let h = setup(with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Clients/Acme/Q4"),
        ]))
        .await;
        // The parent and the first sublabel are renamed; the second sublabel fails.
        h.fake.fail_after(
            "update_label",
            2,
            GmailError::Api {
                status: 500,
                reason: None,
                message: "backend error".into(),
            },
        );

        let err = h
            .labels
            .update_label("a1", "L1", named("Customers"))
            .await
            .unwrap_err();

        let message = err.to_string();
        assert!(message.contains(r#""Clients/Acme/Q4""#), "{message}");
        assert!(!message.contains(r#""Clients/Acme""#), "{message}");
        assert_eq!(err.code(), "api");
        let gmail = in_gmail(&h.fake).await;
        let names: Vec<&str> = gmail.iter().map(|l| l.1.as_str()).collect();
        assert_eq!(names, ["Clients/Acme/Q4", "Customers", "Customers/Acme"]);
        assert_eq!(cached(&h.pool).await, gmail, "the cache matches Gmail");
        assert!(h.events.names().contains(&"sync:labels_updated"));
    }

    #[tokio::test]
    async fn clear_color_uses_replace() {
        let fake = FakeGmail::new();
        fake.add_user_label("L1", "Travel", Some(("#ffffff", "#16a766")));
        let h = setup(fake).await;
        assert_eq!(
            cached_label(&h.pool, "L1")
                .await
                .color_background
                .as_deref(),
            Some("#16a766")
        );

        let edit = LabelEdit {
            clear_color: true,
            ..Default::default()
        };
        let changed = h.labels.update_label("a1", "L1", edit).await.unwrap();

        assert_eq!(h.fake.calls("replace_label"), 1);
        assert_eq!(h.fake.get_label("L1").await.unwrap().color, None);
        let row = cached_label(&h.pool, "L1").await;
        assert_eq!((row.color_background, row.color_text), (None, None));
        assert_eq!(changed[0].color_background, None);
        assert_eq!(row.name, "Travel");
        assert_eq!(row.label_list_visibility.as_deref(), Some("labelShow"));
    }

    #[tokio::test]
    async fn colour_updates() {
        let h = setup(with_labels(&[("L1", "Travel")])).await;

        h.labels
            .update_label(
                "a1",
                "L1",
                LabelEdit {
                    color: Some(green()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let color = h.fake.get_label("L1").await.unwrap().color.unwrap();
        assert_eq!(color.background_color, "#16a766");
        let row = cached_label(&h.pool, "L1").await;
        assert_eq!(row.color_background.as_deref(), Some("#16a766"));
        assert_eq!(row.color_text.as_deref(), Some("#ffffff"));
    }

    #[tokio::test]
    async fn visibility_updates() {
        let h = setup(with_labels(&[("L1", "Travel")])).await;

        let edit = LabelEdit {
            label_list_visibility: Some("labelShowIfUnread".into()),
            message_list_visibility: Some("hide".into()),
            ..Default::default()
        };
        h.labels.update_label("a1", "L1", edit).await.unwrap();

        let gmail = h.fake.get_label("L1").await.unwrap();
        assert_eq!(
            gmail.label_list_visibility.as_deref(),
            Some("labelShowIfUnread")
        );
        assert_eq!(gmail.message_list_visibility.as_deref(), Some("hide"));
        let row = cached_label(&h.pool, "L1").await;
        assert_eq!(
            row.label_list_visibility.as_deref(),
            Some("labelShowIfUnread")
        );
        assert_eq!(row.message_list_visibility.as_deref(), Some("hide"));
        assert_eq!(h.events.names(), ["sync:labels_updated"]);
    }

    #[tokio::test]
    async fn rejects_unknown_visibility() {
        let h = setup(with_labels(&[("L1", "Travel")])).await;
        for edit in [
            LabelEdit {
                label_list_visibility: Some("show".into()),
                ..Default::default()
            },
            LabelEdit {
                message_list_visibility: Some("labelHide".into()),
                ..Default::default()
            },
            LabelEdit {
                message_list_visibility: Some("sometimes".into()),
                ..Default::default()
            },
        ] {
            let err = h.labels.update_label("a1", "L1", edit).await.unwrap_err();
            assert_eq!(err.code(), "invalid_input");
        }
        assert_eq!(h.fake.calls("update_label"), 0);
    }

    #[tokio::test]
    async fn update_refuses_system_and_unknown_labels() {
        let h = setup(FakeGmail::new()).await;
        let err = h
            .labels
            .update_label("a1", "INBOX", named("Mine"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = h
            .labels
            .update_label("a1", "Nope", named("Mine"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "not_found");
        let err = h.labels.delete_label("a1", "Nope").await.unwrap_err();
        assert_eq!(err.code(), "not_found");
        assert_eq!(h.fake.calls("update_label"), 0);
        assert_eq!(h.fake.calls("delete_label"), 0);
    }

    #[tokio::test]
    async fn update_offline_changes_nothing() {
        let h = setup(with_labels(&[("L1", "Clients"), ("L2", "Clients/Acme")])).await;
        let before = cached(&h.pool).await;
        h.fake
            .fail_next("update_label", GmailError::Offline("no route".into()));

        let err = h
            .labels
            .update_label("a1", "L1", named("Customers"))
            .await
            .unwrap_err();

        assert_eq!(err.code(), "network");
        assert_eq!(cached(&h.pool).await, before);
        assert_eq!(in_gmail(&h.fake).await, before);
    }

    #[tokio::test]
    async fn delete_cascades_and_purges() {
        let fake = with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Clientsx"),
        ]);
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "L1", "L3"]));
        fake.seed(FakeMsg::new("m2", "t2", &["INBOX", "L2"]));
        let h = setup(fake).await;

        h.labels.delete_label("a1", "L1").await.unwrap();

        assert_eq!(in_gmail(&h.fake).await, [("L3".into(), "Clientsx".into())]);
        assert_eq!(cached(&h.pool).await, [("L3".into(), "Clientsx".into())]);
        let message_labels: Vec<String> =
            sqlx::query_scalar("SELECT label_ids FROM messages ORDER BY id")
                .fetch_all(&h.pool)
                .await
                .unwrap();
        assert_eq!(message_labels, [r#"["INBOX","L3"]"#, r#"["INBOX"]"#]);
        let thread_rows: Vec<(String, String)> =
            sqlx::query_as("SELECT thread_id, label_id FROM thread_labels ORDER BY 1, 2")
                .fetch_all(&h.pool)
                .await
                .unwrap();
        assert!(
            !thread_rows.iter().any(|(_, l)| l == "L1" || l == "L2"),
            "{thread_rows:?}"
        );
        assert!(thread_rows.contains(&("t1".into(), "L3".into())));
        let names = h.events.names();
        assert!(names.contains(&"sync:labels_updated"), "{names:?}");
        assert!(names.contains(&"sync:messages_updated"), "{names:?}");
    }

    #[tokio::test]
    async fn delete_deletes_deepest_first_and_stops_on_failure() {
        let h = setup(with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Clients/Acme/Q4"),
        ]))
        .await;
        h.fake
            .fail_after("delete_label", 1, GmailError::Offline("no route".into()));

        let err = h.labels.delete_label("a1", "L1").await.unwrap_err();

        assert_eq!(err.code(), "network");
        let message = err.to_string();
        assert!(message.contains(r#""Clients/Acme""#), "{message}");
        // The deepest went first, and the cache dropped only what Gmail deleted.
        let left = in_gmail(&h.fake).await;
        let names: Vec<&str> = left.iter().map(|l| l.1.as_str()).collect();
        assert_eq!(names, ["Clients", "Clients/Acme"]);
        assert_eq!(cached(&h.pool).await, left);
    }

    #[tokio::test]
    async fn delete_preview_counts() {
        let fake = with_labels(&[
            ("L1", "Clients"),
            ("L2", "Clients/Acme"),
            ("L3", "Clients/Acme/Q4"),
            ("L4", "Clientsx"),
        ]);
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "L1"]));
        fake.seed(FakeMsg::new("m2", "t1", &["INBOX", "L1"]));
        fake.seed(FakeMsg::new("m3", "t2", &["INBOX", "L1"]));
        let h = setup(fake).await;

        let preview = h.labels.delete_preview("a1", "L1").await.unwrap();
        assert_eq!(
            preview,
            DeletePreviewDto {
                threads: Some(2),
                sublabels: vec!["Clients/Acme".into(), "Clients/Acme/Q4".into()],
            }
        );

        h.fake
            .fail_next("get_label", GmailError::Offline("no route".into()));
        let preview = h.labels.delete_preview("a1", "L1").await.unwrap();
        assert_eq!(preview.threads, None);
        assert_eq!(preview.sublabels.len(), 2);
    }

    #[test]
    fn edit_deserializes_from_camel_case() {
        let edit: LabelEdit = serde_json::from_value(serde_json::json!({
            "name": "A",
            "clearColor": true,
            "labelListVisibility": "labelHide",
        }))
        .unwrap();
        assert_eq!(edit.name.as_deref(), Some("A"));
        assert!(edit.clear_color);
        assert_eq!(edit.label_list_visibility.as_deref(), Some("labelHide"));
        let edit: LabelEdit = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(edit, LabelEdit::default());
    }
}
