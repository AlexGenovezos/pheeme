//! Send diagnostics: a scrubbed bundle of recent logs and sync state that the user uploads to
//! the developer (or saves to a file) from Settings › About. Nothing is sent unless they ask.
//! Tauri-free; the commands in `commands/support.rs` are thin adapters.

pub mod bundle;
pub mod scrub;
pub mod upload;

use crate::accounts::AccountInfo;
use crate::db::{messages, sync_state};
use crate::diagnostics::OpenTiming;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::PathBuf;
use upload::UploadMeta;

/// Where bundles are uploaded; `PHEEME_DIAGNOSTICS_URL` overrides it (for testing).
pub const DIAGNOSTICS_URL: &str = "https://diagnostics.pheeme.email/v1/upload";

/// The Worker refuses uploads over 5 MB; stay under it.
pub const MAX_ZIP_BYTES: usize = 4_500_000;

/// The note is sent as typed, up to this many characters.
pub const MAX_NOTE_CHARS: usize = 2000;

/// Slowest recent opens listed in the notification email.
const HIGHLIGHTS: usize = 5;

pub fn diagnostics_url() -> String {
    std::env::var("PHEEME_DIAGNOSTICS_URL").unwrap_or_else(|_| DIAGNOSTICS_URL.to_owned())
}

#[derive(Debug, thiserror::Error)]
pub enum SupportError {
    #[error("Too many diagnostics were sent recently. Please try again later.")]
    RateLimited,
    #[error("The diagnostics file is too large to send.")]
    TooLarge,
    #[error("The diagnostics service didn't accept the file (error {0}).")]
    Rejected(u16),
    /// The detail is for the log; it never carries the URL.
    #[error("Couldn't reach the diagnostics service. Check your connection and try again.")]
    Network(String),
    #[error("{0}")]
    Invalid(String),
    #[error("Couldn't save the file ({0}).")]
    Save(#[from] std::io::Error),
    #[error("Couldn't put the diagnostics together ({0}).")]
    Internal(String),
}

impl SupportError {
    pub fn code(&self) -> &str {
        match self {
            SupportError::RateLimited => "rate_limited",
            SupportError::TooLarge => "too_large",
            SupportError::Rejected(_) => "rejected",
            SupportError::Network(_) => "network",
            SupportError::Invalid(_) => "invalid_input",
            SupportError::Save(_) => "save_failed",
            SupportError::Internal(_) => "internal",
        }
    }
}

impl From<anyhow::Error> for SupportError {
    fn from(e: anyhow::Error) -> Self {
        SupportError::Internal(e.to_string())
    }
}

/// One account's sync state, without its address (accounts are told apart by position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub initial_sync_done: bool,
    pub backfill_complete: bool,
    pub messages: i64,
    pub messages_with_bodies: i64,
    pub last_synced_at: Option<i64>,
}

pub async fn account_summaries(
    db: &SqlitePool,
    accounts: &[AccountInfo],
) -> Result<Vec<AccountSummary>, SupportError> {
    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let state = sync_state::get(db, &account.id).await?;
        let (messages, messages_with_bodies) = messages::body_counts(db, &account.id).await?;
        out.push(AccountSummary {
            initial_sync_done: account.synced,
            backfill_complete: state.backfill_complete,
            messages,
            messages_with_bodies,
            last_synced_at: state.last_synced_at,
        });
    }
    Ok(out)
}

/// `summary.json`, less the note and reply address (the bundle adds those).
pub fn summary(accounts: &[AccountSummary], quota_per_minute: u32, opens: &[OpenTiming]) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "accounts": accounts,
        "quotaPerMinute": quota_per_minute,
        "recentOpens": opens,
    })
}

/// The slowest recent opens, one line each, e.g.
/// `38.2 s from Gmail, 3 retries (429 rateLimitExceeded), sync busy`.
pub fn highlights(opens: &[OpenTiming]) -> Vec<String> {
    let mut slowest: Vec<&OpenTiming> = opens.iter().collect();
    slowest.sort_by_key(|t| std::cmp::Reverse(t.total_ms));
    slowest
        .into_iter()
        .take(HIGHLIGHTS)
        .map(|t| {
            let source = if t.source == "gmail" {
                "Gmail"
            } else {
                t.source
            };
            let mut line = format!("{:.1} s from {source}", t.total_ms as f64 / 1000.0);
            if t.retries > 0 {
                let plural = if t.retries == 1 { "retry" } else { "retries" };
                line.push_str(&format!(", {} {plural}", t.retries));
                let why: Vec<String> = t
                    .last_status
                    .map(|s| s.to_string())
                    .into_iter()
                    .chain(t.last_reason.clone())
                    .collect();
                if !why.is_empty() {
                    line.push_str(&format!(" ({})", why.join(" ")));
                }
            }
            if t.sync_busy {
                line.push_str(", sync busy");
            }
            if t.outcome != "ok" {
                line.push_str(&format!(", failed: {}", t.outcome));
            }
            line
        })
        .collect()
}

/// What the user typed, ready to send: the note clipped to [`MAX_NOTE_CHARS`], an empty
/// reply address dropped, and anything that isn't an address refused.
fn clean_input(
    note: &str,
    reply_to: Option<&str>,
) -> Result<(String, Option<String>), SupportError> {
    let note: String = note.trim().chars().take(MAX_NOTE_CHARS).collect();
    let reply_to = reply_to.map(str::trim).filter(|r| !r.is_empty());
    if let Some(address) = reply_to {
        // Matches what the diagnostics Worker accepts: it puts the address in a Reply-To header.
        let plausible = address.len() <= 254
            && address.is_ascii()
            && !address.chars().any(|c| c.is_whitespace() || c.is_control())
            && address.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && !domain.contains('@')
                    && domain.split('.').count() >= 2
                    && domain.split('.').all(|part| !part.is_empty())
            });
        if !plausible {
            return Err(SupportError::Invalid(
                "That doesn't look like an email address.".into(),
            ));
        }
    }
    Ok((note, reply_to.map(str::to_owned)))
}

/// Where Save writes the bundle: the path from the save dialog, as a `.zip`. The webview
/// supplies it, so it may only ever create or replace a zip.
pub fn save_path(path: &str) -> Result<PathBuf, SupportError> {
    let mut path = PathBuf::from(path);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(SupportError::Invalid(
            "Choose where to save the file.".into(),
        ));
    }
    let is_zip = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    if !is_zip {
        path.as_mut_os_string().push(".zip");
    }
    Ok(path)
}

/// Everything the bundle is built from.
pub struct Sources<'a> {
    pub db: &'a SqlitePool,
    pub accounts: &'a [AccountInfo],
    pub quota_per_minute: u32,
    pub opens: Vec<OpenTiming>,
    pub log_dir: Option<PathBuf>,
}

/// The upload's metadata and the zip. Scrubbing and zipping run off the async runtime.
pub async fn prepare(
    sources: Sources<'_>,
    note: &str,
    reply_to: Option<&str>,
) -> Result<(UploadMeta, Vec<u8>), SupportError> {
    let (note, reply_to) = clean_input(note, reply_to)?;
    let summaries = account_summaries(sources.db, sources.accounts).await?;
    let mut own_addresses: Vec<String> = sources.accounts.iter().map(|a| a.email.clone()).collect();
    own_addresses.extend(reply_to.clone());
    let meta = UploadMeta {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        reply_to: reply_to.clone(),
        note: note.clone(),
        highlights: highlights(&sources.opens),
    };
    let input = bundle::BundleInput {
        note,
        reply_to,
        summary: summary(&summaries, sources.quota_per_minute, &sources.opens),
        log_dir: sources.log_dir,
        own_addresses,
        max_bytes: MAX_ZIP_BYTES,
    };
    let zip = tokio::task::spawn_blocking(move || bundle::build(&input))
        .await
        .map_err(|e| SupportError::Internal(e.to_string()))??;
    Ok((meta, zip))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use std::io::Read;

    fn timing(total_ms: u64) -> OpenTiming {
        OpenTiming {
            at_ms: 0,
            source: "gmail",
            total_ms,
            slot_wait_ms: 0,
            quota_wait_ms: 0,
            gmail_ms: 0,
            retries: 0,
            last_status: None,
            last_reason: None,
            messages_fetched: 1,
            sync_busy: false,
            outcome: "ok".into(),
        }
    }

    #[test]
    fn highlights_list_the_slowest_opens_and_why() {
        let mut slow = timing(38_200);
        slow.retries = 3;
        slow.last_status = Some(429);
        slow.last_reason = Some("rateLimitExceeded".into());
        slow.sync_busy = true;
        let mut failed = timing(900);
        failed.source = "cache";
        failed.outcome = "network".into();
        let mut opens: Vec<_> = (0..10).map(|n| timing(n * 10)).collect();
        opens.push(failed);
        opens.push(slow);

        let lines = highlights(&opens);

        assert_eq!(lines.len(), HIGHLIGHTS);
        assert_eq!(
            lines[0],
            "38.2 s from Gmail, 3 retries (429 rateLimitExceeded), sync busy"
        );
        assert_eq!(lines[1], "0.9 s from cache, failed: network");
        assert_eq!(lines[2], "0.1 s from Gmail");
    }

    #[test]
    fn input_is_clipped_and_checked() {
        let long = "x".repeat(MAX_NOTE_CHARS + 10);
        let (note, reply_to) = clean_input(&long, Some("  ")).unwrap();
        assert_eq!(note.chars().count(), MAX_NOTE_CHARS);
        assert_eq!(reply_to, None);
        assert_eq!(
            clean_input("", Some(" me@x.com ")).unwrap().1.as_deref(),
            Some("me@x.com")
        );
        for bad in [
            "me",
            "a@b@c",
            "me@x.com\r\nBcc: y@z",
            "@x.com",
            "me@localhost",
            "me@x..com",
            "jö@x.com",
        ] {
            let e = clean_input("", Some(bad)).unwrap_err();
            assert_eq!(e.code(), "invalid_input", "{bad}");
        }
    }

    #[test]
    fn saves_only_ever_write_zips() {
        let dir = tempfile::tempdir().unwrap();
        let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        assert_eq!(
            save_path(&at("pheeme-diagnostics.zip")).unwrap(),
            dir.path().join("pheeme-diagnostics.zip")
        );
        assert_eq!(
            save_path(&at("report.ZIP")).unwrap(),
            dir.path().join("report.ZIP")
        );
        assert_eq!(
            save_path(&at(".bashrc")).unwrap(),
            dir.path().join(".bashrc.zip")
        );
        assert_eq!(
            save_path(&at("notes.txt")).unwrap(),
            dir.path().join("notes.txt.zip")
        );
        assert_eq!(
            save_path("relative.zip").unwrap_err().code(),
            "invalid_input"
        );
        assert_eq!(save_path("").unwrap_err().code(), "invalid_input");
    }

    #[tokio::test]
    async fn account_summaries_count_cached_bodies() {
        use crate::sync::fake::{FakeGmail, FakeMsg};
        use crate::sync::manager::SyncManager;
        use crate::sync::{MailApi, NoopEvents};
        use std::sync::Arc;

        let db = TestDb::with_account("a1").await;
        let fake = Arc::new(FakeGmail::new());
        fake.seed(FakeMsg::new("m1", "t1", &["INBOX"]));
        fake.seed(FakeMsg::new("m2", "t2", &["INBOX"]));
        let api = fake.clone();
        let sync = SyncManager::new(
            db.pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            Arc::new(NoopEvents),
        );
        sync.engine("a1").run_initial_sync().await.unwrap();
        sqlx::query(
            "UPDATE messages SET fully_fetched = 0, body_text = NULL, body_html = NULL WHERE id = 'm2'",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let accounts: Vec<AccountInfo> = crate::db::accounts::list_accounts(&db.pool)
            .await
            .unwrap()
            .into_iter()
            .map(Into::into)
            .collect();

        let summaries = account_summaries(&db.pool, &accounts).await.unwrap();

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].initial_sync_done);
        assert_eq!(
            (summaries[0].messages, summaries[0].messages_with_bodies),
            (2, 1)
        );
        assert!(summaries[0].last_synced_at.is_some());
    }

    #[tokio::test]
    async fn prepare_summarizes_without_addresses_and_scrubs_logs() {
        let db = TestDb::with_account("a1").await;
        let accounts: Vec<AccountInfo> = crate::db::accounts::list_accounts(&db.pool)
            .await
            .unwrap()
            .into_iter()
            .map(Into::into)
            .collect();
        let logs = tempfile::tempdir().unwrap();
        std::fs::write(
            logs.path().join("pheeme.log"),
            "signed in as me@example.com, mail from bob@x.com\n",
        )
        .unwrap();

        let (meta, zip) = prepare(
            Sources {
                db: &db.pool,
                accounts: &accounts,
                quota_per_minute: 6000,
                opens: vec![timing(1500)],
                log_dir: Some(logs.path().to_path_buf()),
            },
            " it hangs ",
            None,
        )
        .await
        .unwrap();

        assert_eq!(meta.note, "it hangs");
        assert_eq!(meta.reply_to, None);
        assert_eq!(meta.highlights, ["1.5 s from Gmail"]);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).unwrap();
        let mut text = String::new();
        archive
            .by_name("summary.json")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        let summary: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            summary["accounts"],
            json!([{"initialSyncDone": false, "backfillComplete": false, "messages": 0,
                "messagesWithBodies": 0, "lastSyncedAt": null}])
        );
        assert_eq!(summary["quotaPerMinute"], 6000);
        assert_eq!(summary["recentOpens"][0]["totalMs"], 1500);
        assert_eq!(summary["note"], "it hangs");
        assert!(!text.contains("me@example.com"), "{text}");
        let mut log = String::new();
        archive
            .by_name("logs/pheeme.log")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert_eq!(log, "signed in as me@example.com, mail from <email>\n");
    }
}
