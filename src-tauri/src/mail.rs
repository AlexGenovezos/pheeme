//! Reading and changing mail, for the UI (and later the MCP server). Reads come from
//! the SQLite cache; changes go through the outbox. Tauri-free; commands are thin
//! adapters over [`MailService`].
//!
//! `dto` holds what reads return, `attachment` the attachment bytes and file names,
//! `open_timing` the progress and timing of opening a thread, and `search` the searches.

mod attachment;
mod dto;
mod open_timing;
mod search;

pub use attachment::{
    invite_part, safe_file_name, unique_path, AttachmentBytes, InlineResponse, PREFETCH_MAX_FILE,
    PREFETCH_MAX_TOTAL,
};
pub use dto::{
    AttachmentDto, BodyErrorDto, CountDto, LabelCountDto, LabelDto, MessageDetailDto,
    ThreadCursorDto, ThreadDetailDto, ThreadPageDto, ThreadSummaryDto,
};
pub use search::{GmailSearchPageDto, SearchChange, SearchChangeDto, SearchPageDto};

use crate::attachment_cache::AttachmentCache;
use crate::db::attachments;
use crate::db::threads::{self, ThreadCursor, ThreadQuery};
use crate::db::{labels, messages, settings};
use crate::diagnostics::{OpenTiming, OpenTimings, ShownTiming, ShownTimings};
use crate::gmail::probe::with_probe;
use crate::gmail::GmailError;
use crate::render;
use crate::sync::engine::now_ms;
use crate::sync::engine::SyncError;
use crate::sync::manager::SyncManager;
use crate::sync::{outbox, SyncEvent};
use dto::{has_body, summaries};
use open_timing::{emit_loading, BodyFetch};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const DEFAULT_PAGE: i64 = 50;

/// `label_id` that lists every thread not in Spam or Trash (and its `label_counts` row).
pub const ALL_MAIL: &str = threads::ALL_MAIL;
/// The Primary tab is `INBOX` minus these (Gmail's own id for Primary is `CATEGORY_PERSONAL`).
pub const OTHER_CATEGORIES: [&str; 4] = [
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];
const PRIMARY_CATEGORY: &str = "CATEGORY_PERSONAL";

/// What Primary leaves out when the account hides the `hidden` tabs: the other
/// categories still shown (a hidden tab's mail shows under Primary).
pub fn primary_excludes(hidden: &[String]) -> Vec<String> {
    OTHER_CATEGORIES
        .iter()
        .filter(|l| !hidden.iter().any(|h| h == *l))
        .map(|l| (*l).to_owned())
        .collect()
}
/// The Gmail search for the unread mail of an inbox tab: `tab` (`CATEGORY_*`), or Primary
/// (`None`) as the inbox minus the `excludes` categories.
fn inbox_tab_search(tab: Option<&str>, excludes: &[String]) -> String {
    let category = |label: &str| {
        label
            .strip_prefix("CATEGORY_")
            .unwrap_or(label)
            .to_lowercase()
    };
    let mut q = String::from("in:inbox is:unread");
    if let Some(tab) = tab {
        q += &format!(" category:{}", category(tab));
    }
    for label in excludes {
        q += &format!(" -category:{}", category(label));
    }
    q
}

pub const MAX_PAGE: i64 = 500;

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("That conversation isn't available any more.")]
    NotFound,
    #[error("That label isn't available any more.")]
    LabelNotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Sync(#[from] SyncError),
    /// A file on this computer couldn't be written or read (a download, an attachment's
    /// open copy), which is no fault of Pheeme's cache.
    #[error("Pheeme couldn't save the file: {0}")]
    File(String),
    /// Gmail made only part of a change (a label cascade stopped part-way); `message` names
    /// what's left, `cause` is why it stopped.
    #[error("{message}")]
    Incomplete {
        message: String,
        #[source]
        cause: SyncError,
    },
}

impl From<GmailError> for MailError {
    fn from(e: GmailError) -> Self {
        MailError::Sync(e.into())
    }
}

impl From<anyhow::Error> for MailError {
    fn from(e: anyhow::Error) -> Self {
        MailError::Sync(SyncError::Db(e))
    }
}

impl MailError {
    pub fn code(&self) -> &str {
        match self {
            MailError::NotFound | MailError::LabelNotFound => "not_found",
            MailError::Invalid(_) => "invalid_input",
            MailError::File(_) => "file",
            MailError::Sync(e) | MailError::Incomplete { cause: e, .. } => e.code(),
        }
    }
}

#[derive(Clone)]
pub struct MailService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
    attachments: AttachmentCache,
    opens: Arc<OpenTimings>,
    shown: Arc<ShownTimings>,
    /// Each account's last label counts and the version of its threads they were counted at.
    label_counts: Arc<Mutex<HashMap<String, threads::LabelCounts>>>,
}

impl MailService {
    pub fn new(
        db: SqlitePool,
        sync: Arc<SyncManager>,
        cache_dir: PathBuf,
        key: crate::storage::StorageKey,
    ) -> Self {
        let attachments = AttachmentCache::new(db.clone(), &cache_dir, key);
        Self {
            db,
            sync,
            attachments,
            opens: Arc::default(),
            shown: Arc::default(),
            label_counts: Arc::default(),
        }
    }

    /// Timings of the most recent opened threads, oldest first.
    pub fn recent_opens(&self) -> Vec<OpenTiming> {
        self.opens.recent()
    }

    /// Log how long a picked conversation took to show in the window, and keep it for diagnostics.
    pub fn record_shown(&self, mut timing: ShownTiming) {
        timing.at_ms = now_ms();
        timing.log();
        self.shown.record(timing);
    }

    /// The most recent [`Self::record_shown`] timings, oldest first.
    pub fn recent_shown(&self) -> Vec<ShownTiming> {
        self.shown.recent()
    }

    /// Bound the attachment cache (see [`AttachmentCache::sweep`]).
    pub async fn sweep_attachment_cache(&self) {
        self.attachments.sweep().await;
    }

    /// Drop every cached email body (drafts' excepted) and attachment, for all accounts, and
    /// tell the UI which threads changed so it forgets their bodies too. Lists, labels and
    /// header search stay; opening an email downloads it again. Returns (messages, bytes).
    pub async fn clear_downloaded(&self) -> Result<(u64, u64), MailError> {
        let mut changed: HashMap<String, Vec<String>> = HashMap::new();
        for (account_id, thread_id) in messages::threads_with_bodies(&self.db).await? {
            changed.entry(account_id).or_default().push(thread_id);
        }
        let cleared = crate::body_retention::clear_all(&self.db).await?;
        let bytes = self.attachments.clear().await;
        for account in crate::db::accounts::list_accounts(&self.db).await? {
            self.sync.emit(SyncEvent::MessagesUpdated {
                modified: changed.remove(&account.id).unwrap_or_default(),
                account_id: account.id,
                added: Vec::new(),
                removed: Vec::new(),
            });
        }
        Ok((cleared, bytes))
    }

    /// Drop a removed account's cached attachment bytes.
    pub async fn forget_account(&self, account_id: &str) {
        self.attachments.remove_account(account_id).await;
    }

    /// Threads under `label_id` (and `also_label_id`, for a category tab) across
    /// `account_ids`, newest first. `label_id == ALL_MAIL` lists everything outside
    /// Spam and Trash; `also_label_id == CATEGORY_PERSONAL` lists `label_id` minus the
    /// categories whose tabs the account shows, so accounts without category labels still
    /// show their inbox (category tabs are always one account's, `account_ids[0]`).
    /// `read_filter`: None lists all rows; Some lists unread plus the supplied account/thread pairs.
    pub async fn list_threads(
        &self,
        account_ids: &[String],
        label_id: &str,
        also_label_id: Option<&str>,
        before: Option<ThreadCursorDto>,
        limit: Option<i64>,
        read_filter: Option<&[(String, String)]>,
    ) -> Result<ThreadPageDto, MailError> {
        let before = before.map(ThreadCursor::from);
        let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let page = if label_id == ALL_MAIL {
            threads::list_all_mail(&self.db, account_ids, before.as_ref(), limit, read_filter)
                .await?
        } else {
            let primary = also_label_id == Some(PRIMARY_CATEGORY);
            let exclude: Vec<String> = match account_ids.first() {
                Some(account_id) if primary => {
                    primary_excludes(&settings::inbox_tabs(&self.db, account_id).await?)
                }
                _ => Vec::new(),
            };
            threads::list_threads(
                &self.db,
                &ThreadQuery {
                    account_ids,
                    label_id,
                    also_label_id: if primary { None } else { also_label_id },
                    exclude_label_ids: &exclude,
                    read_filter,
                    before: before.as_ref(),
                    limit,
                },
            )
            .await?
        };
        Ok(ThreadPageDto {
            threads: summaries(&self.db, page.threads).await?,
            next: page.next.map(ThreadCursorDto::from),
        })
    }

    /// A thread with its messages. A message with no cached body is fetched first when
    /// Gmail is reachable (otherwise the cached copy is returned as is, with `body_error`
    /// saying why). Messages that have a body but are not fully fetched (attachment metadata
    /// cached before migration 003) are returned at once and refreshed in the background;
    /// that refresh emits `sync:messages_updated` for the thread.
    ///
    /// `opened`: the reader opened the thread (not a prefetch). Its fetch then goes ahead of
    /// sync and reports progress as `mail:thread_loading` events, and the open is timed.
    pub async fn get_thread(
        &self,
        account_id: &str,
        thread_id: &str,
        opened: bool,
    ) -> Result<ThreadDetailDto, MailError> {
        let start = Instant::now();
        let mut fetch = None;
        let result = self
            .read_thread(account_id, thread_id, opened, false, &mut fetch)
            .await;
        if opened {
            self.record_open(account_id, start, fetch, &result);
        }
        result
    }

    /// A speculative read for preloading: missing bodies come from bulk quota and a failure
    /// is returned rather than shown, so the caller can stop; nothing is refreshed.
    pub async fn preload_thread(
        &self,
        account_id: &str,
        thread_id: &str,
    ) -> Result<ThreadDetailDto, MailError> {
        self.read_thread(account_id, thread_id, false, true, &mut None)
            .await
    }

    /// [`Self::get_thread`]. `fetch` is set when an open had to fetch missing bodies.
    async fn read_thread(
        &self,
        account_id: &str,
        thread_id: &str,
        opened: bool,
        preload: bool,
        fetch: &mut Option<BodyFetch>,
    ) -> Result<ThreadDetailDto, MailError> {
        let mut messages =
            messages::get_messages_for_thread(&self.db, account_id, thread_id).await?;
        let mut body_error = None;
        let missing = messages.iter().filter(|m| !has_body(m)).count();
        if missing > 0 {
            let engine = self.sync.engine(account_id);
            let (result, probed) = if opened {
                let sync_busy = self.sync.sync_busy(account_id);
                let probe = self.loading_probe(account_id, thread_id);
                let result = with_probe(probe.clone(), engine.load_thread_bodies(thread_id)).await;
                emit_loading(&self.sync, account_id, thread_id, None);
                (result, Some((probe.snapshot(), sync_busy)))
            } else {
                (
                    engine
                        .load_thread_bodies_with_priority(thread_id, preload)
                        .await,
                    None,
                )
            };
            if let Err(e) = result {
                if preload {
                    return Err(e.into());
                }
                tracing::info!(thread = thread_id, error = %e, "showing cached thread without bodies");
                body_error = Some(BodyErrorDto::from(&e));
            }
            messages = messages::get_messages_for_thread(&self.db, account_id, thread_id).await?;
            if let Some((stats, sync_busy)) = probed {
                let still_missing = messages.iter().filter(|m| !has_body(m)).count();
                *fetch = Some(BodyFetch {
                    stats,
                    fetched: missing.saturating_sub(still_missing),
                    sync_busy,
                });
            }
        } else if !preload && messages.iter().any(|m| m.fully_fetched == 0) {
            let engine = self.sync.engine(account_id);
            let thread = thread_id.to_owned();
            tokio::spawn(async move {
                if let Err(e) = engine.load_thread_bodies(&thread).await {
                    tracing::info!(thread, error = %e, "couldn't refresh cached messages");
                }
            });
        }
        let thread = threads::get_thread(&self.db, account_id, thread_id)
            .await?
            .ok_or(MailError::NotFound)?;
        let mut by_message: HashMap<String, Vec<AttachmentDto>> = HashMap::new();
        for att in attachments::get_attachments_for_thread(&self.db, account_id, thread_id).await? {
            by_message
                .entry(att.message_id.clone())
                .or_default()
                .push(att.into());
        }
        let mut details = Vec::with_capacity(messages.len());
        for m in messages {
            let mut dto = MessageDetailDto::from(m);
            dto.attachments = by_message.remove(&dto.id).unwrap_or_default();
            if let Some(raw) = dto.body_html.take() {
                let body = render::sanitize_email_html(&raw, account_id, &dto.id);
                dto.body_html = Some(body.html);
                dto.has_remote_content = body.has_remote_content;
                dto.declares_dark_mode = body.declares_dark_mode;
            }
            details.push(dto);
        }
        Ok(ThreadDetailDto {
            thread: summaries(&self.db, vec![thread]).await?.remove(0),
            messages: details,
            body_error,
        })
    }

    pub async fn list_labels(&self, account_id: &str) -> Result<Vec<LabelDto>, MailError> {
        Ok(labels::get_labels(&self.db, account_id)
            .await?
            .into_iter()
            .map(LabelDto::from)
            .collect())
    }

    /// Unread conversations in Inbox and each category tab, across `account_ids`. Each
    /// account's Primary takes in the mail of the tabs it hides.
    pub async fn mailbox_counts(&self, account_ids: &[String]) -> Result<Vec<CountDto>, MailError> {
        let mut excludes = HashMap::new();
        for account_id in account_ids {
            let hidden = settings::inbox_tabs(&self.db, account_id).await?;
            excludes.insert(account_id.clone(), primary_excludes(&hidden));
        }
        Ok(threads::unread_counts(&self.db, account_ids, &excludes)
            .await?
            .into_iter()
            .map(|(label_id, unread)| CountDto { label_id, unread })
            .collect())
    }

    /// The inbox tabs `account_id` hides.
    pub async fn inbox_tabs(&self, account_id: &str) -> Result<Vec<String>, MailError> {
        Ok(settings::inbox_tabs(&self.db, account_id).await?)
    }

    /// Hide these inbox tabs of `account_id` (anything but Social, Promotions, Updates and
    /// Forums is ignored) and show the rest. Returns what's now hidden; emits
    /// `sync:labels_updated` so counts and lists reload.
    pub async fn set_inbox_tabs(
        &self,
        account_id: &str,
        hidden: &[String],
    ) -> Result<Vec<String>, MailError> {
        let hidden: Vec<String> = OTHER_CATEGORIES
            .iter()
            .filter(|l| hidden.iter().any(|h| h == *l))
            .map(|l| (*l).to_owned())
            .collect();
        settings::set_inbox_tabs(&self.db, account_id, &hidden).await?;
        self.sync.emit(SyncEvent::LabelsUpdated {
            account_id: account_id.to_owned(),
        });
        Ok(hidden)
    }

    /// Unread and total conversations per label of one account, counted from the cache.
    /// Counted again only when the account's threads changed since the last count.
    pub async fn label_counts(&self, account_id: &str) -> Result<Vec<LabelCountDto>, MailError> {
        let cached = self.cached_label_counts().get(account_id).cloned();
        let known = cached.as_ref().map(|c| c.version);
        let counts = match threads::label_counts(&self.db, account_id, known).await? {
            Some(fresh) => {
                let mut cache = self.cached_label_counts();
                // A slower count of an older version mustn't replace a newer one.
                if cache
                    .get(account_id)
                    .is_none_or(|c| c.version < fresh.version)
                {
                    cache.insert(account_id.to_owned(), fresh.clone());
                }
                fresh
            }
            // Unchanged since `cached` was counted (`None` comes only for a known version).
            None => cached.unwrap_or_default(),
        };
        Ok(counts
            .counts
            .into_iter()
            .map(|c| LabelCountDto {
                label_id: c.label_id,
                unread: c.unread,
                total: c.total,
            })
            .collect())
    }

    fn cached_label_counts(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, threads::LabelCounts>> {
        self.label_counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Add/remove labels on whole threads (archive = remove `INBOX`, read = remove
    /// `UNREAD`, star = add `STARRED`). Applied to the cache now, sent to Gmail in the
    /// background.
    pub async fn modify_threads(
        &self,
        account_id: &str,
        thread_ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<(), MailError> {
        if thread_ids.is_empty() || (add.is_empty() && remove.is_empty()) {
            return Err(MailError::Invalid("Nothing to change.".into()));
        }
        // Spam can be left only the way Gmail's Not spam leaves it: back to the inbox.
        let not_spam = add.iter().any(|l| l == "INBOX");
        if add.iter().any(|l| l == "TRASH" || l == "SPAM")
            || remove
                .iter()
                .any(|l| l == "TRASH" || (l == "SPAM" && !not_spam))
        {
            return Err(MailError::Invalid("Use trash for Trash.".into()));
        }
        let queued = outbox::enqueue_modify(&self.db, account_id, thread_ids, add, remove).await?;
        self.after_change(account_id, queued);
        Ok(())
    }

    /// Mark everything in one inbox tab of `account_id` read (`category` is `CATEGORY_*`;
    /// Primary takes in the tabs the account hides, like its count). The cached threads change
    /// now; on Gmail it covers every unread message in the tab, including mail not
    /// downloaded yet.
    pub async fn mark_inbox_tab_read(
        &self,
        account_id: &str,
        category: &str,
    ) -> Result<(), MailError> {
        let (tab, excludes) = if category == PRIMARY_CATEGORY {
            let hidden = settings::inbox_tabs(&self.db, account_id).await?;
            (None, primary_excludes(&hidden))
        } else if OTHER_CATEGORIES.contains(&category) {
            (Some(category), Vec::new())
        } else {
            return Err(MailError::Invalid("That isn't an inbox tab.".into()));
        };
        let thread_ids =
            threads::unread_inbox_tab_threads(&self.db, account_id, tab, &excludes).await?;
        let queued = outbox::enqueue_sweep(
            &self.db,
            account_id,
            &thread_ids,
            &[],
            &["UNREAD".to_owned()],
            &inbox_tab_search(tab, &excludes),
        )
        .await?;
        self.after_change(account_id, queued);
        Ok(())
    }

    /// Add and remove user labels on every message a Gmail search (`query`) finds, cached or
    /// not: Gmail finds them 500 at a time and changes up to 1,000 per request, so a big job
    /// costs a few hundred quota units instead of a read per conversation. The cache follows on
    /// the next sync.
    pub async fn modify_matching(
        &self,
        account_id: &str,
        query: &str,
        add: &[String],
        remove: &[String],
    ) -> Result<(), MailError> {
        let query = query.trim();
        if query.is_empty() || (add.is_empty() && remove.is_empty()) {
            return Err(MailError::Invalid("Nothing to change.".into()));
        }
        let queued = outbox::enqueue_sweep(&self.db, account_id, &[], add, remove, query).await?;
        self.after_change(account_id, queued);
        Ok(())
    }

    pub async fn trash_threads(
        &self,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<(), MailError> {
        if thread_ids.is_empty() {
            return Err(MailError::Invalid("Nothing to change.".into()));
        }
        let queued = outbox::enqueue_trash(&self.db, account_id, thread_ids).await?;
        self.after_change(account_id, queued);
        Ok(())
    }

    /// A message's headers, downloading its body first if only its metadata is cached.
    pub async fn message_headers(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<crate::gmail::types::Header>, MailError> {
        let mut msg = messages::get_message(&self.db, account_id, message_id)
            .await?
            .ok_or(MailError::NotFound)?;
        if msg.raw_headers.is_none() {
            self.sync
                .engine(account_id)
                .load_thread_bodies(&msg.thread_id)
                .await?;
            msg = messages::get_message(&self.db, account_id, message_id)
                .await?
                .ok_or(MailError::NotFound)?;
        }
        Ok(msg.headers())
    }

    /// Which of `thread_ids` the account has cached, in the order given (the others can't be
    /// changed: the outbox only changes cached mail).
    pub async fn cached_threads(
        &self,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<Vec<String>, MailError> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for id in thread_ids {
            if seen.insert(id.as_str())
                && threads::get_thread(&self.db, account_id, id)
                    .await?
                    .is_some()
            {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    fn after_change(&self, account_id: &str, queued: Option<outbox::EnqueueResult>) {
        if let Some(q) = queued {
            self.sync
                .emit(SyncEvent::messages_updated(account_id, q.threads));
            self.sync.trigger(Some(account_id.to_owned()));
        }
    }

    /// Manual refresh: one account, or all.
    pub fn sync_now(&self, account_id: Option<String>) {
        self.sync.trigger(account_id);
    }
}

#[cfg(test)]
mod tests;
