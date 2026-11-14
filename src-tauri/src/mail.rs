//! Reading and changing mail, for the UI (and later the MCP server). Reads come from
//! the SQLite cache; changes go through the outbox. Tauri-free; commands are thin
//! adapters over [`MailService`].

use crate::attachment_cache::AttachmentCache;
use crate::attachment_kind;
use crate::db::attachments::{self, DbAttachment};
use crate::db::messages::{parse_labels, DbMessage};
use crate::db::search::{self as search_db, ThreadSearch, LABEL_KEY_SEP};
use crate::db::threads::{self, DbThread, ThreadCursor, ThreadQuery};
use crate::db::{labels, messages, settings};
use crate::diagnostics::{ms_since, OpenTiming, OpenTimings, ShownTiming, ShownTimings};
use crate::gmail::mime::EmailAddress;
use crate::gmail::probe::{with_probe, ProbeStage, ProbeStats, RequestProbe};
use crate::gmail::{GmailError, MessageFormat};
use crate::render;
use crate::search;
use crate::sync::engine::now_ms;
use crate::sync::engine::SyncError;
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use crate::sync::{outbox, SyncEvent};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    /// Gmail made only part of a change (a label cascade stopped part-way); `message` names
    /// what's left, `cause` is why it stopped.
    #[error("{message}")]
    Incomplete {
        message: String,
        #[source]
        cause: SyncError,
    },
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
            MailError::Sync(e) | MailError::Incomplete { cause: e, .. } => e.code(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursorDto {
    pub last_message_date: i64,
    pub account_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummaryDto {
    pub id: String,
    pub account_id: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    /// Milliseconds since the epoch; 0 when unknown.
    pub date: i64,
    pub unread: bool,
    pub starred: bool,
    pub has_attachment: bool,
    pub message_count: i64,
    /// The thread's user labels (not system labels), sorted by label name.
    pub label_ids: Vec<String>,
    /// The thread's system labels (INBOX, CATEGORY_*, SPAM, TRASH, SENT…), sorted, so a row
    /// can say where the conversation sits.
    pub system_label_ids: Vec<String>,
}

impl From<DbThread> for ThreadSummaryDto {
    fn from(t: DbThread) -> Self {
        Self {
            id: t.id,
            account_id: t.account_id,
            subject: t.subject,
            snippet: t.snippet,
            from_name: t.from_name,
            from_address: t.from_address,
            date: t.last_message_date.unwrap_or(0),
            unread: t.unread_count > 0,
            starred: t.is_starred != 0,
            has_attachment: t.has_attachment != 0,
            message_count: t.message_count,
            label_ids: Vec::new(),
            system_label_ids: Vec::new(),
        }
    }
}

/// Summaries of `threads`, each with its user label ids, from one query for the whole page.
async fn summaries(
    db: &SqlitePool,
    threads: Vec<DbThread>,
) -> anyhow::Result<Vec<ThreadSummaryDto>> {
    let keys: Vec<(String, String)> = threads
        .iter()
        .map(|t| (t.account_id.clone(), t.id.clone()))
        .collect();
    let mut by_thread = labels::user_label_ids_for(db, &keys).await?;
    let mut system = threads::system_label_ids_for(db, &keys).await?;
    Ok(threads
        .into_iter()
        .map(|t| {
            let key = (t.account_id.clone(), t.id.clone());
            let mut dto = ThreadSummaryDto::from(t);
            dto.label_ids = by_thread.remove(&key).unwrap_or_default();
            dto.system_label_ids = system.remove(&key).unwrap_or_default();
            dto
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPageDto {
    pub threads: Vec<ThreadSummaryDto>,
    pub next: Option<ThreadCursorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetailDto {
    pub id: String,
    pub thread_id: String,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
    /// Sanitized HTML fragment (see `render::sanitize_email_html`), never the raw body.
    pub body_html: Option<String>,
    pub has_remote_content: bool,
    pub declares_dark_mode: bool,
    pub body_text: Option<String>,
    /// False when only the message's metadata is cached (its body couldn't be fetched,
    /// e.g. offline): the UI offers to try again instead of showing an empty message.
    pub body_available: bool,
    pub unread: bool,
    pub starred: bool,
    pub label_ids: Vec<String>,
    pub has_attachment: bool,
    pub attachments: Vec<AttachmentDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub id: String,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub is_inline: bool,
    pub content_id: Option<String>,
}

impl From<DbAttachment> for AttachmentDto {
    fn from(a: DbAttachment) -> Self {
        Self {
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            size: a.size,
            is_inline: a.is_inline != 0,
            content_id: a.content_id,
        }
    }
}

impl From<DbMessage> for MessageDetailDto {
    fn from(m: DbMessage) -> Self {
        let addrs = |json: Option<&str>| -> Vec<EmailAddress> {
            json.and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default()
        };
        let body_available = has_body(&m);
        Self {
            body_available,
            to: addrs(m.to_addresses.as_deref()),
            cc: addrs(m.cc_addresses.as_deref()),
            label_ids: parse_labels(m.label_ids.as_deref()),
            id: m.id,
            thread_id: m.thread_id,
            from_name: m.from_name,
            from_address: m.from_address,
            subject: m.subject,
            snippet: m.snippet,
            date: m.date.unwrap_or(0),
            body_html: m.body_html,
            has_remote_content: false,
            declares_dark_mode: false,
            body_text: m.body_text,
            unread: m.is_read == 0,
            starred: m.is_starred != 0,
            has_attachment: m.has_attachment != 0,
            attachments: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailDto {
    pub thread: ThreadSummaryDto,
    pub messages: Vec<MessageDetailDto>,
    /// Set when some bodies weren't cached and fetching them failed.
    pub body_error: Option<BodyErrorDto>,
}

/// Why a thread's missing bodies couldn't be fetched: the error `code` (as commands report
/// it) and a plain message for the reader, free of URLs and request details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyErrorDto {
    pub code: String,
    pub message: String,
}

impl From<&SyncError> for BodyErrorDto {
    fn from(e: &SyncError) -> Self {
        let message = match e {
            SyncError::Gmail(GmailError::Network(_) | GmailError::Offline(_)) => {
                "Couldn't reach Gmail. You may be offline."
            }
            SyncError::Gmail(GmailError::RateLimit { .. }) => {
                "Gmail asked Pheeme to slow down. Try again in a minute."
            }
            SyncError::Gmail(GmailError::KeychainLocked(_)) => {
                "Pheeme can't read this account's sign-in from the keychain right now. Unlock your Mac and try again."
            }
            SyncError::Gmail(GmailError::Auth(_) | GmailError::SignedOut(_)) => {
                "Gmail didn't accept this account's sign-in. Sign in again from Settings."
            }
            SyncError::Gmail(GmailError::Api { status, .. }) if *status >= 500 => {
                "Gmail had a problem. Try again in a moment."
            }
            SyncError::Gmail(_) => "Gmail wouldn't return this message.",
            SyncError::Db(_) => "Pheeme couldn't save this message on this computer.",
        };
        Self {
            code: e.code().to_owned(),
            message: message.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelDto {
    pub id: String,
    pub account_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub label_type: String,
    pub messages_total: i64,
    pub messages_unread: i64,
    pub threads_total: i64,
    pub threads_unread: i64,
    pub color_background: Option<String>,
    pub color_text: Option<String>,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
}

impl From<labels::DbLabel> for LabelDto {
    fn from(l: labels::DbLabel) -> Self {
        Self {
            id: l.id,
            account_id: l.account_id,
            name: l.name,
            label_type: l.label_type,
            messages_total: l.messages_total,
            messages_unread: l.messages_unread,
            threads_total: l.threads_total,
            threads_unread: l.threads_unread,
            color_background: l.color_background,
            color_text: l.color_text,
            message_list_visibility: l.message_list_visibility,
            label_list_visibility: l.label_list_visibility,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountDto {
    pub label_id: String,
    pub unread: i64,
}

/// Unread and total conversations under one label of an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelCountDto {
    pub label_id: String,
    pub unread: i64,
    pub total: i64,
}

/// An attachment's content with what is needed to serve or save it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentBytes {
    pub filename: Option<String>,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// What the `pheeme-att` protocol answers with; the Tauri adapter only converts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl InlineResponse {
    pub fn not_found() -> Self {
        Self {
            status: 404,
            content_type: None,
            body: Vec::new(),
        }
    }
}

/// A file name that is safe to create in a directory: only the last path component,
/// without `:` or control characters, no leading/trailing dots or spaces.
pub fn safe_file_name(name: Option<&str>) -> String {
    let last = name
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| *c != ':' && !c.is_control())
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        "attachment".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// [`safe_file_name`], also valid on Windows: `<>"|?*` become `_` and a reserved device name
/// (`CON.pdf`, `com1.txt`) gets a leading `_`. Used for copies opened in the default app, which
/// only need to keep the extension.
fn openable_file_name(name: Option<&str>) -> String {
    let name: String = safe_file_name(name)
        .chars()
        .map(|c| if "<>\"|?*".contains(c) { '_' } else { c })
        .collect();
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || matches!(stem.as_bytes(), [b'C', b'O', b'M', d] | [b'L', b'P', b'T', d] if d.is_ascii_digit());
    if reserved {
        format!("_{name}")
    } else {
        name
    }
}

/// `dir/name`, or `dir/name (1).ext`, `dir/name (2).ext`, … if that already exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    // `symlink_metadata` (not `exists`) so a dangling symlink counts as occupied.
    let taken = |p: &Path| std::fs::symlink_metadata(p).is_ok();
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !taken(p))
        .expect("an unused name exists")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub threads: Vec<ThreadSummaryDto>,
    pub next: Option<ThreadCursorDto>,
    /// False when the query uses syntax only Gmail understands: local search found
    /// nothing because it didn't run, and the Gmail results are the whole answer.
    pub local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailSearchPageDto {
    /// Newest first. Now cached, so they open like any other thread.
    pub threads: Vec<ThreadSummaryDto>,
    /// Page token per account that has more results; pass it back for the next page.
    pub next: HashMap<String, String>,
    /// Accounts whose Gmail search failed (offline, for example).
    pub failed: Vec<String>,
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
        let before = before.map(|c| ThreadCursor {
            last_message_date: c.last_message_date,
            account_id: c.account_id,
            thread_id: c.thread_id,
        });
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
            next: page.next.map(|c| ThreadCursorDto {
                last_message_date: c.last_message_date,
                account_id: c.account_id,
                thread_id: c.thread_id,
            }),
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
        let mut details = Vec::with_capacity(messages.len());
        for m in messages {
            let atts =
                attachments::get_attachments_for_message(&self.db, account_id, &m.id).await?;
            let mut dto = MessageDetailDto::from(m);
            dto.attachments = atts.into_iter().map(Into::into).collect();
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

    /// A probe that reports an opened thread's fetch as `mail:thread_loading` events.
    fn loading_probe(&self, account_id: &str, thread_id: &str) -> Arc<RequestProbe> {
        let sync = self.sync.clone();
        let (account_id, thread_id) = (account_id.to_owned(), thread_id.to_owned());
        RequestProbe::new(move |stage| emit_loading(&sync, &account_id, &thread_id, Some(stage)))
    }

    /// Keep the open's timing and log it: at `info` when it went to Gmail or was slow.
    fn record_open(
        &self,
        account_id: &str,
        start: Instant,
        fetch: Option<BodyFetch>,
        result: &Result<ThreadDetailDto, MailError>,
    ) {
        let outcome = match result {
            Ok(detail) => detail.body_error.as_ref().map_or("ok", |e| e.code.as_str()),
            Err(e) => e.code(),
        };
        let stats = fetch.as_ref().map(|f| f.stats.clone()).unwrap_or_default();
        let timing = OpenTiming {
            at_ms: now_ms(),
            source: if fetch.is_some() { "gmail" } else { "cache" },
            total_ms: ms_since(start),
            slot_wait_ms: stats.slot_wait_ms,
            quota_wait_ms: stats.quota_wait_ms,
            gmail_ms: stats.gmail_ms,
            retries: stats.retries,
            last_status: stats.last_status,
            last_reason: stats.last_reason,
            messages_fetched: fetch.as_ref().map_or(0, |f| f.fetched),
            sync_busy: fetch.map_or_else(|| self.sync.sync_busy(account_id), |f| f.sync_busy),
            outcome: outcome.to_owned(),
        };
        macro_rules! log_open {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    source = timing.source,
                    total_ms = timing.total_ms,
                    slot_wait_ms = timing.slot_wait_ms,
                    quota_wait_ms = timing.quota_wait_ms,
                    gmail_ms = timing.gmail_ms,
                    retries = timing.retries,
                    last_status = ?timing.last_status,
                    last_reason = ?timing.last_reason,
                    messages_fetched = timing.messages_fetched,
                    sync_busy = timing.sync_busy,
                    outcome = %timing.outcome,
                    "thread opened"
                )
            };
        }
        if timing.source == "gmail" || timing.total_ms > 1000 {
            log_open!(tracing::Level::INFO);
        } else {
            log_open!(tracing::Level::DEBUG);
        }
        self.opens.record(timing);
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
        if add
            .iter()
            .chain(remove)
            .any(|l| l == "TRASH" || l == "SPAM")
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

    /// Mark every unread match of a search (`query`, the search bar's syntax) read in each of
    /// `account_ids`: the cached matches change now, and on Gmail the sweep covers every match
    /// that had arrived by now, downloaded or not.
    pub async fn mark_search_read(
        &self,
        account_ids: &[String],
        query: &str,
    ) -> Result<(), MailError> {
        let query = query.trim();
        if query.is_empty() || account_ids.is_empty() {
            return Err(MailError::Invalid("Nothing to mark read.".into()));
        }
        let (gmail, _) = search::gmail_query(query);
        let sweep = format!("({gmail}) is:unread");
        for account_id in account_ids {
            let account = std::slice::from_ref(account_id);
            let mut thread_ids = Vec::new();
            let mut before = None;
            loop {
                let page = self
                    .search_messages(account, query, before, Some(MAX_PAGE))
                    .await?;
                thread_ids.extend(page.threads.into_iter().filter(|t| t.unread).map(|t| t.id));
                match page.next {
                    Some(next) => before = Some(next),
                    None => break,
                }
            }
            let queued = outbox::enqueue_sweep(
                &self.db,
                account_id,
                &thread_ids,
                &[],
                &["UNREAD".to_owned()],
                &sweep,
            )
            .await?;
            self.after_change(account_id, queued);
        }
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
        Ok(msg
            .raw_headers
            .as_deref()
            .and_then(|j| serde_json::from_str(j).ok())
            .unwrap_or_default())
    }

    /// Which of `thread_ids` the account has cached, in the order given (the others can't be
    /// changed: the outbox only changes cached mail).
    pub async fn cached_threads(
        &self,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<Vec<String>, MailError> {
        let mut out = Vec::new();
        for id in thread_ids {
            if threads::get_thread(&self.db, account_id, id)
                .await?
                .is_some()
                && !out.contains(id)
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

    /// An attachment's bytes: from the disk cache, else downloaded from Gmail once.
    pub async fn attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
    ) -> Result<AttachmentBytes, MailError> {
        let row = attachments::get_one(&self.db, account_id, message_id, attachment_row_id)
            .await?
            .ok_or(MailError::NotFound)?;
        self.bytes_of(row).await
    }

    /// The text of the message's calendar invitation (its `text/calendar` part, else an `.ics`
    /// file), from the disk cache or Gmail; `None` when it has none.
    pub async fn invite_text(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Option<String>, MailError> {
        let rows =
            attachments::get_attachments_for_message(&self.db, account_id, message_id).await?;
        let Some(row) = invite_part(&rows) else {
            return Ok(None);
        };
        let bytes = self.bytes_of(row.clone()).await?.bytes;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The image behind a `cid:` reference; anything that isn't an `image/*` is `NotFound`.
    pub async fn inline_image(
        &self,
        account_id: &str,
        message_id: &str,
        content_id: &str,
    ) -> Result<AttachmentBytes, MailError> {
        let row = attachments::get_by_content_id(&self.db, account_id, message_id, content_id)
            .await?
            .filter(|r| {
                r.mime_type
                    .as_deref()
                    .is_some_and(|m| m.trim().to_ascii_lowercase().starts_with("image/"))
            })
            .ok_or(MailError::NotFound)?;
        self.bytes_of(row).await
    }

    /// Answers a `pheeme-att` request. The URI is parsed and its signature verified before
    /// anything else is touched; every failure is a bare 404.
    pub async fn serve_inline_image(&self, uri: &str) -> InlineResponse {
        let Some((account, message, cid)) = render::parse_attachment_request(uri) else {
            return InlineResponse::not_found();
        };
        match self.inline_image(&account, &message, &cid).await {
            // The type comes from the sender's MIME headers; it must be a valid header value.
            Ok(image) if !is_header_safe(&image.mime_type) => InlineResponse::not_found(),
            Ok(image) => InlineResponse {
                status: 200,
                content_type: Some(image.mime_type),
                body: image.bytes,
            },
            Err(e) => {
                tracing::debug!(error = %e, "inline image not served");
                InlineResponse::not_found()
            }
        }
    }

    /// Writes an attachment into `dir` under a sanitized, collision-free name and returns
    /// the path.
    pub async fn save_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
        dir: &Path,
    ) -> Result<PathBuf, MailError> {
        use tokio::io::AsyncWriteExt;
        let att = self
            .attachment(account_id, message_id, attachment_row_id)
            .await?;
        let name = safe_file_name(att.filename.as_deref());
        tokio::fs::create_dir_all(dir).await.map_err(io_error)?;
        // Each collision re-scans, and every occupied entry (even a dangling symlink) is
        // skipped, so this makes progress; the cap only guards against a runaway.
        for _ in 0..1000 {
            let path = unique_path(dir, &name);
            // `create_new` so a file that appears after the check is never overwritten.
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
            {
                Ok(mut file) => {
                    file.write_all(&att.bytes).await.map_err(io_error)?;
                    file.flush().await.map_err(io_error)?;
                    return Ok(path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_error(e)),
            }
        }
        Err(MailError::Invalid(
            "Couldn't find a free file name in Downloads.".into(),
        ))
    }

    async fn bytes_of(&self, row: DbAttachment) -> Result<AttachmentBytes, MailError> {
        let mime_type = row
            .mime_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let cached = self
            .attachments
            .path(&row.account_id, &row.message_id, &row.id);
        let _fetching = self.attachments.lock(&cached).await;
        let bytes = match self.attachments.read(&cached).await {
            Some(bytes) => bytes,
            None => self.download(&row, &cached).await?,
        };
        Ok(AttachmentBytes {
            filename: row.filename,
            mime_type,
            bytes,
        })
    }

    /// Fetch an attachment from Gmail and cache it at `cached`. Hold the file's
    /// [`AttachmentCache::lock`].
    async fn download(&self, row: &DbAttachment, cached: &Path) -> Result<Vec<u8>, MailError> {
        let api = self.sync.engine(&row.account_id).api;
        let bytes = match row.attachment_id.as_deref() {
            Some(gmail_id) => api
                .get_attachment(&row.message_id, gmail_id)
                .await
                .map_err(SyncError::from)?,
            // Small parts travel inside the message: re-read it and take the part
            // at this row's index (rows are numbered in parse order).
            None => embedded_bytes(api.as_ref(), row).await?,
        };
        if let Err(e) = self.attachments.write(cached, &bytes).await {
            tracing::warn!(error = %e, "couldn't cache an attachment");
        }
        Ok(bytes)
    }

    /// Download the previewable attachments of these messages into the cache, so opening a
    /// preview is instant. Files already cached, inline images, files of unknown size and
    /// files over [`PREFETCH_MAX_FILE`] are skipped; the run stops at [`PREFETCH_MAX_TOTAL`].
    /// Failures (offline, a deleted message) are logged and skipped. Returns how many files
    /// were downloaded.
    pub async fn prefetch_attachments(&self, account_id: &str, message_ids: &[String]) -> usize {
        let mut budget = PREFETCH_MAX_TOTAL;
        let mut fetched = 0;
        for message_id in message_ids {
            let rows =
                match attachments::get_attachments_for_message(&self.db, account_id, message_id)
                    .await
                {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::debug!(error = %e, "couldn't list attachments to prefetch");
                        continue;
                    }
                };
            for row in rows {
                let Some(size) = row.size.and_then(|s| u64::try_from(s).ok()) else {
                    continue;
                };
                if row.is_inline != 0
                    || size > PREFETCH_MAX_FILE
                    || !attachment_kind::previewable(
                        row.filename.as_deref(),
                        row.mime_type.as_deref(),
                    )
                {
                    continue;
                }
                if size > budget {
                    return fetched;
                }
                let cached = self
                    .attachments
                    .path(&row.account_id, &row.message_id, &row.id);
                let _fetching = self.attachments.lock(&cached).await;
                if self.attachments.contains(&cached).await {
                    continue;
                }
                budget -= size;
                match self.download(&row, &cached).await {
                    Ok(_) => fetched += 1,
                    Err(e) => tracing::debug!(error = %e, "couldn't prefetch an attachment"),
                }
            }
        }
        fetched
    }

    /// Copy an attachment into a fresh folder under `dir` for the default app to open, and
    /// return its path. Only documents and media qualify ([`attachment_kind::openable`]).
    /// Copies older than a day are cleared out first.
    pub async fn open_copy(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
        dir: &Path,
    ) -> Result<PathBuf, MailError> {
        let row = attachments::get_one(&self.db, account_id, message_id, attachment_row_id)
            .await?
            .ok_or(MailError::NotFound)?;
        if !attachment_kind::openable(row.filename.as_deref()) {
            return Err(MailError::Invalid(
                "Pheeme doesn't open this kind of file. Download it instead.".into(),
            ));
        }
        clear_old_copies(dir).await;
        let att = self.bytes_of(row).await?;
        let folder = dir.join(uuid::Uuid::new_v4().to_string());
        crate::storage::private_dir(dir).map_err(io_error)?;
        crate::storage::private_dir(&folder).map_err(io_error)?;
        let path = folder.join(openable_file_name(att.filename.as_deref()));
        tokio::fs::write(&path, &att.bytes)
            .await
            .map_err(io_error)?;
        Ok(path)
    }

    /// Local search over cached mail, newest first, keyset-paged like
    /// [`Self::list_threads`]. Takes Gmail search syntax (see [`crate::search`]).
    pub async fn search_messages(
        &self,
        account_ids: &[String],
        query: &str,
        before: Option<ThreadCursorDto>,
        limit: Option<i64>,
    ) -> Result<SearchPageDto, MailError> {
        let empty = |local| SearchPageDto {
            threads: Vec::new(),
            next: None,
            local,
        };
        let Some(q) = search::parse(query, now_ms()) else {
            return Ok(empty(false));
        };
        if q.is_empty() || account_ids.is_empty() {
            return Ok(empty(true));
        }
        let mut label_groups = Vec::with_capacity(q.labels.len());
        for value in &q.labels {
            let mut keys = Vec::new();
            for account_id in account_ids {
                for l in labels::get_labels(&self.db, account_id).await? {
                    if search::label_matches(value, &l.id, &l.name) {
                        keys.push(format!("{account_id}{LABEL_KEY_SEP}{}", l.id));
                    }
                }
            }
            if keys.is_empty() {
                return Ok(empty(true));
            }
            label_groups.push(keys);
        }
        let cursor = before.map(|c| ThreadCursor {
            last_message_date: c.last_message_date,
            account_id: c.account_id,
            thread_id: c.thread_id,
        });
        let page = search_db::search_threads(
            &self.db,
            &ThreadSearch {
                account_ids,
                fts: q.fts.as_deref(),
                label_groups: &label_groups,
                include_spam_trash: q.include_spam_trash,
                has_attachment: q.has_attachment,
                unread: q.unread,
                starred: q.starred,
                after: q.after,
                before: q.before,
                larger: q.larger,
                smaller: q.smaller,
                from_me: q.from_me,
                to_me: q.to_me,
                cursor: cursor.as_ref(),
                limit: limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE),
            },
        )
        .await?;
        Ok(SearchPageDto {
            threads: summaries(&self.db, page.threads).await?,
            next: page.next.map(|c| ThreadCursorDto {
                last_message_date: c.last_message_date,
                account_id: c.account_id,
                thread_id: c.thread_id,
            }),
            local: true,
        })
    }

    /// Gmail's own search, one page per account, run in parallel. Matches not cached yet
    /// are cached first. `page_tokens` continues a search: only the accounts in it are
    /// asked again. Fails only when every account's search failed.
    pub async fn search_gmail(
        &self,
        account_ids: &[String],
        query: &str,
        page_tokens: Option<HashMap<String, String>>,
    ) -> Result<GmailSearchPageDto, MailError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(MailError::Invalid("Type something to search for.".into()));
        }
        let pages: Vec<(String, Option<String>)> = match page_tokens {
            Some(tokens) => tokens.into_iter().map(|(a, t)| (a, Some(t))).collect(),
            None => account_ids.iter().map(|a| (a.clone(), None)).collect(),
        };
        let searches = pages.into_iter().map(|(account, token)| {
            let engine = self.sync.engine(&account);
            let query = query.to_owned();
            async move {
                let result = engine.search_gmail(&query, token.as_deref()).await;
                (account, result)
            }
        });
        let results = futures::future::join_all(searches).await;

        let mut out = GmailSearchPageDto {
            threads: Vec::new(),
            next: HashMap::new(),
            failed: Vec::new(),
        };
        let mut first_error = None;
        let mut found = Vec::new();
        let tried = results.len();
        for (account, result) in results {
            match result {
                Ok((thread_ids, next)) => {
                    for id in thread_ids {
                        if let Some(t) = threads::get_thread(&self.db, &account, &id).await? {
                            found.push(t);
                        }
                    }
                    if let Some(token) = next {
                        out.next.insert(account, token);
                    }
                }
                Err(e) => {
                    tracing::info!(account = %account, error = %e, "Gmail search failed");
                    out.failed.push(account);
                    first_error.get_or_insert(e);
                }
            }
        }
        if let Some(e) = first_error.filter(|_| out.failed.len() == tried) {
            return Err(e.into());
        }
        out.threads = summaries(&self.db, found).await?;
        out.threads
            .sort_by(|a, b| (b.date, &b.account_id, &b.id).cmp(&(a.date, &a.account_id, &a.id)));
        Ok(out)
    }

    /// Recent searches, newest first.
    pub async fn recent_searches(&self) -> Result<Vec<String>, MailError> {
        Ok(search_db::list_recent(&self.db).await?)
    }

    pub async fn add_recent_search(&self, query: &str) -> Result<(), MailError> {
        let query = query.trim();
        if !query.is_empty() {
            search_db::add_recent(&self.db, query, now_ms()).await?;
        }
        Ok(())
    }

    /// Forget one recent search, or all of them when `query` is `None`.
    pub async fn remove_recent_search(&self, query: Option<&str>) -> Result<(), MailError> {
        Ok(search_db::remove_recent(&self.db, query).await?)
    }

    /// Manual refresh: one account, or all.
    pub fn sync_now(&self, account_id: Option<String>) {
        self.sync.trigger(account_id);
    }
}

/// What fetching an opened thread's missing bodies took.
struct BodyFetch {
    stats: ProbeStats,
    /// Bodies it stored.
    fetched: usize,
    sync_busy: bool,
}

/// Emit `mail:thread_loading` for an opened thread; `None` is `done`.
fn emit_loading(sync: &SyncManager, account_id: &str, thread_id: &str, stage: Option<ProbeStage>) {
    let (stage, attempt, retry_in_ms, reason) = match stage {
        Some(ProbeStage::Queued) => ("queued", None, None, None),
        Some(ProbeStage::Fetching) => ("fetching", None, None, None),
        Some(ProbeStage::Retrying {
            attempt,
            retry_in,
            reason,
        }) => (
            "retrying",
            Some(attempt),
            Some(retry_in.as_millis() as u64),
            Some(reason.as_str()),
        ),
        None => ("done", None, None, None),
    };
    sync.emit(SyncEvent::ThreadLoading {
        account_id: account_id.to_owned(),
        thread_id: thread_id.to_owned(),
        stage,
        attempt,
        retry_in_ms,
        reason,
        sync_busy: sync.sync_busy(account_id),
    });
}

/// Invitations bigger than this aren't read (a real one is a few kilobytes).
const INVITE_MAX_BYTES: i64 = 1024 * 1024;

/// Whether an attachment is a calendar file, and how good a source of the invitation it is:
/// the `text/calendar` part Google and Outlook put beside the body (`2`) beats a named `.ics`
/// file (`1`), which may be a forwarded copy.
fn invite_rank(a: &DbAttachment) -> Option<u8> {
    let mime = a
        .mime_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let ics_name = a
        .filename
        .as_deref()
        .is_some_and(|f| f.to_ascii_lowercase().ends_with(".ics"));
    if a.size.is_some_and(|s| s > INVITE_MAX_BYTES) {
        return None;
    }
    if mime == "text/calendar" && !ics_name {
        Some(2)
    } else if mime == "text/calendar" || mime == "application/ics" || ics_name {
        Some(1)
    } else {
        None
    }
}

/// The attachment row to read a message's invitation from.
pub fn invite_part(rows: &[DbAttachment]) -> Option<&DbAttachment> {
    rows.iter()
        .filter_map(|a| Some((invite_rank(a)?, a)))
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, a)| a)
}

/// Bytes of an attachment that has no Gmail attachment id, from the full message.
async fn embedded_bytes(api: &dyn MailApi, row: &DbAttachment) -> Result<Vec<u8>, MailError> {
    let index: usize = row.id.parse().map_err(|_| MailError::NotFound)?;
    let (_, fetched) = api
        .batch_get_messages(std::slice::from_ref(&row.message_id), MessageFormat::Full)
        .await
        .into_iter()
        .next()
        .ok_or(MailError::NotFound)?;
    let parsed = fetched
        .map_err(SyncError::from)?
        .parse()
        .map_err(SyncError::from)?;
    parsed
        .attachments
        .into_iter()
        .nth(index)
        .and_then(|a| a.data)
        .filter(|bytes| !bytes.is_empty())
        .ok_or(MailError::NotFound)
}

/// The message's body is cached: a full copy (possibly genuinely empty) or any body text.
fn has_body(m: &DbMessage) -> bool {
    m.fully_fetched != 0 || m.body_html.is_some() || m.body_text.is_some()
}

/// Printable ASCII only: nothing that could end a header line or fail response building.
fn is_header_safe(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// Largest single file [`MailService::prefetch_attachments`] downloads (Gmail's own limit).
pub const PREFETCH_MAX_FILE: u64 = 25 * 1024 * 1024;
/// Most one prefetch run downloads, so a thread full of attachments can't fill the cache.
pub const PREFETCH_MAX_TOTAL: u64 = 100 * 1024 * 1024;
/// Copies handed to the default app are kept this long (the app may still have one open).
const OPEN_COPY_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Remove folders under `dir` made by [`MailService::open_copy`] more than a day ago.
async fn clear_old_copies(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let old = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > OPEN_COPY_MAX_AGE));
        if old {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

fn io_error(e: std::io::Error) -> MailError {
    MailError::Sync(SyncError::Db(anyhow::Error::new(e)))
}

#[cfg(test)]
mod tests;
