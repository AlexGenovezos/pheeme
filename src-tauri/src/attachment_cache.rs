//! Attachment bytes cached on disk under `{cache dir}/attachments/{account}/{message}/{row id}`,
//! so an attachment or inline image is downloaded from Gmail once. The cache is bounded:
//! a sweep removes files whose account or attachment row is gone, then, past the size
//! limit, the least recently opened files (they're downloaded again when next needed).

use crate::db::{accounts, attachments};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime};

/// Size limit for cached attachment bytes.
pub const MAX_BYTES: u64 = 500 * 1024 * 1024;
/// Eviction goes this far below the limit, so the next downloads don't trigger it again.
const TARGET_PERCENT: u64 = 80;
/// A half-written file (the app quit mid-download) older than this is left over.
const TMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// Marks a file still being written; see [`AttachmentCache::write`].
const TMP_MARKER: &str = ".tmp-";

#[derive(Clone)]
pub struct AttachmentCache {
    db: SqlitePool,
    dir: PathBuf,
    max_bytes: u64,
    /// Bytes written since the last sweep; a tenth of the limit starts another one.
    written: Arc<AtomicU64>,
    sweeping: Arc<tokio::sync::Mutex<()>>,
    /// One lock per file being fetched, so a preview opened while a prefetch is downloading
    /// the same attachment waits for it instead of downloading it again.
    fetching: Arc<std::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>>,
}

impl AttachmentCache {
    pub fn new(db: SqlitePool, cache_dir: &Path) -> Self {
        Self::with_limit(db, cache_dir, MAX_BYTES)
    }

    pub fn with_limit(db: SqlitePool, cache_dir: &Path, max_bytes: u64) -> Self {
        Self {
            db,
            dir: cache_dir.join("attachments"),
            max_bytes,
            written: Arc::default(),
            sweeping: Arc::default(),
            fetching: Arc::default(),
        }
    }

    /// Hold while checking for and fetching one file; see [`Self::fetching`].
    pub async fn lock(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut map = self.fetching.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|_, weak| weak.strong_count() > 0);
            match map.get(path).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    map.insert(path.to_owned(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    /// Whether the file is cached, without reading it or marking it used.
    pub async fn contains(&self, path: &Path) -> bool {
        tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
    }

    pub fn path(&self, account_id: &str, message_id: &str, row_id: &str) -> PathBuf {
        self.dir.join(account_id).join(message_id).join(row_id)
    }

    /// The cached bytes, if any. A hit marks the file as recently used.
    pub async fn read(&self, path: &Path) -> Option<Vec<u8>> {
        let bytes = tokio::fs::read(path).await.ok()?;
        let path = path.to_owned();
        let _ = tokio::task::spawn_blocking(move || touch(&path)).await;
        Some(bytes)
    }

    /// Atomic: a half-written file is never read back as the attachment.
    pub async fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut tmp_name = path.file_name().unwrap_or_default().to_owned();
        tmp_name.push(format!("{TMP_MARKER}{}", uuid::Uuid::new_v4()));
        let tmp = path.with_file_name(tmp_name);
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, path).await?;
        let len = bytes.len() as u64;
        if self.written.fetch_add(len, Ordering::Relaxed) + len >= self.max_bytes / 10 {
            let cache = self.clone();
            tokio::spawn(async move { cache.sweep().await });
        }
        Ok(())
    }

    /// Drop everything cached for an account (it was removed).
    pub async fn remove_account(&self, account_id: &str) {
        let dir = self.dir.join(account_id);
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "couldn't delete a removed account's attachments");
            }
        }
    }

    /// Delete every cached file, for all accounts; returns the bytes freed. Waits for a
    /// running sweep, and for each file's download in progress (which then goes too), so
    /// neither races it.
    pub async fn clear(&self) -> u64 {
        let _sweeping = self.sweeping.lock().await;
        self.written.store(0, Ordering::Relaxed);
        let mut freed = 0;
        for (_, account_dir) in subdirs(&self.dir).await {
            for (_, message_dir) in subdirs(&account_dir).await {
                let Ok(mut files) = tokio::fs::read_dir(&message_dir).await else {
                    continue;
                };
                while let Ok(Some(file)) = files.next_entry().await {
                    let path = file.path();
                    let name = file.file_name().to_string_lossy().into_owned();
                    // A half-written file belongs to the download of the file it's named
                    // after: wait for that, then remove what it wrote.
                    let mut paths = vec![path];
                    if let Some((cached, _)) = name.split_once(TMP_MARKER) {
                        paths.insert(0, message_dir.join(cached));
                    }
                    let _fetching = self.lock(&paths[0]).await;
                    for path in &paths {
                        let Ok(meta) = tokio::fs::symlink_metadata(path).await else {
                            continue;
                        };
                        if remove_entry(path, meta.is_dir()).await.is_ok() && meta.is_file() {
                            freed += meta.len();
                        }
                    }
                }
                let _ = tokio::fs::remove_dir(&message_dir).await;
            }
            let _ = tokio::fs::remove_dir(&account_dir).await;
        }
        if freed > 0 {
            tracing::info!(bytes = freed, "cleared the attachment cache");
        }
        freed
    }

    /// Remove files nothing refers to any more, then the least recently used ones until
    /// the cache is under its limit. A sweep already running makes this a no-op.
    pub async fn sweep(&self) {
        let Ok(_guard) = self.sweeping.try_lock() else {
            return;
        };
        self.written.store(0, Ordering::Relaxed);
        let known: HashSet<String> = match accounts::list_accounts(&self.db).await {
            Ok(accounts) => accounts.into_iter().map(|a| a.id).collect(),
            Err(e) => {
                tracing::warn!(error = %e, "couldn't sweep the attachment cache");
                return;
            }
        };
        let mut kept = Vec::new();
        let mut removed = 0usize;
        for (account_id, account_dir) in subdirs(&self.dir).await {
            if !known.contains(&account_id) {
                let _ = tokio::fs::remove_dir_all(&account_dir).await;
                removed += 1;
                continue;
            }
            for (message_id, message_dir) in subdirs(&account_dir).await {
                let Ok(mut files) = tokio::fs::read_dir(&message_dir).await else {
                    continue;
                };
                while let Ok(Some(file)) = files.next_entry().await {
                    let Ok(meta) = file.metadata().await else {
                        continue;
                    };
                    let name = file.file_name().to_string_lossy().into_owned();
                    let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    let keep = if !meta.is_file() {
                        false
                    } else if name.contains(TMP_MARKER) {
                        // Possibly a download in progress: never counted, removed once stale.
                        used.elapsed().is_ok_and(|age| age < TMP_MAX_AGE)
                    } else {
                        // A failed lookup keeps the file; the next sweep decides.
                        attachments::get_one(&self.db, &account_id, &message_id, &name)
                            .await
                            .map_or(true, |row| row.is_some())
                    };
                    if !keep {
                        removed += 1;
                        let _ = remove_entry(&file.path(), meta.is_dir()).await;
                    } else if !name.contains(TMP_MARKER) {
                        kept.push((used, meta.len(), file.path()));
                    }
                }
                // Only succeeds once the folder is empty.
                let _ = tokio::fs::remove_dir(&message_dir).await;
            }
            let _ = tokio::fs::remove_dir(&account_dir).await;
        }

        let mut total: u64 = kept.iter().map(|(_, len, _)| len).sum();
        let mut evicted = 0usize;
        if total > self.max_bytes {
            let target = self.max_bytes / 100 * TARGET_PERCENT;
            kept.sort_by_key(|(used, _, _)| *used);
            for (_, len, path) in kept {
                if total <= target {
                    break;
                }
                if tokio::fs::remove_file(&path).await.is_ok() {
                    total -= len;
                    evicted += 1;
                    if let Some(parent) = path.parent() {
                        let _ = tokio::fs::remove_dir(parent).await;
                    }
                }
            }
        }
        if removed + evicted > 0 {
            tracing::info!(
                removed,
                evicted,
                bytes = total,
                "swept the attachment cache"
            );
        }
    }
}

/// Subfolders of `dir` as (name, path); nothing when `dir` is missing.
async fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.is_ok_and(|t| t.is_dir()) {
            out.push((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ));
        }
    }
    out
}

async fn remove_entry(path: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    }
}

/// Mark a file as just used: eviction goes by modification time, which (unlike access
/// time) every platform keeps.
fn touch(path: &Path) -> std::io::Result<()> {
    std::fs::File::options()
        .write(true)
        .open(path)?
        .set_modified(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::attachments::{insert_attachment, DbAttachment};
    use crate::db::messages::{upsert_message, DbMessage};
    use crate::db::test_support::TestDb;

    /// Account `a1` with message `m1` and attachment rows `0`..`rows`.
    async fn fixture(max_bytes: u64, rows: usize) -> (TestDb, AttachmentCache) {
        let db = TestDb::with_account("a1").await;
        upsert_message(
            &db.pool,
            &DbMessage {
                id: "m1".into(),
                account_id: "a1".into(),
                thread_id: "t1".into(),
                label_ids: None,
                from_address: None,
                from_name: None,
                to_addresses: None,
                cc_addresses: None,
                subject: None,
                snippet: None,
                body_html: None,
                body_text: None,
                date: None,
                size_estimate: None,
                has_attachment: 1,
                is_read: 1,
                is_starred: 0,
                raw_headers: None,
                fully_fetched: 1,
                rfc822_message_id: None,
            },
        )
        .await
        .unwrap();
        for i in 0..rows {
            insert_attachment(
                &db.pool,
                &DbAttachment {
                    id: i.to_string(),
                    message_id: "m1".into(),
                    account_id: "a1".into(),
                    filename: None,
                    mime_type: None,
                    size: None,
                    attachment_id: None,
                    content_id: None,
                    is_inline: 0,
                },
            )
            .await
            .unwrap();
        }
        let cache =
            AttachmentCache::with_limit(db.pool.clone(), &db.dir().join("cache"), max_bytes);
        (db, cache)
    }

    fn put(path: &Path, bytes: usize, age_secs: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![0u8; bytes]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(age_secs))
            .unwrap();
    }

    #[tokio::test]
    async fn sweep_removes_what_nothing_refers_to() {
        let (_db, cache) = fixture(MAX_BYTES, 1).await;
        let live = cache.path("a1", "m1", "0");
        let gone_row = cache.path("a1", "m1", "7");
        let gone_message = cache.path("a1", "m9", "0");
        let gone_account = cache.path("a2", "m1", "0");
        let fresh_tmp = cache.path("a1", "m1", "1.tmp-x");
        let stale_tmp = cache.path("a1", "m1", "2.tmp-y");
        for path in [&live, &gone_row, &gone_message, &gone_account, &fresh_tmp] {
            put(path, 10, 0);
        }
        put(&stale_tmp, 10, 2 * 60 * 60);

        cache.sweep().await;

        assert!(live.is_file());
        assert!(fresh_tmp.is_file(), "a download may still be writing it");
        for path in [&gone_row, &gone_message, &gone_account, &stale_tmp] {
            assert!(!path.exists(), "{} should be gone", path.display());
        }
        assert!(
            !gone_message.parent().unwrap().exists(),
            "empty folders go too"
        );
        assert!(!gone_account.parent().unwrap().parent().unwrap().exists());
    }

    #[tokio::test]
    async fn sweep_evicts_least_recently_used_past_the_limit() {
        let (_db, cache) = fixture(100, 4).await;
        // 4 × 40 bytes against a 100-byte limit: evict down to 80, so two files go.
        for (row, age) in [("0", 400), ("1", 300), ("2", 200), ("3", 100)] {
            put(&cache.path("a1", "m1", row), 40, age);
        }
        // Opening the oldest makes it the most recently used.
        assert!(cache.read(&cache.path("a1", "m1", "0")).await.is_some());

        cache.sweep().await;

        let left: Vec<bool> = (0..4)
            .map(|i| cache.path("a1", "m1", &i.to_string()).is_file())
            .collect();
        assert_eq!(left, [true, false, false, true]);
    }

    #[tokio::test]
    async fn sweep_leaves_a_cache_under_the_limit_alone() {
        let (_db, cache) = fixture(100, 2).await;
        put(&cache.path("a1", "m1", "0"), 50, 500);
        put(&cache.path("a1", "m1", "1"), 50, 0);
        cache.sweep().await;
        assert!(cache.path("a1", "m1", "0").is_file());
        assert!(cache.path("a1", "m1", "1").is_file());
    }

    #[tokio::test]
    async fn clear_attachment_cache_returns_bytes() {
        let (_db, cache) = fixture(MAX_BYTES, 2).await;
        let first = cache.path("a1", "m1", "0");
        let second = cache.path("a2", "m9", "1");
        put(&first, 10, 0);
        put(&second, 20, 0);

        assert_eq!(cache.clear().await, 30);
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(!cache.dir.join("a1").exists(), "empty folders go too");
        assert_eq!(cache.clear().await, 0, "nothing left");
    }

    #[tokio::test]
    async fn clear_waits_for_a_download_of_the_same_file() {
        let (_db, cache) = fixture(MAX_BYTES, 1).await;
        let path = cache.path("a1", "m1", "0");
        put(&path, 10, 0);
        let fetching = cache.lock(&path).await;
        let clearing = tokio::spawn({
            let cache = cache.clone();
            async move { cache.clear().await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!clearing.is_finished(), "waits for the download");
        assert!(path.is_file());
        drop(fetching);
        assert_eq!(clearing.await.unwrap(), 10);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn remove_account_deletes_its_files() {
        let (_db, cache) = fixture(MAX_BYTES, 1).await;
        cache
            .write(&cache.path("a1", "m1", "0"), b"x")
            .await
            .unwrap();
        assert_eq!(
            cache.read(&cache.path("a1", "m1", "0")).await.as_deref(),
            Some(&b"x"[..])
        );
        cache.remove_account("a1").await;
        assert!(!cache.dir.join("a1").exists());
        cache.remove_account("a1").await; // already gone: fine
    }
}
