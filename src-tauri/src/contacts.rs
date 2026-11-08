//! Recipient suggestions for compose's To, Cc and Bcc. Everything is answered from the local
//! cache, so typing never waits on the network: addresses from synced mail (the `contacts`
//! table, kept by a trigger) and, when the account allows it, Google Contacts, downloaded in
//! the background through the People API. Tauri-free; commands are thin adapters.

use crate::db::{self, contacts::ContactRow};
use crate::gmail::people::{ContactList, PeoplePage};
use crate::gmail::{GmailClient, GmailError};
use crate::mail::MailError;
use crate::sync::engine::now_ms;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Suggestions shown at once.
pub const DEFAULT_LIMIT: usize = 8;
/// How long an account's loaded contacts answer suggestions before they're read again, so a
/// burst of keystrokes reads the table once and mail synced meanwhile shows up soon after.
const CACHE_TTL: Duration = Duration::from_secs(30);
/// How often Google Contacts are downloaded again while the app runs.
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// The first download waits for launch and the first sync to settle.
const FIRST_REFRESH_DELAY: Duration = Duration::from_secs(30);
/// Pages of 1,000 per list, so a broken page token can't loop forever.
const MAX_PAGES: usize = 200;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// The People API turned on in the user's Google Cloud project.
pub const PEOPLE_API_URL: &str =
    "https://console.cloud.google.com/apis/library/people.googleapis.com";

#[async_trait::async_trait]
pub trait PeopleApi: Send + Sync {
    async fn list_people(
        &self,
        list: ContactList,
        page_token: Option<&str>,
    ) -> Result<PeoplePage, GmailError>;
}

#[async_trait::async_trait]
impl PeopleApi for GmailClient {
    async fn list_people(
        &self,
        list: ContactList,
        page_token: Option<&str>,
    ) -> Result<PeoplePage, GmailError> {
        GmailClient::list_people(self, list, page_token).await
    }
}

/// Builds the account's People API client.
pub type PeopleFactory = Arc<dyn Fn(&str) -> Arc<dyn PeopleApi> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionDto {
    pub name: Option<String>,
    pub address: String,
}

/// Where the account's Google Contacts stand, for Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleContactsDto {
    /// `unknown` (never checked), `on`, `missing_scope` (sign in again and allow contacts),
    /// `api_disabled` (turn on the People API) or `error`.
    pub status: String,
    /// What failed, for `error`.
    pub message: Option<String>,
    /// The People API page for the user's project, for `api_disabled`.
    pub enable_url: Option<String>,
    /// Addresses downloaded from Google Contacts.
    pub count: i64,
    /// The last download that worked (ms since the epoch).
    pub synced_at: Option<i64>,
}

/// One address, ready to match: lowercased words of its name and address.
struct Candidate {
    row: ContactRow,
    address: String,
    words: Vec<String>,
}

struct Loaded {
    at: Instant,
    candidates: Arc<Vec<Candidate>>,
}

pub struct ContactService {
    db: SqlitePool,
    people_for: PeopleFactory,
    loaded: Mutex<HashMap<String, Loaded>>,
    /// One download per account at a time.
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ContactService {
    pub fn new(db: SqlitePool, people_for: PeopleFactory) -> Arc<Self> {
        Arc::new(Self {
            db,
            people_for,
            loaded: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashMap::new()),
        })
    }

    /// Up to `limit` addresses matching `query`, best first. Every word of the query must
    /// start a word of the name or address ("ada lov", "lovelace", "x.com"), or the query
    /// must start the address. The account's own address isn't suggested.
    pub async fn suggest(
        &self,
        account_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SuggestionDto>, MailError> {
        let query = query.trim().trim_matches(['"', '<', '>']).to_lowercase();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let candidates = self.candidates(account_id).await?;
        let words: Vec<&str> = query.split_whitespace().collect();
        let now = now_ms();
        let mut hits: Vec<(f64, &Candidate)> = candidates
            .iter()
            .filter(|c| matches(c, &query, &words))
            .map(|c| (score(&c.row, now), c))
            .collect();
        hits.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1.address.cmp(&b.1.address))
        });
        Ok(hits
            .into_iter()
            .take(limit)
            .map(|(_, c)| SuggestionDto {
                name: c.row.name.clone(),
                address: c.row.address.clone(),
            })
            .collect())
    }

    async fn candidates(&self, account_id: &str) -> Result<Arc<Vec<Candidate>>, MailError> {
        if let Some(l) = lock(&self.loaded).get(account_id) {
            if l.at.elapsed() < CACHE_TTL {
                return Ok(l.candidates.clone());
            }
        }
        let own = db::accounts::get_account(&self.db, account_id)
            .await?
            .map(|a| a.email.to_lowercase());
        let candidates: Arc<Vec<Candidate>> = Arc::new(
            db::contacts::all(&self.db, account_id)
                .await?
                .into_iter()
                .filter(|r| Some(&r.address) != own.as_ref() && worth_suggesting(r))
                .map(candidate)
                .collect(),
        );
        let mut loaded = lock(&self.loaded);
        loaded.retain(|_, l| l.at.elapsed() < CACHE_TTL);
        loaded.insert(
            account_id.to_owned(),
            Loaded {
                at: Instant::now(),
                candidates: candidates.clone(),
            },
        );
        Ok(candidates)
    }

    /// Drop an account's loaded contacts (it was removed, or its Google Contacts changed).
    pub fn forget(&self, account_id: &str) {
        lock(&self.loaded).remove(account_id);
    }

    pub async fn google_status(&self, account_id: &str) -> Result<GoogleContactsDto, MailError> {
        let sync = db::contacts::google_sync(&self.db, account_id).await?;
        let count = db::contacts::google_count(&self.db, account_id).await?;
        let Some(sync) = sync else {
            return Ok(GoogleContactsDto {
                status: "unknown".into(),
                message: None,
                enable_url: None,
                count,
                synced_at: None,
            });
        };
        let enable_url = (sync.status == "api_disabled").then(|| match &sync.detail {
            Some(project) => format!("{PEOPLE_API_URL}?project={project}"),
            None => PEOPLE_API_URL.to_owned(),
        });
        let message = (sync.status == "error").then_some(sync.detail).flatten();
        Ok(GoogleContactsDto {
            status: sync.status,
            message,
            enable_url,
            count,
            synced_at: sync.synced_at,
        })
    }

    /// Download the account's Google Contacts and Other contacts, replacing the copies, and
    /// record how it went. A list Google refuses keeps its previous copy. A failure that may
    /// pass by itself (offline, rate limit, Google having trouble) doesn't change the status
    /// once there is one.
    pub async fn refresh_google(&self, account_id: &str) -> Result<GoogleContactsDto, MailError> {
        let guard = lock(&self.refreshing)
            .entry(account_id.to_owned())
            .or_default()
            .clone();
        let _one_at_a_time = guard.lock().await;
        if db::accounts::get_account(&self.db, account_id)
            .await?
            .is_none()
        {
            return Err(MailError::Invalid(
                "That account isn't connected any more.".into(),
            ));
        }
        let api = (self.people_for)(account_id);
        let saved = download(api.as_ref(), ContactList::Saved).await;
        let other = download(api.as_ref(), ContactList::Other).await;

        let mut tx = db::begin_write(&self.db).await?;
        for (list, result) in [(true, &saved), (false, &other)] {
            if let Ok(people) = result {
                db::contacts::replace_google(&mut tx, account_id, list, people).await?;
            }
        }
        let error = saved.as_ref().err().or(other.as_ref().err());
        let previous = db::contacts::google_sync(&mut *tx, account_id).await?;
        let now = now_ms();
        match error {
            None => {
                db::contacts::set_google_sync(&mut *tx, account_id, "on", None, now, true).await?
            }
            Some(e) if is_transient(e) && previous.is_some() => {
                warn!(error = %e, "couldn't download Google Contacts; keeping the last copy");
            }
            Some(e) => {
                let (status, detail) = if e.is_api_disabled() {
                    ("api_disabled", e.disabled_api_project())
                } else if e.is_missing_scope() {
                    ("missing_scope", None)
                } else {
                    ("error", Some(e.to_string()))
                };
                warn!(status, error = %e, "couldn't download Google Contacts");
                db::contacts::set_google_sync(
                    &mut *tx,
                    account_id,
                    status,
                    detail.as_deref(),
                    now,
                    false,
                )
                .await?;
            }
        }
        tx.commit().await.map_err(anyhow::Error::from)?;
        if let (Ok(s), Ok(o)) = (&saved, &other) {
            info!(
                saved = s.len(),
                other = o.len(),
                "Google Contacts downloaded"
            );
        }
        self.forget(account_id);
        self.google_status(account_id).await
    }

    /// Download every account's Google Contacts soon after launch, then every few hours.
    pub async fn run(self: Arc<Self>) {
        tokio::time::sleep(FIRST_REFRESH_DELAY).await;
        loop {
            match db::accounts::list_accounts(&self.db).await {
                Ok(accounts) => {
                    for account in accounts {
                        if let Err(e) = self.refresh_google(&account.id).await {
                            warn!(error = %e, "Google Contacts refresh failed");
                        }
                    }
                }
                Err(e) => warn!(error = %e, "couldn't list accounts for Google Contacts"),
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    }
}

/// Every person in `list` as (lowercased address, name), one row per address.
async fn download(
    api: &dyn PeopleApi,
    list: ContactList,
) -> Result<Vec<(String, Option<String>)>, GmailError> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = api.list_people(list, token.as_deref()).await?;
        for person in page.people {
            for address in person.addresses {
                let address = address.to_lowercase();
                if address.contains('@') {
                    out.push((address, person.name.clone()));
                }
            }
        }
        token = page.next_page_token;
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/// A failure that may pass by itself.
fn is_transient(e: &GmailError) -> bool {
    match e {
        GmailError::Network(_)
        | GmailError::Offline(_)
        | GmailError::RateLimit { .. }
        | GmailError::Auth(_)
        | GmailError::SignedOut(_) => true,
        GmailError::Api { status, .. } => *status >= 500,
        GmailError::Decode(_) => false,
    }
}

/// Automated senders nobody writes to, unless the user has.
fn worth_suggesting(r: &ContactRow) -> bool {
    if r.sent_count > 0 || r.saved {
        return true;
    }
    let local = r.address.split('@').next().unwrap_or_default();
    let squashed: String = local.chars().filter(|c| c.is_alphanumeric()).collect();
    ![
        "noreply",
        "donotreply",
        "mailerdaemon",
        "postmaster",
        "bounce",
    ]
    .iter()
    .any(|robot| squashed.contains(robot))
}

fn candidate(row: ContactRow) -> Candidate {
    let address = row.address.to_lowercase();
    let mut words: Vec<String> = Vec::new();
    if let Some(name) = &row.name {
        let name = name.to_lowercase();
        words.extend(name.split_whitespace().map(str::to_owned));
        words.extend(split_words(&name));
    }
    if let Some((local, domain)) = address.split_once('@') {
        words.push(local.to_owned());
        words.push(domain.to_owned());
        words.extend(split_words(local));
        words.extend(split_words(domain));
    }
    words.sort();
    words.dedup();
    Candidate {
        row,
        address,
        words,
    }
}

fn split_words(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
}

fn matches(c: &Candidate, query: &str, words: &[&str]) -> bool {
    c.address.starts_with(query)
        || words
            .iter()
            .all(|q| c.words.iter().any(|w| w.starts_with(q)))
}

/// Higher for people the user writes to, then for saved contacts and people they hear
/// from, fading with time since the last message either way.
fn score(r: &ContactRow, now: i64) -> f64 {
    let affinity = 10.0 * r.sent_count as f64
        + 2.0 * (r.received_count as f64).sqrt()
        + if r.saved { 8.0 } else { 0.0 }
        + if r.other { 4.0 } else { 0.0 };
    let last = r.last_sent.max(r.last_received);
    let recency = if last <= 0 {
        0.1
    } else {
        let age_days = (now - last).max(0) as f64 / DAY_MS;
        (1.0 / (1.0 + age_days / 180.0)).max(0.1)
    };
    affinity * recency
}

#[cfg(test)]
mod tests;
