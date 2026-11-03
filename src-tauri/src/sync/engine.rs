//! One account's sync: initial load, incremental sync from `history.list`, the
//! history-expiry reconcile, background backfill, and on-demand body loading.
//!
//! Every write goes through one transaction that also re-applies pending outbox ops
//! ([`outbox::rebase_threads`]), recomputes the touched threads, and confirms sends whose
//! message showed up ([`outbox::match_sends`]).

use super::api::MailApi;
use super::convert;
use super::events::{SyncEvent, SyncEvents};
use super::outbox;
use crate::db::threads::{self, RecomputeResult, CATEGORY_LABELS};
use crate::db::{self, accounts, attachments, labels, messages, sync_state};
use crate::gmail::types::{HistoryRecord, Message};
use crate::gmail::{GmailError, MessageFormat};
use futures::stream::{self, StreamExt};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

pub const INITIAL_THREADS: u32 = 50;
pub const FULL_BODY_DAYS: i64 = 180;
pub const BACKFILL_PAGE: u32 = 500;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Concurrent `threads.get` calls; the client caps requests at 10 anyway.
const THREAD_FETCHES: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Gmail(#[from] GmailError),
    #[error("local cache error: {0}")]
    Db(#[from] anyhow::Error),
}

impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        SyncError::Db(e.into())
    }
}

impl SyncError {
    pub fn code(&self) -> &str {
        match self {
            SyncError::Gmail(e) => e.code(),
            SyncError::Db(_) => "internal",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillProgress {
    More,
    Done,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Cache writes of one account, serialized. The set holds messages deleted by sync while a
/// backfill may still hold an older copy (tombstones), so backfill never resurrects them.
pub type WriteLock = Arc<tokio::sync::Mutex<HashSet<String>>>;

pub struct SyncEngine {
    pub db: SqlitePool,
    pub api: Arc<dyn MailApi>,
    pub account_id: String,
    pub events: Arc<dyn SyncEvents>,
    pub write_lock: WriteLock,
}

/// What history says should happen to one message.
#[derive(Debug, Clone)]
enum Intent {
    /// Cached; these are its labels after the records seen so far.
    Labels {
        thread: String,
        labels: Vec<String>,
        changed: bool,
    },
    Fetch {
        thread: String,
    },
    Delete {
        thread: String,
    },
}

impl SyncEngine {
    pub fn new(
        db: SqlitePool,
        api: Arc<dyn MailApi>,
        account_id: impl Into<String>,
        events: Arc<dyn SyncEvents>,
        write_lock: WriteLock,
    ) -> Self {
        Self {
            db,
            api,
            account_id: account_id.into(),
            events,
            write_lock,
        }
    }

    fn emit(&self, event: SyncEvent) {
        self.events.emit(event);
    }

    fn account(&self) -> String {
        self.account_id.clone()
    }

    /// First sync of an account: labels, then the newest Inbox threads in full.
    pub async fn run_initial_sync(&self) -> Result<(), SyncError> {
        self.emit(SyncEvent::Started {
            account_id: self.account(),
        });
        // Read the cursor before anything else: every later change is then replayed by
        // history.list, and replaying is idempotent.
        let history_id = self.api.profile_history_id().await?;
        self.sync_labels().await?;
        let messages = self.inbox_first_page().await?;

        let guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let touched = self.store_messages(&mut tx, &messages, true).await?;
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        accounts::update_history_id(&mut *tx, &self.account_id, &history_id, now_ms() / 1000)
            .await?;
        sync_state::reset_backfill(&mut tx, &self.account_id).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        tx.commit().await?;
        drop(guard);

        self.emit_write(result, confirmed);
        self.emit(SyncEvent::LabelsUpdated {
            account_id: self.account(),
        });
        self.emit(SyncEvent::Completed {
            account_id: self.account(),
        });
        Ok(())
    }

    /// Apply everything since the stored history id. Falls back to [`Self::run_full_resync`]
    /// when Gmail no longer has that history. Returns whether any thread changed.
    pub async fn run_incremental_sync(&self) -> Result<bool, SyncError> {
        let account = accounts::get_account(&self.db, &self.account_id)
            .await?
            .ok_or_else(|| SyncError::Db(anyhow::anyhow!("account {} is gone", self.account_id)))?;
        let Some(start) = account.history_id else {
            self.run_initial_sync().await?;
            return Ok(true);
        };
        self.emit(SyncEvent::Started {
            account_id: self.account(),
        });

        // Read every page first: a failure part-way applies nothing.
        let mut records = Vec::new();
        let mut page_token: Option<String> = None;
        let latest = loop {
            let page = match self.api.list_history(&start, page_token.as_deref()).await {
                Ok(page) => page,
                Err(e) if e.is_history_expired() => {
                    self.run_full_resync().await?;
                    return Ok(true);
                }
                Err(e) => return Err(e.into()),
            };
            records.extend(page.history);
            page_token = page.next_page_token;
            if page_token.is_none() {
                break page.history_id.unwrap_or(start.clone());
            }
        };

        let intents = self.fold_history(&records).await?;
        let to_fetch: Vec<String> = intents
            .iter()
            .filter(|(_, i)| matches!(i, Intent::Fetch { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        let mut fetched = Vec::new();
        let mut gone = BTreeSet::new();
        for (id, result) in self
            .api
            .batch_get_messages(&to_fetch, MessageFormat::Full)
            .await
        {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {
                    gone.insert(id);
                }
                Err(e) => return Err(e.into()),
            }
        }

        let mut guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let mut touched: Vec<String> = Vec::new();
        for (id, intent) in &intents {
            match intent {
                Intent::Delete { thread } => {
                    messages::delete_message(&mut *tx, &self.account_id, id).await?;
                    guard.insert(id.clone());
                    touched.push(thread.clone());
                }
                Intent::Fetch { thread } if gone.contains(id) => {
                    messages::delete_message(&mut *tx, &self.account_id, id).await?;
                    guard.insert(id.clone());
                    touched.push(thread.clone());
                }
                Intent::Labels {
                    thread,
                    labels,
                    changed: true,
                } => {
                    messages::set_labels(&mut tx, &self.account_id, id, labels).await?;
                    touched.push(thread.clone());
                }
                Intent::Fetch { thread } => touched.push(thread.clone()),
                Intent::Labels { .. } => {}
            }
        }
        touched.extend(self.store_messages(&mut tx, &fetched, true).await?);
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        accounts::update_history_id(&mut *tx, &self.account_id, &latest, now_ms() / 1000).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        tx.commit().await?;
        drop(guard);

        let changed = !result.is_empty();
        self.emit_write(result, confirmed);
        // Counters move with every change and are cheap to read, so refresh them each time;
        // a failure here leaves the cursor committed and heals on the next sync.
        self.sync_labels().await?;
        self.emit(SyncEvent::LabelsUpdated {
            account_id: self.account(),
        });
        self.emit(SyncEvent::Completed {
            account_id: self.account(),
        });
        Ok(changed)
    }

    /// Reduce history records, in order, to one intent per message.
    async fn fold_history(
        &self,
        records: &[HistoryRecord],
    ) -> Result<BTreeMap<String, Intent>, SyncError> {
        let mentioned: Vec<String> = records
            .iter()
            .flat_map(|r| {
                r.messages_added
                    .iter()
                    .chain(&r.messages_deleted)
                    .map(|m| &m.message)
                    .chain(
                        r.labels_added
                            .iter()
                            .chain(&r.labels_removed)
                            .map(|c| &c.message),
                    )
            })
            .map(|m| m.id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut conn = self.db.acquire().await?;
        let cached = messages::label_map(&mut conn, &self.account_id, &mentioned).await?;
        drop(conn);

        let mut intents: BTreeMap<String, Intent> = BTreeMap::new();
        let current = |intents: &BTreeMap<String, Intent>, id: &str, thread: &str| {
            intents
                .get(id)
                .cloned()
                .unwrap_or_else(|| match cached.get(id) {
                    Some((t, l)) => Intent::Labels {
                        thread: t.clone(),
                        labels: l.clone(),
                        changed: false,
                    },
                    None => Intent::Fetch {
                        thread: thread.to_owned(),
                    },
                })
        };
        for record in records {
            for m in &record.messages_added {
                let msg = &m.message;
                intents.insert(
                    msg.id.clone(),
                    Intent::Fetch {
                        thread: msg.thread_id.clone(),
                    },
                );
            }
            for m in &record.messages_deleted {
                let msg = &m.message;
                let thread = match current(&intents, &msg.id, &msg.thread_id) {
                    Intent::Labels { thread, .. } => thread,
                    _ => msg.thread_id.clone(),
                };
                intents.insert(msg.id.clone(), Intent::Delete { thread });
            }
            for (change, adding) in record
                .labels_added
                .iter()
                .map(|c| (c, true))
                .chain(record.labels_removed.iter().map(|c| (c, false)))
            {
                let msg = &change.message;
                let next = match current(&intents, &msg.id, &msg.thread_id) {
                    Intent::Labels {
                        thread, mut labels, ..
                    } => {
                        for l in &change.label_ids {
                            labels.retain(|x| x != l);
                            if adding {
                                labels.push(l.clone());
                            }
                        }
                        Intent::Labels {
                            thread,
                            labels,
                            changed: true,
                        }
                    }
                    other => other,
                };
                intents.insert(msg.id.clone(), next);
            }
        }
        Ok(intents)
    }

    /// History is gone (the app was closed for about a week): rebuild against Gmail while
    /// keeping what's cached.
    pub async fn run_full_resync(&self) -> Result<(), SyncError> {
        self.emit(SyncEvent::Started {
            account_id: self.account(),
        });
        let history_id = self.api.profile_history_id().await?;
        self.sync_labels().await?;
        let inbox = self.inbox_first_page().await?;

        let mut on_server = HashSet::new();
        let mut page_token: Option<String> = None;
        loop {
            let page = self
                .api
                .list_messages(page_token.as_deref(), BACKFILL_PAGE)
                .await?;
            on_server.extend(page.messages.into_iter().map(|m| m.id));
            page_token = page.next_page_token;
            if page_token.is_none() {
                break;
            }
        }
        let inbox_ids: HashSet<&str> = inbox.iter().map(|m| m.id.as_str()).collect();
        let cached = messages::all_ids(&self.db, &self.account_id).await?;
        let mut deleted: Vec<(String, String)> = Vec::new();
        let mut refresh: Vec<String> = Vec::new();
        for (id, thread) in cached {
            if !on_server.contains(&id) {
                deleted.push((id, thread));
            } else if !inbox_ids.contains(id.as_str()) {
                refresh.push(id);
            }
        }
        let mut relabeled: Vec<Message> = Vec::new();
        for chunk in refresh.chunks(BACKFILL_PAGE as usize) {
            for (id, result) in self
                .api
                .batch_get_messages(chunk, MessageFormat::Minimal)
                .await
            {
                match result {
                    Ok(msg) => relabeled.push(msg),
                    Err(e) if e.is_not_found() => {
                        let thread = String::new();
                        deleted.push((id, thread));
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }

        let mut guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let mut touched = self.store_messages(&mut tx, &inbox, true).await?;
        for (id, thread) in &deleted {
            let thread = if thread.is_empty() {
                messages::get_message(&mut *tx, &self.account_id, id)
                    .await?
                    .map(|m| m.thread_id)
                    .unwrap_or_default()
            } else {
                thread.clone()
            };
            messages::delete_message(&mut *tx, &self.account_id, id).await?;
            guard.insert(id.clone());
            touched.push(thread);
        }
        for msg in &relabeled {
            if messages::set_labels(&mut tx, &self.account_id, &msg.id, &msg.label_ids).await? {
                touched.push(msg.thread_id.clone());
            }
        }
        touched.retain(|t| !t.is_empty());
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        accounts::update_history_id(&mut *tx, &self.account_id, &history_id, now_ms() / 1000)
            .await?;
        sync_state::reset_backfill(&mut tx, &self.account_id).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        tx.commit().await?;
        drop(guard);

        self.emit_write(result, confirmed);
        self.emit(SyncEvent::LabelsUpdated {
            account_id: self.account(),
        });
        self.emit(SyncEvent::Completed {
            account_id: self.account(),
        });
        Ok(())
    }

    /// One page of the background walk over the whole mailbox (newest first). Bodies are
    /// fetched until the walk passes [`FULL_BODY_DAYS`]; metadata only after that.
    pub async fn backfill_step(&self) -> Result<BackfillProgress, SyncError> {
        let state = sync_state::get(&self.db, &self.account_id).await?;
        if state.backfill_complete {
            return Ok(BackfillProgress::Done);
        }
        let page = self
            .api
            .list_messages(state.backfill_page_token.as_deref(), BACKFILL_PAGE)
            .await?;
        let ids: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
        let mut conn = self.db.acquire().await?;
        let cached = messages::existing_ids(&mut conn, &self.account_id, &ids).await?;
        drop(conn);
        let wanted: Vec<String> = ids
            .iter()
            .filter(|id| !cached.contains(*id))
            .cloned()
            .collect();
        let full = !state.backfill_bodies_done;
        let format = if full {
            MessageFormat::Full
        } else {
            MessageFormat::Metadata
        };
        let mut fetched = Vec::new();
        // One failed fetch (usually a rate limit) mustn't throw away the rest of the page:
        // what arrived is saved, the page stays current, and the retry skips cached ids.
        let mut failure = None;
        for (_, result) in self.api.batch_get_messages(&wanted, format).await {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {}
                Err(e) => {
                    failure.get_or_insert(e);
                }
            }
        }

        let mut guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        // A reset (initial sync or reconcile) while this page was in flight makes it stale.
        let now_state = sync_state::get(&mut *tx, &self.account_id).await?;
        if now_state.backfill_generation != state.backfill_generation {
            return Ok(BackfillProgress::More);
        }
        let mut touched = Vec::new();
        let mut oldest = messages::oldest_date(&mut tx, &self.account_id, &ids).await?;
        for msg in &fetched {
            // Checked under the write lock, right before inserting: sync may have deleted
            // this message after we fetched it.
            if guard.contains(&msg.id) {
                continue;
            }
            let (row, atts) = convert::message_rows(&self.account_id, msg, full)?;
            oldest = match (oldest, row.date) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            if messages::insert_message_if_absent(&mut tx, &row).await? {
                attachments::replace_for_message(&mut tx, &self.account_id, &row.id, &atts).await?;
                touched.push(row.thread_id);
            }
        }
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        if let Some(e) = failure {
            // Keep the page token and flags: the page isn't done.
            tx.commit().await?;
            drop(guard);
            self.emit_write(result, confirmed);
            return Err(e.into());
        }
        let cutoff = now_ms() - FULL_BODY_DAYS * DAY_MS;
        let bodies_done = state.backfill_bodies_done || oldest.is_some_and(|d| d < cutoff);
        let next = page.next_page_token;
        let complete = next.is_none();
        sync_state::save_backfill(
            &mut tx,
            &self.account_id,
            next.as_deref(),
            bodies_done,
            complete,
        )
        .await?;
        tx.commit().await?;
        if complete {
            guard.clear();
        }
        drop(guard);

        self.emit_write(result, confirmed);
        Ok(if complete {
            BackfillProgress::Done
        } else {
            BackfillProgress::More
        })
    }

    /// Fetch bodies the cache doesn't have yet for one thread (older mail outside the
    /// body window). Labels and flags are left to sync and the outbox.
    pub async fn load_thread_bodies(&self, thread_id: &str) -> Result<(), SyncError> {
        let ids = messages::unfetched_in_thread(&self.db, &self.account_id, thread_id).await?;
        if ids.is_empty() {
            return Ok(());
        }
        let mut fetched = Vec::new();
        for (_, result) in self.api.batch_get_messages(&ids, MessageFormat::Full).await {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(e.into()),
            }
        }
        // Nothing changed (the messages are gone from Gmail; sync removes them): no event,
        // so an open view that refreshes on `messages_updated` doesn't ask again in a loop.
        if fetched.is_empty() {
            return Ok(());
        }
        let guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        for msg in &fetched {
            let (row, atts) = convert::message_rows(&self.account_id, msg, true)?;
            messages::set_body(&mut tx, &row).await?;
            attachments::replace_for_message(&mut tx, &self.account_id, &row.id, &atts).await?;
        }
        let result =
            threads::recompute_threads(&mut tx, &self.account_id, &[thread_id.to_owned()]).await?;
        tx.commit().await?;
        drop(guard);
        self.emit_write(result, Vec::new());
        Ok(())
    }

    /// Labels, plus fresh counters for Inbox and the category tabs.
    async fn sync_labels(&self) -> Result<(), SyncError> {
        let list = self.api.list_labels().await?;
        let mut counted = Vec::new();
        for id in std::iter::once("INBOX").chain(CATEGORY_LABELS) {
            if list.iter().any(|l| l.id == id) {
                counted.push(self.api.get_label(id).await?);
            }
        }
        let rows: Vec<_> = list
            .iter()
            .map(|l| convert::to_db_label(&self.account_id, l))
            .collect();
        let mut tx = db::begin_write(&self.db).await?;
        labels::replace_labels(&mut tx, &self.account_id, &rows).await?;
        for label in &counted {
            let row = convert::to_db_label(&self.account_id, label);
            let counts = labels::LabelCounts {
                messages_total: row.messages_total,
                messages_unread: row.messages_unread,
                threads_total: row.threads_total,
                threads_unread: row.threads_unread,
            };
            labels::update_counts(&mut tx, &self.account_id, &label.id, counts).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// The newest Inbox threads, every message in full.
    async fn inbox_first_page(&self) -> Result<Vec<Message>, SyncError> {
        let list = self
            .api
            .list_threads("INBOX", None, INITIAL_THREADS)
            .await?;
        let results: Vec<_> = stream::iter(list.threads)
            .map(|t| async move { self.api.get_thread(&t.id, MessageFormat::Full).await })
            .buffer_unordered(THREAD_FETCHES)
            .collect()
            .await;
        let mut messages = Vec::new();
        for result in results {
            match result {
                Ok(thread) => messages.extend(thread.messages),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(messages)
    }

    /// Upsert fetched messages (and attachments); returns their thread ids.
    async fn store_messages(
        &self,
        conn: &mut SqliteConnection,
        msgs: &[Message],
        full: bool,
    ) -> Result<Vec<String>, SyncError> {
        let mut touched = Vec::new();
        for msg in msgs {
            let (row, atts) = convert::message_rows(&self.account_id, msg, full)?;
            messages::upsert_message_tx(conn, &row).await?;
            if full {
                attachments::replace_for_message(conn, &self.account_id, &row.id, &atts).await?;
            }
            touched.push(row.thread_id);
        }
        Ok(touched)
    }

    /// Re-apply pending ops, recompute threads, confirm sends — the tail of every write.
    async fn finish_write(
        &self,
        conn: &mut SqliteConnection,
        touched: &[String],
    ) -> Result<(RecomputeResult, Vec<String>), SyncError> {
        outbox::rebase_threads(conn, &self.account_id, touched, &BTreeSet::new()).await?;
        let result = threads::recompute_threads(conn, &self.account_id, touched).await?;
        let confirmed = outbox::match_sends(conn, &self.account_id).await?;
        Ok((result, confirmed))
    }

    fn emit_write(&self, result: RecomputeResult, confirmed: Vec<String>) {
        for op_id in confirmed {
            self.emit(SyncEvent::SendStatus {
                account_id: self.account(),
                op_id,
                status: "sent".into(),
            });
        }
        if !result.is_empty() {
            self.emit(SyncEvent::messages_updated(&self.account_id, result));
        }
    }
}
