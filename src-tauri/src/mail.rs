//! Reading and changing mail, for the UI (and later the MCP server). Reads come from
//! the SQLite cache; changes go through the outbox. Tauri-free; commands are thin
//! adapters over [`MailService`].

use crate::db::messages::{parse_labels, DbMessage};
use crate::db::threads::{self, DbThread, ThreadCursor, ThreadQuery};
use crate::db::{labels, messages};
use crate::gmail::mime::EmailAddress;
use crate::sync::engine::SyncError;
use crate::sync::manager::SyncManager;
use crate::sync::{outbox, SyncEvent};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

pub const DEFAULT_PAGE: i64 = 50;
pub const MAX_PAGE: i64 = 500;

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("That conversation isn't available any more.")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Sync(#[from] SyncError),
}

impl From<anyhow::Error> for MailError {
    fn from(e: anyhow::Error) -> Self {
        MailError::Sync(SyncError::Db(e))
    }
}

impl MailError {
    pub fn code(&self) -> &str {
        match self {
            MailError::NotFound => "not_found",
            MailError::Invalid(_) => "invalid_input",
            MailError::Sync(e) => e.code(),
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
        }
    }
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
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub unread: bool,
    pub starred: bool,
    pub label_ids: Vec<String>,
    pub has_attachment: bool,
}

impl From<DbMessage> for MessageDetailDto {
    fn from(m: DbMessage) -> Self {
        let addrs = |json: Option<&str>| -> Vec<EmailAddress> {
            json.and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default()
        };
        Self {
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
            body_text: m.body_text,
            unread: m.is_read == 0,
            starred: m.is_starred != 0,
            has_attachment: m.has_attachment != 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailDto {
    pub thread: ThreadSummaryDto,
    pub messages: Vec<MessageDetailDto>,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountDto {
    pub label_id: String,
    pub unread: i64,
}

pub struct MailService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
}

impl MailService {
    pub fn new(db: SqlitePool, sync: Arc<SyncManager>) -> Self {
        Self { db, sync }
    }

    /// Threads under `label_id` (and `also_label_id`, for a category tab) across
    /// `account_ids`, newest first.
    pub async fn list_threads(
        &self,
        account_ids: &[String],
        label_id: &str,
        also_label_id: Option<&str>,
        before: Option<ThreadCursorDto>,
        limit: Option<i64>,
    ) -> Result<ThreadPageDto, MailError> {
        let before = before.map(|c| ThreadCursor {
            last_message_date: c.last_message_date,
            account_id: c.account_id,
            thread_id: c.thread_id,
        });
        let page = threads::list_threads(
            &self.db,
            &ThreadQuery {
                account_ids,
                label_id,
                also_label_id,
                before: before.as_ref(),
                limit: limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE),
            },
        )
        .await?;
        Ok(ThreadPageDto {
            threads: page.threads.into_iter().map(Into::into).collect(),
            next: page.next.map(|c| ThreadCursorDto {
                last_message_date: c.last_message_date,
                account_id: c.account_id,
                thread_id: c.thread_id,
            }),
        })
    }

    /// A thread with its messages. Bodies not cached yet are fetched first when Gmail is
    /// reachable; otherwise the cached copy is returned as is.
    pub async fn get_thread(
        &self,
        account_id: &str,
        thread_id: &str,
    ) -> Result<ThreadDetailDto, MailError> {
        if let Err(e) = self
            .sync
            .engine(account_id)
            .load_thread_bodies(thread_id)
            .await
        {
            tracing::info!(thread = thread_id, error = %e, "showing cached thread without bodies");
        }
        let thread = threads::get_thread(&self.db, account_id, thread_id)
            .await?
            .ok_or(MailError::NotFound)?;
        let messages = messages::get_messages_for_thread(&self.db, account_id, thread_id).await?;
        Ok(ThreadDetailDto {
            thread: thread.into(),
            messages: messages.into_iter().map(Into::into).collect(),
        })
    }

    pub async fn list_labels(&self, account_id: &str) -> Result<Vec<LabelDto>, MailError> {
        Ok(labels::get_labels(&self.db, account_id)
            .await?
            .into_iter()
            .map(|l| LabelDto {
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
            })
            .collect())
    }

    /// Unread conversations in Inbox and each category tab, across `account_ids`.
    pub async fn mailbox_counts(&self, account_ids: &[String]) -> Result<Vec<CountDto>, MailError> {
        Ok(threads::unread_counts(&self.db, account_ids)
            .await?
            .into_iter()
            .map(|(label_id, unread)| CountDto { label_id, unread })
            .collect())
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
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::{FakeGmail, FakeMsg};
    use crate::sync::MailApi;

    #[tokio::test]
    async fn list_threads_dto_matches_fixture_shape() {
        let t = DbThread {
            id: "t".into(),
            account_id: "a".into(),
            subject: Some("s".into()),
            snippet: None,
            history_id: None,
            last_message_date: Some(5),
            message_count: 2,
            unread_count: 1,
            has_attachment: 0,
            from_name: None,
            from_address: None,
            is_starred: 1,
        };
        let json = serde_json::to_value(ThreadSummaryDto::from(t)).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        // FixtureThread (src/preview/fixtures.ts) minus `mailbox` and `body`.
        assert_eq!(
            keys,
            [
                "accountId",
                "date",
                "fromAddress",
                "fromName",
                "hasAttachment",
                "id",
                "messageCount",
                "snippet",
                "starred",
                "subject",
                "unread"
            ]
        );
        assert_eq!(
            (json["unread"].as_bool(), json["starred"].as_bool()),
            (Some(true), Some(true))
        );
    }

    #[tokio::test]
    async fn modify_threads_applies_now_emits_and_reaches_gmail() {
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(FakeGmail::new());
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX", "UNREAD"]));
        let events = Arc::new(RecordingEvents::default());
        let api = fake.clone();
        let sync = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            events.clone(),
        );
        sync.sync_account("a1").await.unwrap();
        let mail = MailService::new(pool.clone(), sync.clone());
        events.take();

        mail.modify_threads("a1", &["t1".into()], &[], &["UNREAD".into()])
            .await
            .unwrap();

        let page = mail
            .list_threads(&["a1".into()], "INBOX", None, None, None)
            .await
            .unwrap();
        assert!(!page.threads[0].unread, "read in the cache immediately");
        assert!(events
            .take()
            .iter()
            .any(|e| matches!(e, SyncEvent::MessagesUpdated { .. })));
        for _ in 0..50 {
            if !fake
                .message("m1")
                .unwrap()
                .labels
                .contains(&"UNREAD".to_string())
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            fake.message("m1").unwrap().labels,
            ["INBOX"],
            "pushed in the background"
        );
        assert!(matches!(
            mail.modify_threads("a1", &[], &[], &["INBOX".into()]).await,
            Err(MailError::Invalid(_))
        ));
    }
}
