//! One account's sync: initial load, incremental sync from `history.list`, the
//! history-expiry reconcile, background backfill, and on-demand body loading.
//!
//! Every write goes through one transaction that also re-applies pending outbox ops
//! ([`outbox::rebase_threads`]), recomputes the touched threads, and confirms sends whose
//! message showed up ([`outbox::match_sends`]).

use super::api::MailApi;
use super::convert;
use super::events::{NewMail, SyncEvent, SyncEvents};
use super::outbox;
use crate::db::threads::{self, RecomputeResult, CATEGORY_LABELS};
use crate::db::{self, accounts, attachments, labels, messages, settings, sync_state};
use crate::gmail::types::{HistoryRecord, Message};
use crate::gmail::{GmailError, MessageFormat};
use crate::search;
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
/// Messages per Gmail search page.
pub const SEARCH_PAGE: u32 = 50;
/// Messages one step of an incremental sync may touch. A longer history (a week away, Mark all
/// as read on another device) is applied in steps of about this many, each committed with the
/// cursor moved to its last record: memory and the write stay bounded, and a failure keeps
/// the steps before it.
pub const HISTORY_CHUNK: usize = 200;
/// Cached messages a full resync re-reads per sync. Between two of them the queued changes
/// are sent and new mail is checked, so neither waits for the whole mailbox.
pub const RESYNC_CHUNK: usize = 200;

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

/// Whether `e` means Gmail answered but this one message can't be read: a response or a MIME
/// structure the parser doesn't understand. Asking again gives the same answer, so sync logs
/// the message and leaves it out instead of stopping at it for good. Network, server and
/// rate-limit errors are not this: they pass, and the sync is retried.
fn unreadable(account_id: &str, message_id: &str, e: &GmailError) -> bool {
    if !matches!(e, GmailError::Decode(_)) {
        return false;
    }
    tracing::warn!(account = account_id, message = message_id, error = %e, "skipping a message that can't be read");
    true
}

/// Ids of the messages a history record mentions.
fn mentioned(record: &HistoryRecord) -> impl Iterator<Item = &str> {
    record
        .messages_added
        .iter()
        .chain(&record.messages_deleted)
        .map(|m| &m.message)
        .chain(
            record
                .labels_added
                .iter()
                .chain(&record.labels_removed)
                .map(|c| &c.message),
        )
        .map(|m| m.id.as_str())
}

/// Split history (oldest first) into runs that each mention about [`HISTORY_CHUNK`] messages.
/// Always at least one run, the last of which may be empty.
fn history_chunks(records: &[HistoryRecord]) -> Vec<&[HistoryRecord]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut seen: HashSet<&str> = HashSet::new();
    for (i, record) in records.iter().enumerate() {
        seen.extend(mentioned(record));
        // The cursor is committed at a run's last record, so that record needs an id.
        if seen.len() >= HISTORY_CHUNK && !record.id.is_empty() && i + 1 < records.len() {
            chunks.push(&records[start..=i]);
            start = i + 1;
            seen.clear();
        }
    }
    chunks.push(&records[start..]);
    chunks
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Cache writes of one account, serialized. The set holds messages deleted by sync while a
/// backfill may still hold an older copy (tombstones), so backfill never resurrects them.
pub type WriteLock = Arc<tokio::sync::Mutex<HashSet<String>>>;

/// Label metadata changes of one account, serialized: [`SyncEngine::sync_labels`] holds it
/// from `labels.list` through its commit, and every `LabelService` change holds it from
/// reading the cache, through its Gmail calls, to its cache write, so a sync can't commit a
/// label snapshot taken before a change that has since been cached. Sync only ever
/// `try_lock`s it (and skips the label refresh if a change holds it), so message sync never
/// waits on a label change; changes do wait for an in-flight label refresh.
///
/// Lock order: `label_lock` before `write_lock`; never take `label_lock` while holding
/// `write_lock`.
pub type LabelLock = Arc<tokio::sync::Mutex<()>>;

/// How long colours fetched with `labels.get` are trusted when `labels.list` omits them.
pub const COLOR_REFETCH: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// `labels.get` calls in flight at once while fetching colours.
const COLOR_FETCHES: usize = 4;

/// When an account last fetched label colours one by one (in memory, per launch), and the
/// clock it reads (a field so tests can move time).
pub struct ColorSync {
    last_fetch: std::sync::Mutex<Option<std::time::Instant>>,
    now: Box<dyn Fn() -> std::time::Instant + Send + Sync>,
}

impl Default for ColorSync {
    fn default() -> Self {
        Self::with_clock(std::time::Instant::now)
    }
}

impl ColorSync {
    pub fn with_clock(now: impl Fn() -> std::time::Instant + Send + Sync + 'static) -> Self {
        Self {
            last_fetch: Default::default(),
            now: Box::new(now),
        }
    }

    fn last(&self) -> Option<std::time::Instant> {
        *self.last_fetch.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn stamp(&self) {
        *self.last_fetch.lock().unwrap_or_else(|e| e.into_inner()) = Some((self.now)());
    }

    fn stale(&self) -> bool {
        self.last()
            .is_none_or(|t| (self.now)().saturating_duration_since(t) >= COLOR_REFETCH)
    }
}

pub struct SyncEngine {
    pub db: SqlitePool,
    pub api: Arc<dyn MailApi>,
    pub account_id: String,
    pub events: Arc<dyn SyncEvents>,
    pub write_lock: WriteLock,
    pub label_lock: LabelLock,
    pub colors: Arc<ColorSync>,
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
    /// Not cached. `new`: history added it (new mail), so it's fetched in full; otherwise
    /// only its labels changed, and it's fetched like the backfill would have.
    Fetch {
        thread: String,
        new: bool,
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
            label_lock: Default::default(),
            colors: Default::default(),
        }
    }

    /// Share the account's [`ColorSync`] (the manager does; a lone engine has its own).
    pub fn with_color_sync(mut self, colors: Arc<ColorSync>) -> Self {
        self.colors = colors;
        self
    }

    /// Share the account's [`LabelLock`] (the manager does; a lone engine has its own).
    pub fn with_label_lock(mut self, label_lock: LabelLock) -> Self {
        self.label_lock = label_lock;
        self
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
        let profile = self.api.profile().await?;
        let history_id = profile.history_id;
        self.sync_labels().await?;
        let messages = self.inbox_first_page().await?;

        let guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let touched = self.store_messages(&mut tx, &messages, true).await?;
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        accounts::update_history_id(&mut *tx, &self.account_id, &history_id, now_ms() / 1000)
            .await?;
        sync_state::reset_backfill(&mut tx, &self.account_id).await?;
        sync_state::set_mailbox_total(&mut tx, &self.account_id, profile.messages_total).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        // A resync left unfinished by an account that was removed and added again.
        settings::clear_resync(&mut *tx, &self.account_id).await?;
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

    /// Apply everything since the stored history id. When Gmail no longer has that history,
    /// starts a full resync instead ([`Self::begin_resync`]), which later syncs continue a
    /// slice at a time. Returns whether any thread changed.
    pub async fn run_incremental_sync(&self) -> Result<bool, SyncError> {
        Ok(self.incremental_sync(false).await?.unwrap_or(false))
    }

    /// [`Self::run_incremental_sync`] for a frequent new-mail check: when Gmail has no history
    /// since the cursor it stops after that one request, with no label refresh, and returns
    /// `None` (having done the next slice of a full resync, if one is in progress; otherwise
    /// with no write or events at all). Otherwise it syncs in full and returns whether any
    /// thread changed.
    pub async fn check_incremental_sync(&self) -> Result<Option<bool>, SyncError> {
        self.incremental_sync(true).await
    }

    async fn incremental_sync(&self, quiet_if_unchanged: bool) -> Result<Option<bool>, SyncError> {
        let account = accounts::get_account(&self.db, &self.account_id)
            .await?
            .ok_or_else(|| SyncError::Db(anyhow::anyhow!("account {} is gone", self.account_id)))?;
        let Some(start) = account.history_id else {
            self.run_initial_sync().await?;
            return Ok(Some(true));
        };

        // Read every page first: a failure while listing applies nothing.
        let mut records = Vec::new();
        let mut page_token: Option<String> = None;
        let latest = loop {
            let page = match self.api.list_history(&start, page_token.as_deref()).await {
                Ok(page) => page,
                Err(e) if e.is_history_expired() => {
                    self.emit(SyncEvent::Started {
                        account_id: self.account(),
                    });
                    self.begin_resync().await?;
                    self.resync_step().await?;
                    self.emit(SyncEvent::LabelsUpdated {
                        account_id: self.account(),
                    });
                    self.emit(SyncEvent::Completed {
                        account_id: self.account(),
                    });
                    return Ok(Some(true));
                }
                Err(e) => return Err(e.into()),
            };
            records.extend(page.history);
            page_token = page.next_page_token;
            if page_token.is_none() {
                break page.history_id.unwrap_or(start.clone());
            }
        };
        let resyncing = settings::resync_position(&self.db, &self.account_id)
            .await?
            .is_some();
        let quiet = quiet_if_unchanged && records.is_empty();
        if quiet && !resyncing {
            return Ok(None);
        }
        self.emit(SyncEvent::Started {
            account_id: self.account(),
        });

        let mut changed = false;
        if !quiet {
            // Read before the writes open: hidden tabs' new mail alerts as Primary.
            let hidden_tabs = settings::inbox_tabs(&self.db, &self.account_id).await?;
            let chunks = history_chunks(&records);
            let last = chunks.len() - 1;
            for (n, chunk) in chunks.into_iter().enumerate() {
                // A record's id is a valid place to resume from: Gmail lists what came after it.
                let cursor = match chunk.last() {
                    Some(record) if n < last => record.id.as_str(),
                    _ => latest.as_str(),
                };
                changed |= self.apply_history(chunk, cursor, &hidden_tabs).await?;
            }
        }
        if resyncing {
            changed |= self.resync_step().await?;
        }
        if !quiet {
            // Counters move with every change and are cheap to read, so refresh them each
            // time; a failure here leaves the cursor committed and heals on the next sync.
            self.sync_labels().await?;
            self.emit(SyncEvent::LabelsUpdated {
                account_id: self.account(),
            });
        }
        self.emit(SyncEvent::Completed {
            account_id: self.account(),
        });
        Ok((!quiet).then_some(changed))
    }

    /// Apply one run of history records and commit it with the cursor at `cursor`. Returns
    /// whether any thread changed.
    async fn apply_history(
        &self,
        records: &[HistoryRecord],
        cursor: &str,
        hidden_tabs: &[String],
    ) -> Result<bool, SyncError> {
        let intents = self.fold_history(records).await?;
        let fetch = |wanted: bool| -> Vec<String> {
            intents
                .iter()
                .filter(|(_, i)| matches!(i, Intent::Fetch { new, .. } if *new == wanted))
                .map(|(id, _)| id.clone())
                .collect()
        };
        let mut gone = BTreeSet::new();
        // New mail, in full.
        let mut full = self
            .fetch(&fetch(true), MessageFormat::Full, &mut gone)
            .await?;
        // Mail that isn't cached and only changed labels (archived or read elsewhere before
        // the backfill got to it) is cached now, with its current labels, as the backfill
        // would: headers first, and the body only for mail inside the body window. Leaving it
        // to the backfill isn't safe: a page it fetched before the change would be stored
        // after this sync, with the old labels and the cursor already past the change.
        let relabelled = fetch(false);
        let mut headers_only = Vec::new();
        if !relabelled.is_empty() {
            let cutoff = now_ms() - FULL_BODY_DAYS * DAY_MS;
            let mut recent = Vec::new();
            for msg in self
                .fetch(&relabelled, MessageFormat::Metadata, &mut gone)
                .await?
            {
                if msg.internal_date_ms().is_none_or(|d| d >= cutoff) {
                    recent.push(msg.id);
                } else {
                    headers_only.push(msg);
                }
            }
            if !recent.is_empty() {
                full.extend(self.fetch(&recent, MessageFormat::Full, &mut gone).await?);
            }
        }

        let mut guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        // Tombstones only matter while a backfill can still bring the message back; it
        // clears them when it completes, so after that they would pile up for good.
        let backfilling = !sync_state::get(&mut *tx, &self.account_id)
            .await?
            .backfill_complete;
        // Only history additions can notify. Check cache membership under the same write lock
        // as the cursor commit: initial sync, search, backfill, label changes and replay stay silent.
        let added_ids: Vec<String> = records
            .iter()
            .flat_map(|r| &r.messages_added)
            .map(|m| m.message.id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let known = messages::existing_ids(&mut tx, &self.account_id, &added_ids).await?;
        let mut touched: Vec<String> = Vec::new();
        for (id, intent) in &intents {
            match intent {
                Intent::Delete { thread } => {
                    messages::delete_message(&mut *tx, &self.account_id, id).await?;
                    if backfilling {
                        guard.insert(id.clone());
                    }
                    touched.push(thread.clone());
                }
                Intent::Fetch { thread, .. } if gone.contains(id) => {
                    messages::delete_message(&mut *tx, &self.account_id, id).await?;
                    if backfilling {
                        guard.insert(id.clone());
                    }
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
                Intent::Fetch { thread, .. } => touched.push(thread.clone()),
                Intent::Labels { .. } => {}
            }
        }
        touched.extend(self.store_messages(&mut tx, &full, true).await?);
        touched.extend(self.store_messages(&mut tx, &headers_only, false).await?);
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        let mut new_mail = Vec::new();
        for id in added_ids.iter().filter(|id| !known.contains(*id)) {
            if let Some(message) = messages::get_message(&mut *tx, &self.account_id, id).await? {
                if let Some(mail) = NewMail::from_message(&message, hidden_tabs) {
                    new_mail.push(mail);
                }
            }
        }
        accounts::update_history_id(&mut *tx, &self.account_id, cursor, now_ms() / 1000).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        tx.commit().await?;
        drop(guard);

        let changed = !result.is_empty();
        self.emit_write(result, confirmed);
        if !new_mail.is_empty() {
            self.emit(SyncEvent::NewMail {
                account_id: self.account(),
                messages: new_mail,
            });
        }
        Ok(changed)
    }

    /// Fetch messages for a sync write. Ids Gmail no longer has go to `gone`. A message whose
    /// answer can't be decoded is asked for once more, then logged and left out; any other
    /// failure fails the fetch.
    async fn fetch(
        &self,
        ids: &[String],
        format: MessageFormat,
        gone: &mut BTreeSet<String>,
    ) -> Result<Vec<Message>, SyncError> {
        let mut fetched = Vec::new();
        let mut again = Vec::new();
        for (id, result) in self.api.batch_get_messages(ids, format).await {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {
                    gone.insert(id);
                }
                Err(GmailError::Decode(_)) => again.push(id),
                Err(e) => return Err(e.into()),
            }
        }
        if again.is_empty() {
            return Ok(fetched);
        }
        for (id, result) in self.api.batch_get_messages(&again, format).await {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {
                    gone.insert(id);
                }
                Err(e) if unreadable(&self.account_id, &id, &e) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(fetched)
    }

    /// Reduce history records, in order, to one intent per message.
    async fn fold_history(
        &self,
        records: &[HistoryRecord],
    ) -> Result<BTreeMap<String, Intent>, SyncError> {
        let mentioned: Vec<String> = records
            .iter()
            .flat_map(mentioned)
            .map(str::to_owned)
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
                        new: false,
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
                        new: true,
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
    /// keeping what's cached, in one go. Sync itself does this a slice per sync instead
    /// ([`Self::begin_resync`], then [`Self::resync_step`]).
    pub async fn run_full_resync(&self) -> Result<(), SyncError> {
        self.emit(SyncEvent::Started {
            account_id: self.account(),
        });
        self.begin_resync().await?;
        while settings::resync_position(&self.db, &self.account_id)
            .await?
            .is_some()
        {
            self.resync_step().await?;
        }
        self.emit(SyncEvent::LabelsUpdated {
            account_id: self.account(),
        });
        self.emit(SyncEvent::Completed {
            account_id: self.account(),
        });
        Ok(())
    }

    /// Start a full resync: the fresh Inbox page is cached and shown at once, the cursor moves
    /// to Gmail's current history id (so new mail and other devices' changes sync as usual
    /// from here on), the backfill starts over to pick up mail that arrived meanwhile, and
    /// the resync's position is set to the top of the cache, all in one write.
    ///
    /// Every cached message is then re-read by [`Self::resync_step`]. Until one is, it shows
    /// its labels from before the gap; that is safe with the cursor already moved because a
    /// re-read message carries its labels as of the read, later changes to it are in history
    /// after a cursor that was current before the read, and replaying label changes onto a
    /// state that already has them changes nothing.
    async fn begin_resync(&self) -> Result<(), SyncError> {
        // Read the cursor before anything else, as the initial sync does.
        let profile = self.api.profile().await?;
        self.sync_labels().await?;
        let inbox = self.inbox_first_page().await?;

        let guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let touched = self.store_messages(&mut tx, &inbox, true).await?;
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        accounts::update_history_id(
            &mut *tx,
            &self.account_id,
            &profile.history_id,
            now_ms() / 1000,
        )
        .await?;
        sync_state::reset_backfill(&mut tx, &self.account_id).await?;
        sync_state::set_mailbox_total(&mut tx, &self.account_id, profile.messages_total).await?;
        sync_state::touch(&mut tx, &self.account_id, now_ms()).await?;
        settings::set_resync_position(&mut *tx, &self.account_id, "").await?;
        tx.commit().await?;
        drop(guard);
        tracing::info!(account = %self.account_id, "Gmail's history expired; re-reading the cached mail");
        self.emit_write(result, confirmed);
        Ok(())
    }

    /// The next slice of a full resync: re-read the labels of up to [`RESYNC_CHUNK`] cached
    /// messages (highest id first), drop the ones Gmail no longer has, and commit that with
    /// the new position, so an error or a quit resumes here. Does nothing when no resync is
    /// in progress. Returns whether any thread changed.
    ///
    /// Must not run alongside an incremental sync of the same account (the manager's run lock
    /// sees to that): a slice writes labels it read a moment ago, which must not be older
    /// than what a sync has applied since.
    pub(crate) async fn resync_step(&self) -> Result<bool, SyncError> {
        let Some(position) = settings::resync_position(&self.db, &self.account_id).await? else {
            return Ok(false);
        };
        let below = Some(position.as_str()).filter(|p| !p.is_empty());
        let ids =
            messages::ids_below(&self.db, &self.account_id, below, RESYNC_CHUNK as i64).await?;
        let mut fresh = Vec::new();
        let mut gone = Vec::new();
        // One failed read (usually a rate limit) keeps what the others returned: their labels
        // are stored, the position stays, and the retry re-reads only this slice.
        let mut failure = None;
        if !ids.is_empty() {
            for (id, result) in self
                .api
                .batch_get_messages(&ids, MessageFormat::Minimal)
                .await
            {
                match result {
                    Ok(msg) => fresh.push(msg),
                    Err(e) if e.is_not_found() => gone.push(id),
                    Err(e) if unreadable(&self.account_id, &id, &e) => {}
                    Err(e) => {
                        failure.get_or_insert(e);
                    }
                }
            }
        }

        let mut guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let backfilling = !sync_state::get(&mut *tx, &self.account_id)
            .await?
            .backfill_complete;
        // As cached now, under the write lock: only real differences are written, so only
        // threads that changed are rebased, recomputed and announced.
        let cached = messages::label_map(&mut tx, &self.account_id, &ids).await?;
        let mut touched = Vec::new();
        for msg in &fresh {
            let Some((thread, labels)) = cached.get(&msg.id) else {
                continue;
            };
            let same = labels.len() == msg.label_ids.len()
                && labels.iter().all(|l| msg.label_ids.contains(l));
            if !same
                && messages::set_labels(&mut tx, &self.account_id, &msg.id, &msg.label_ids).await?
            {
                touched.push(thread.clone());
            }
        }
        for id in &gone {
            let Some((thread, _)) = cached.get(id) else {
                continue;
            };
            messages::delete_message(&mut *tx, &self.account_id, id).await?;
            if backfilling {
                guard.insert(id.clone());
            }
            touched.push(thread.clone());
        }
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        let done = failure.is_none() && ids.len() < RESYNC_CHUNK;
        if done {
            settings::clear_resync(&mut *tx, &self.account_id).await?;
        } else if let (None, Some(last)) = (&failure, ids.last()) {
            settings::set_resync_position(&mut *tx, &self.account_id, last).await?;
        }
        tx.commit().await?;
        drop(guard);
        if done {
            tracing::info!(account = %self.account_id, "cached mail re-read after Gmail's history expired");
        }

        let changed = !result.is_empty();
        self.emit_write(result, confirmed);
        match failure {
            Some(e) => Err(e.into()),
            None => Ok(changed),
        }
    }

    /// One page of the background walk over the whole mailbox (newest first). Bodies are
    /// fetched until the walk passes [`FULL_BODY_DAYS`]; metadata only after that.
    pub async fn backfill_step(&self) -> Result<BackfillProgress, SyncError> {
        let state = sync_state::get(&self.db, &self.account_id).await?;
        if state.backfill_complete {
            return Ok(BackfillProgress::Done);
        }
        // Accounts upgraded during a backfill have no saved mailbox size yet.
        let total = if sync_state::mailbox_total(&self.db, &self.account_id)
            .await?
            .is_none()
        {
            Some(self.api.backfill_profile().await?.messages_total)
        } else {
            None
        };
        let page = self
            .api
            .backfill_list_messages(state.backfill_page_token.as_deref(), BACKFILL_PAGE)
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
        for (id, result) in self.api.backfill_get_messages(&wanted, format).await {
            match result {
                Ok(msg) => fetched.push(msg),
                Err(e) if e.is_not_found() => {}
                // Left out, so the page completes and the walk moves on.
                Err(e) if unreadable(&self.account_id, &id, &e) => {}
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
        if let Some(total) = total {
            sync_state::set_mailbox_total(&mut tx, &self.account_id, total).await?;
        }
        let mut touched = Vec::new();
        let mut oldest = messages::oldest_date(&mut tx, &self.account_id, &ids).await?;
        for msg in &fetched {
            // Checked under the write lock, right before inserting: sync may have deleted
            // this message after we fetched it.
            if guard.contains(&msg.id) {
                continue;
            }
            let Some((row, atts)) = self.rows(msg, full)? else {
                continue;
            };
            oldest = match (oldest, row.date) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            self.insert_absent(&mut tx, row, &atts, &mut touched)
                .await?;
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
        self.load_thread_bodies_with_priority(thread_id, false)
            .await
    }

    pub async fn load_thread_bodies_with_priority(
        &self,
        thread_id: &str,
        preload: bool,
    ) -> Result<(), SyncError> {
        let ids = messages::unfetched_in_thread(&self.db, &self.account_id, thread_id).await?;
        if ids.is_empty() {
            return Ok(());
        }
        let mut fetched = Vec::new();
        let results = if preload {
            self.api
                .backfill_get_messages(&ids, MessageFormat::Full)
                .await
        } else {
            self.api.batch_get_messages(&ids, MessageFormat::Full).await
        };
        for (id, result) in results {
            match result {
                // One that can't be parsed stays without a body; the rest get theirs.
                Ok(msg) => fetched.extend(self.rows(&msg, true)?),
                Err(e) if e.is_not_found() => {}
                Err(e) if unreadable(&self.account_id, &id, &e) => {}
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
        for (row, atts) in &fetched {
            messages::set_body(&mut tx, row).await?;
            attachments::replace_for_message(&mut tx, &self.account_id, &row.id, atts).await?;
        }
        let result =
            threads::recompute_threads(&mut tx, &self.account_id, &[thread_id.to_owned()]).await?;
        tx.commit().await?;
        drop(guard);
        // A preload's caller gets the bodies in its answer. Announcing them would make the
        // app evict that answer and reload the list for every thread preloaded cold.
        if !preload {
            self.emit_write(result, Vec::new());
        }
        Ok(())
    }

    /// One page of a Gmail search. Threads with matches the cache doesn't have yet are
    /// fetched in full and cached like backfill does (backfill skips cached messages, so
    /// they get their bodies now). Returns the matching thread ids in Gmail's order
    /// (newest first) and the next page token.
    pub async fn search_gmail(
        &self,
        q: &str,
        page_token: Option<&str>,
    ) -> Result<(Vec<String>, Option<String>), SyncError> {
        let (q, spam_trash) = search::gmail_query(q);
        let page = self
            .api
            .search_messages(&q, spam_trash, page_token, SEARCH_PAGE)
            .await?;
        let ids: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
        let mut conn = self.db.acquire().await?;
        let cached = messages::existing_ids(&mut conn, &self.account_id, &ids).await?;
        drop(conn);
        let mut thread_ids = Vec::new();
        let mut missing = Vec::new();
        for m in &page.messages {
            if !thread_ids.contains(&m.thread_id) {
                thread_ids.push(m.thread_id.clone());
            }
            if !cached.contains(&m.id) && !missing.contains(&m.thread_id) {
                missing.push(m.thread_id.clone());
            }
        }
        if missing.is_empty() {
            return Ok((thread_ids, page.next_page_token));
        }

        let results: Vec<_> = stream::iter(missing)
            .map(|id| async move { self.api.get_thread(&id, MessageFormat::Full).await })
            .buffer_unordered(THREAD_FETCHES)
            .collect()
            .await;
        let mut fetched = Vec::new();
        for result in results {
            match result {
                Ok(thread) => fetched.extend(thread.messages),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(e.into()),
            }
        }

        let guard = self.write_lock.lock().await;
        let mut tx = db::begin_write(&self.db).await?;
        let mut touched = Vec::new();
        for msg in &fetched {
            // Sync may have deleted it since; don't bring it back.
            if guard.contains(&msg.id) {
                continue;
            }
            let Some((row, atts)) = self.rows(msg, true)? else {
                continue;
            };
            self.insert_absent(&mut tx, row, &atts, &mut touched)
                .await?;
        }
        let (result, confirmed) = self.finish_write(&mut tx, &touched).await?;
        tx.commit().await?;
        drop(guard);
        self.emit_write(result, confirmed);
        Ok((thread_ids, page.next_page_token))
    }

    /// Labels, plus fresh counters for Inbox and the category tabs.
    /// Skipped while a label change holds `label_lock`: message sync never waits on one, the
    /// change writes its own result to the cache, and the next sync refreshes labels.
    pub(crate) async fn sync_labels(&self) -> Result<(), SyncError> {
        let Ok(held) = self.label_lock.try_lock() else {
            tracing::debug!(account = %self.account_id, "label change in progress; label refresh skipped");
            return Ok(());
        };
        self.refresh_labels(&held).await
    }

    /// [`Self::sync_labels`] for a caller that already holds `label_lock` (`held`).
    pub(crate) async fn refresh_labels(
        &self,
        _held: &tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<(), SyncError> {
        let list = self.api.list_labels().await?;
        if list.is_empty() {
            // Gmail always lists its system labels. An empty answer is a fault, and taking it
            // at its word would strip every label from the cache.
            tracing::warn!(account = %self.account_id, "Gmail listed no labels; label refresh skipped");
            return Ok(());
        }
        let mut counted = Vec::new();
        for id in std::iter::once("INBOX").chain(CATEGORY_LABELS) {
            if list.iter().any(|l| l.id == id) {
                counted.push(self.api.get_label(id).await?);
            }
        }
        let mut rows: Vec<_> = list
            .iter()
            .map(|l| convert::to_db_label(&self.account_id, l))
            .collect();
        self.fill_missing_colors(&mut rows).await?;
        let mut tx = db::begin_write(&self.db).await?;
        let purged = labels::replace_labels(&mut tx, &self.account_id, &rows).await?;
        let result = threads::recompute_threads(&mut tx, &self.account_id, &purged).await?;
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
        if !result.is_empty() {
            self.emit(SyncEvent::messages_updated(&self.account_id, result));
        }
        Ok(())
    }

    /// `labels.list` sometimes omits colours. When it returns user labels and none has one,
    /// fetch each with `labels.get` (a few at a time) if this launch hasn't yet, the set of
    /// user labels (ids or names) differs from the cache, or the last fetch is 15 minutes
    /// old; otherwise carry the cached colours over so the refresh doesn't wipe them.
    async fn fill_missing_colors(&self, rows: &mut [labels::DbLabel]) -> Result<(), SyncError> {
        let is_user = |l: &labels::DbLabel| l.label_type == "user";
        let any_user = rows.iter().any(is_user);
        if !any_user
            || rows
                .iter()
                .any(|l| is_user(l) && l.color_background.is_some())
        {
            return Ok(());
        }
        let cached: std::collections::HashMap<String, labels::DbLabel> =
            labels::get_labels(&self.db, &self.account_id)
                .await?
                .into_iter()
                .filter(is_user)
                .map(|l| (l.id.clone(), l))
                .collect();
        let same_set = cached.len() == rows.iter().filter(|l| is_user(l)).count()
            && rows
                .iter()
                .filter(|l| is_user(l))
                .all(|l| cached.get(&l.id).is_some_and(|c| c.name == l.name));
        let fetch = !same_set || self.colors.stale();
        let ids: Vec<String> = rows
            .iter()
            .filter(|l| is_user(l))
            .map(|l| l.id.clone())
            .collect();
        let mut fetched = Vec::new();
        if fetch {
            for chunk in ids.chunks(COLOR_FETCHES) {
                let results =
                    futures::future::join_all(chunk.iter().map(|id| self.api.get_label(id))).await;
                fetched.extend(chunk.iter().zip(results));
            }
        }
        let mut failed = false;
        let mut colors = std::collections::HashMap::new();
        for (id, result) in fetched {
            match result {
                Ok(label) => {
                    if let Some(c) = label.color {
                        colors.insert(id.clone(), (c.background_color, c.text_color));
                    }
                }
                // Deleted since the list: nothing to colour.
                Err(e) if e.is_not_found() => {}
                Err(e) => {
                    tracing::warn!(account = %self.account_id, label = %id, error = %e, "couldn't fetch a label colour");
                    failed = true;
                }
            }
        }
        if fetch && !failed {
            self.colors.stamp();
        }
        for row in rows.iter_mut().filter(|l| is_user(l)) {
            let fresh = fetch.then(|| colors.remove(&row.id)).flatten();
            let (bg, text) = match fresh {
                Some((bg, text)) => (Some(bg), Some(text)),
                // Not fetched, or the fetch failed: keep what the cache has.
                None if !fetch || failed => cached
                    .get(&row.id)
                    .map(|c| (c.color_background.clone(), c.color_text.clone()))
                    .unwrap_or((None, None)),
                None => (None, None),
            };
            row.color_background = bg;
            row.color_text = text;
        }
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

    /// Stores a fetched message the cache doesn't hold yet, with its attachments, and notes its
    /// thread. One that is already cached is left as it is.
    async fn insert_absent(
        &self,
        tx: &mut SqliteConnection,
        row: messages::DbMessage,
        atts: &[attachments::DbAttachment],
        touched: &mut Vec<String>,
    ) -> Result<(), SyncError> {
        if messages::insert_message_if_absent(tx, &row).await? {
            attachments::replace_for_message(tx, &self.account_id, &row.id, atts).await?;
            touched.push(row.thread_id);
        }
        Ok(())
    }

    /// A fetched message as rows; `None` (logged) for one that can't be parsed, which every
    /// caller leaves out of the cache.
    fn rows(
        &self,
        msg: &Message,
        full: bool,
    ) -> Result<Option<(messages::DbMessage, Vec<attachments::DbAttachment>)>, SyncError> {
        match convert::message_rows(&self.account_id, msg, full) {
            Ok(rows) => Ok(Some(rows)),
            Err(e) if unreadable(&self.account_id, &msg.id, &e) => Ok(None),
            Err(e) => Err(e.into()),
        }
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
            let Some((row, atts)) = self.rows(msg, full)? else {
                continue;
            };
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
