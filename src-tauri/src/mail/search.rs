//! Search: local search over cached mail, Gmail's own search, recent searches, and the
//! label changes that apply to every match of a search.

use super::dto::{summaries, ThreadCursorDto, ThreadSummaryDto};
use super::{MailError, MailService, DEFAULT_PAGE, MAX_PAGE};
use crate::db::labels;
use crate::db::search::{self as search_db, ThreadSearch, LABEL_KEY_SEP};
use crate::db::threads::{self, ThreadCursor};
use crate::search;
use crate::sync::engine::now_ms;
use crate::sync::outbox;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub threads: Vec<ThreadSummaryDto>,
    pub next: Option<ThreadCursorDto>,
    /// False when the query uses syntax only Gmail understands: local search found
    /// nothing because it didn't run, and the Gmail results are the whole answer.
    pub local: bool,
}

/// A label change for every match of a search ([`MailService::modify_search`]).
pub struct SearchChange<'a> {
    pub add: &'a [&'a str],
    pub remove: &'a [&'a str],
    /// Added to the Gmail search so it only finds messages the change does something to
    /// (`is:unread` to mark read).
    pub narrow: &'a str,
    /// The cached conversations to change now (the unread ones, to mark read).
    pub keep: fn(&ThreadSummaryDto) -> bool,
}

impl Default for SearchChange<'_> {
    fn default() -> Self {
        Self {
            add: &[],
            remove: &[],
            narrow: "",
            keep: |_| true,
        }
    }
}

/// What [`MailService::modify_search`] changed (or, in a dry run, would change).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchChangeDto {
    /// Cached conversations changed now.
    pub cached: usize,
    /// False when the search uses syntax only Gmail understands: nothing cached was counted,
    /// and Gmail's change is the whole of it.
    pub local: bool,
    /// The search Gmail runs to change mail not downloaded yet.
    pub gmail_query: String,
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

impl MailService {
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
        for account_id in account_ids {
            self.modify_search(
                account_id,
                query,
                &SearchChange {
                    remove: &["UNREAD"],
                    narrow: "is:unread",
                    keep: |t| t.unread,
                    ..Default::default()
                },
                false,
            )
            .await?;
        }
        Ok(())
    }

    /// Change every match of a search (`query`, the search bar's syntax) in `account_id`:
    /// the cached matches `change.keep` selects change now, and on Gmail every message
    /// `({query}) {change.narrow}` finds, downloaded or not. `dry_run` only counts them.
    pub async fn modify_search(
        &self,
        account_id: &str,
        query: &str,
        change: &SearchChange<'_>,
        dry_run: bool,
    ) -> Result<SearchChangeDto, MailError> {
        let query = query.trim();
        if query.is_empty() || (change.add.is_empty() && change.remove.is_empty()) {
            return Err(MailError::Invalid("Nothing to change.".into()));
        }
        let account = [account_id.to_owned()];
        let mut thread_ids = Vec::new();
        let mut local = true;
        let mut before = None;
        loop {
            let page = self
                .search_messages(&account, query, before, Some(MAX_PAGE))
                .await?;
            local &= page.local;
            thread_ids.extend(
                page.threads
                    .into_iter()
                    .filter(|t| (change.keep)(t))
                    .map(|t| t.id),
            );
            match page.next {
                Some(next) => before = Some(next),
                None => break,
            }
        }
        let (gmail, _) = search::gmail_query(query);
        let sweep = format!("({gmail}) {}", change.narrow).trim_end().to_owned();
        if !dry_run {
            let labels = |ids: &[&str]| ids.iter().map(|l| l.to_string()).collect::<Vec<_>>();
            let queued = outbox::enqueue_sweep(
                &self.db,
                account_id,
                &thread_ids,
                &labels(change.add),
                &labels(change.remove),
                &sweep,
            )
            .await?;
            self.after_change(account_id, queued);
        }
        Ok(SearchChangeDto {
            cached: thread_ids.len(),
            local,
            gmail_query: sweep,
        })
    }

    /// Every conversation Gmail's search finds, downloaded or not, page by page (caching what it
    /// finds).
    pub async fn every_match(
        &self,
        account_id: &str,
        query: &str,
    ) -> Result<Vec<String>, MailError> {
        let account = [account_id.to_owned()];
        let mut ids = Vec::new();
        let mut tokens = None;
        loop {
            let page = self.search_gmail(&account, query, tokens).await?;
            if !page.failed.is_empty() {
                return Err(MailError::Invalid(
                    "Gmail's search didn't answer, so nothing was changed. Try again.".into(),
                ));
            }
            for t in page.threads {
                if !ids.contains(&t.id) {
                    ids.push(t.id);
                }
            }
            if page.next.is_empty() {
                return Ok(ids);
            }
            tokens = Some(page.next);
        }
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
        let cursor = before.map(ThreadCursor::from);
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
            next: page.next.map(ThreadCursorDto::from),
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
}
