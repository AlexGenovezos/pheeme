//! Encryption for local mail. Keys never live beside the data they protect.
use crate::secrets::Keychain;
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use rand::RngExt;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use zeroize::Zeroizing;

const KEY_ENTRY: &str = "local-storage-v1";
const MAGIC: &[u8] = b"PHEEME\0\x01";
const NONCE_BYTES: usize = 24;
pub const FILE_OVERHEAD: usize = MAGIC.len() + NONCE_BYTES + 16;

/// Independent random keys for SQLCipher and attachment encryption, zeroed on last drop.
/// Deliberately has no Debug/Serialize implementation.
#[derive(Clone)]
pub struct StorageKey(Arc<Zeroizing<[u8; 64]>>);

impl StorageKey {
    fn generate() -> Self {
        Self(Arc::new(Zeroizing::new(rand::rng().random())))
    }

    /// Raw-key SQLCipher syntax: a random 256-bit key needs no password stretching.
    pub(crate) fn database_key(&self) -> Zeroizing<String> {
        use std::fmt::Write;
        let mut hex = Zeroizing::new(String::with_capacity(67));
        hex.push_str("x'");
        for byte in &self.0[..32] {
            write!(&mut *hex, "{byte:02x}").expect("write to String");
        }
        hex.push('\'');
        hex
    }

    pub fn database_options(&self, path: &Path) -> SqliteConnectOptions {
        // Every connection to the database is opened from these options.
        crate::db::stable_query_plans();
        SqliteConnectOptions::new()
            .filename(path)
            // SQLx executes `key` before every other pragma, on every pooled connection.
            .pragma("key", format!("\"{}\"", *self.database_key()))
            .pragma("temp_store", "MEMORY")
            // Every page read from disk is decrypted and authenticated, so keep more of them
            // decrypted in memory than SQLite's 2 MB default (the hot read paths walk more).
            .pragma("cache_size", "-16384")
            // Connection setup includes the key; SQL text and bind values must not be logged.
            .disable_statement_logging()
    }

    fn seal(&self, bytes: &[u8], aad: &[u8]) -> std::io::Result<Vec<u8>> {
        let nonce: [u8; NONCE_BYTES] = rand::rng().random();
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0[32..]).expect("32-byte key");
        let encrypted = cipher
            .encrypt(&XNonce::from(nonce), Payload { msg: bytes, aad })
            .map_err(|_| invalid_file())?;
        let mut out = Vec::with_capacity(bytes.len() + FILE_OVERHEAD);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&encrypted);
        Ok(out)
    }

    fn open(&self, bytes: &[u8], aad: &[u8]) -> std::io::Result<Vec<u8>> {
        if bytes.len() < FILE_OVERHEAD || !bytes.starts_with(MAGIC) {
            return Err(invalid_file());
        }
        let nonce = XNonce::try_from(&bytes[MAGIC.len()..MAGIC.len() + NONCE_BYTES])
            .map_err(|_| invalid_file())?;
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0[32..]).expect("32-byte key");
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &bytes[MAGIC.len() + NONCE_BYTES..],
                    aad,
                },
            )
            .map_err(|_| invalid_file())
    }
}

fn invalid_file() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "Encrypted attachment is unreadable",
    )
}

#[cfg(any(test, feature = "test-support"))]
pub fn test_key() -> StorageKey {
    StorageKey(Arc::new(Zeroizing::new([0x42; 64])))
}

/// Held for the lifetime of the app. Serializes key creation and migration, and prevents
/// another Pheeme process from opening the same store while it is being converted.
pub struct UnlockedStorage {
    pub key: StorageKey,
    _lock: std::fs::File,
}

pub fn unlock(data_dir: &Path, keychain: &dyn Keychain) -> Result<UnlockedStorage> {
    private_dir(data_dir)?;
    let lock = private_file(&data_dir.join("storage.lock"), false)?;
    lock.try_lock().context(
        "Pheeme is already using this data folder. Close the other instance and try again.",
    )?;
    let key = load_key(data_dir, keychain)?;
    let mut marker = private_file(&data_dir.join("storage-v1"), false)?;
    marker.write_all(b"Key in OS keychain: local-storage-v1\n")?;
    marker.sync_all()?;
    sync_dir(data_dir)?;
    Ok(UnlockedStorage { key, _lock: lock })
}

/// The keychain answered, but the key that encrypted the local data is missing or damaged.
/// Startup offers to set that data aside (`set_aside`) and download mail again from Gmail.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct KeyLost(&'static str);

const KEY_DAMAGED: KeyLost =
    KeyLost("The local mail encryption key is damaged; the existing data has been left untouched.");

fn load_key(data_dir: &Path, keychain: &dyn Keychain) -> Result<StorageKey> {
    let saved = keychain.read(KEY_ENTRY).context(
        "Couldn't unlock local mail encryption. Unlock your system keychain and restart Pheeme.",
    )?;
    if let Some(saved) = saved {
        let saved = Zeroizing::new(saved);
        let bytes = Zeroizing::new(STANDARD.decode(&*saved).map_err(|_| KEY_DAMAGED)?);
        let key: [u8; 64] = bytes.as_slice().try_into().map_err(|_| KEY_DAMAGED)?;
        return Ok(StorageKey(Arc::new(Zeroizing::new(key))));
    }
    // Never replace a lost key. In particular, don't turn a keychain reset into data loss.
    let db = data_dir.join("db.sqlite");
    if data_dir.join("storage-v1").exists()
        || (db.exists() && !is_plaintext_database(&db)?)
        || data_dir.join("db.sqlite.encrypted").exists()
    {
        return Err(KeyLost("The key for your encrypted local mail is missing from the system keychain. Restore the original keychain; the existing data has been left untouched.").into());
    }
    let key = StorageKey::generate();
    let encoded = Zeroizing::new(STANDARD.encode(&key.0[..]));
    keychain.write(KEY_ENTRY, &encoded).context("Couldn't save the local mail encryption key to your system keychain; no mail has been changed.")?;
    let verified = Zeroizing::new(
        keychain
            .read(KEY_ENTRY)?
            .context("The keychain did not retain the local mail encryption key")?,
    );
    if *verified != *encoded {
        bail!(
            "The keychain did not retain the local mail encryption key; no mail has been changed."
        );
    }
    Ok(key)
}

/// After `KeyLost`, at the user's request: move everything the lost key encrypted into
/// `unreadable-<time>` folders (the database in the data folder, staged draft attachments in
/// the cache folder) and forget the key, so the next start makes a new one and downloads mail
/// again. Only the attachment cache, which Gmail still has, is deleted. `storage-v1` moves
/// last: if anything before it fails, the next start still refuses to make a new key.
pub fn set_aside(data_dir: &Path, cache_dir: &Path, keychain: &dyn Keychain) -> Result<PathBuf> {
    let lock = private_file(&data_dir.join("storage.lock"), false)?;
    lock.try_lock().context(
        "Pheeme is already using this data folder. Close the other instance and try again.",
    )?;
    let folder = format!("unreadable-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let move_aside = |dir: &Path, name: &str| -> Result<()> {
        let aside = dir.join(&folder);
        private_dir(&aside)?;
        match std::fs::rename(dir.join(name), aside.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("Couldn't move {name} aside"))
            }
            _ => Ok(()),
        }
    };
    for name in [
        "db.sqlite",
        "db.sqlite-wal",
        "db.sqlite-shm",
        "db.sqlite-journal",
        "db.sqlite.encrypted",
        "db.sqlite.encrypted-wal",
        "db.sqlite.encrypted-shm",
        "db.sqlite.encrypted-journal",
    ] {
        move_aside(data_dir, name)?;
    }
    move_aside(cache_dir, "compose-v1")?;
    match std::fs::remove_dir_all(cache_dir.join("attachments-v1")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    // A damaged key would otherwise fail the same way on every start.
    keychain
        .delete(KEY_ENTRY)
        .context("Couldn't remove the damaged key from your system keychain")?;
    move_aside(data_dir, "storage-v1")?;
    sync_dir(data_dir)?;
    Ok(data_dir.join(folder))
}

pub(crate) fn is_plaintext_database(path: &Path) -> Result<bool> {
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() == 0 {
        return Ok(true);
    }
    let mut header = [0; 16];
    file.read_exact(&mut header)
        .context("The local mail database header is incomplete")?;
    Ok(&header == b"SQLite format 3\0")
}

/// On Unix, restrict both existing and new private directories/files to this user.
/// Windows uses the user's app-data ACL inherited from the parent directory.
pub(crate) fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path, exclusive: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).read(true).truncate(false);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub(crate) fn sync_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

/// Versioned, authenticated files. Binding the ciphertext to its relative path and purpose
/// prevents a file copied from another message or from compose from decrypting here.
#[derive(Clone)]
pub struct EncryptedFiles {
    root: PathBuf,
    purpose: &'static str,
    key: StorageKey,
    /// Flush each write to disk. Only for files that can't be fetched again: a torn cache
    /// file fails authentication and is downloaded again.
    durable: bool,
}

impl EncryptedFiles {
    pub fn attachments(cache_dir: &Path, key: StorageKey) -> Self {
        Self {
            root: cache_dir.join("attachments-v1"),
            purpose: "attachments-v1",
            key,
            durable: false,
        }
    }

    pub fn compose(cache_dir: &Path, key: StorageKey) -> Self {
        Self {
            root: cache_dir.join("compose-v1"),
            purpose: "compose-v1",
            key,
            durable: true,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn aad(&self, path: &Path) -> std::io::Result<Vec<u8>> {
        let relative = path.strip_prefix(&self.root).map_err(|_| invalid_file())?;
        let mut aad = self.purpose.as_bytes().to_vec();
        for part in relative.components() {
            let Component::Normal(part) = part else {
                return Err(invalid_file());
            };
            aad.push(b'/');
            aad.extend_from_slice(part.to_str().ok_or_else(invalid_file)?.as_bytes());
        }
        Ok(aad)
    }

    /// Decrypting (attachments run to tens of MB) happens on a blocking thread, off the async
    /// workers, as does encrypting in [`Self::write`].
    pub async fn read(&self, path: &Path) -> std::io::Result<Vec<u8>> {
        let aad = self.aad(path)?;
        let sealed = tokio::fs::read(path).await?;
        let key = self.key.clone();
        tokio::task::spawn_blocking(move || key.open(&sealed, &aad))
            .await
            .map_err(std::io::Error::other)?
    }

    pub async fn write(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let aad = self.aad(path)?;
        let key = self.key.clone();
        let bytes = bytes.to_vec();
        let path = path.to_path_buf();
        let durable = self.durable;
        tokio::task::spawn_blocking(move || {
            let encrypted = key.seal(&bytes, &aad)?;
            drop(bytes);
            let parent = path.parent().ok_or_else(invalid_file)?;
            private_dir(parent)?;
            let mut name = path.file_name().ok_or_else(invalid_file)?.to_os_string();
            name.push(format!(".tmp-{}", uuid::Uuid::new_v4()));
            let tmp = path.with_file_name(name);
            // No plaintext temporary file, even if writing or renaming fails.
            let result = (|| {
                let mut file = private_file(&tmp, true)?;
                file.write_all(&encrypted)?;
                if durable {
                    file.sync_all()?;
                }
                drop(file);
                std::fs::rename(&tmp, &path)?;
                if durable {
                    sync_dir(parent)?;
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
            result
        })
        .await
        .map_err(std::io::Error::other)?
    }

    /// Legacy paths are always plaintext, even if their content resembles our header.
    /// Separate namespaces make interruption/retry unambiguous. Delete each original only
    /// after its encrypted replacement is written (and synced, for staged draft attachments,
    /// which are never discarded; a lost cached attachment is downloaded again).
    async fn migrate(&self, legacy: &Path) -> Result<()> {
        if !legacy.exists() {
            return Ok(());
        }
        let mut pending = vec![legacy.to_path_buf()];
        let mut dirs = Vec::new();
        while let Some(path) = pending.pop() {
            let meta = tokio::fs::symlink_metadata(&path).await?;
            if meta.is_dir() {
                let mut entries = tokio::fs::read_dir(&path).await?;
                while let Some(entry) = entries.next_entry().await? {
                    pending.push(entry.path());
                }
                dirs.push(path);
            } else if meta.is_file() {
                let bytes = Zeroizing::new(tokio::fs::read(&path).await?);
                self.write(&self.root.join(path.strip_prefix(legacy)?), &bytes)
                    .await?;
                tokio::fs::remove_file(&path).await?;
                sync_dir(path.parent().context("Legacy file has no parent")?)?;
            } else {
                bail!("Unexpected link or special file in the old mail cache; migration stopped without following it.");
            }
        }
        for dir in dirs.into_iter().rev() {
            tokio::fs::remove_dir(&dir).await?;
        }
        Ok(())
    }
}

pub async fn migrate_files(cache_dir: &Path, key: &StorageKey) -> Result<()> {
    private_dir(cache_dir)?;
    EncryptedFiles::attachments(cache_dir, key.clone())
        .migrate(&cache_dir.join("attachments"))
        .await
        .context("Couldn't encrypt the existing attachment cache")?;
    EncryptedFiles::compose(cache_dir, key.clone())
        .migrate(&cache_dir.join("compose"))
        .await
        .context("Couldn't encrypt existing draft attachments")?;
    clear_opened(cache_dir)?;
    Ok(())
}

pub(crate) fn clear_opened(cache_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(cache_dir.join("opened")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    #[derive(Default)]
    struct KeychainFixture {
        value: Mutex<Option<String>>,
        locked: AtomicBool,
        discard_writes: AtomicBool,
    }

    impl Keychain for KeychainFixture {
        fn read(&self, name: &str) -> keyring::Result<Option<String>> {
            assert_eq!(name, KEY_ENTRY);
            if self.locked.load(Ordering::Relaxed) {
                return Err(keyring::Error::NoStorageAccess(Box::new(
                    std::io::Error::other("locked"),
                )));
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, name: &str, value: &str) -> keyring::Result<()> {
            assert_eq!(name, KEY_ENTRY);
            if !self.discard_writes.load(Ordering::Relaxed) {
                *self.value.lock().unwrap() = Some(value.to_owned());
            }
            Ok(())
        }
        fn delete(&self, name: &str) -> keyring::Result<()> {
            assert_eq!(name, KEY_ENTRY);
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn key_survives_restart_and_only_one_instance_can_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = KeychainFixture::default();
        let first = unlock(dir.path(), &keychain).unwrap();
        let encrypted = first.key.seal(b"private", b"test").unwrap();
        assert!(unlock(dir.path(), &keychain).is_err());
        drop(first);
        let second = unlock(dir.path(), &keychain).unwrap();
        assert_eq!(second.key.open(&encrypted, b"test").unwrap(), b"private");
        assert!(!dir.path().join(KEY_ENTRY).exists());
    }

    #[test]
    fn locked_missing_corrupt_and_unretained_keys_never_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = KeychainFixture::default();
        keychain.locked.store(true, Ordering::Relaxed);
        assert!(unlock(dir.path(), &keychain).is_err());
        assert!(!dir.path().join("storage-v1").exists());
        keychain.locked.store(false, Ordering::Relaxed);
        keychain.discard_writes.store(true, Ordering::Relaxed);
        assert!(unlock(dir.path(), &keychain).is_err());
        keychain.discard_writes.store(false, Ordering::Relaxed);
        drop(unlock(dir.path(), &keychain).unwrap());
        *keychain.value.lock().unwrap() = None;
        assert!(
            unlock(dir.path(), &keychain).is_err(),
            "never recreate a lost key even before the database is made"
        );
        *keychain.value.lock().unwrap() = Some("bad key".into());
        assert!(unlock(dir.path(), &keychain).is_err());
        assert_eq!(keychain.value.lock().unwrap().as_deref(), Some("bad key"));
    }

    #[test]
    fn encrypted_database_without_marker_also_prevents_key_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let original = [0x91; 128];
        std::fs::write(dir.path().join("db.sqlite"), original).unwrap();
        let keychain = KeychainFixture::default();
        assert!(unlock(dir.path(), &keychain).is_err());
        assert!(keychain.value.lock().unwrap().is_none());
        assert_eq!(
            std::fs::read(dir.path().join("db.sqlite")).unwrap(),
            original
        );
    }

    #[test]
    fn a_lost_key_can_start_again_with_the_old_data_set_aside() {
        let data = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let keychain = KeychainFixture::default();
        drop(unlock(data.path(), &keychain).unwrap());
        std::fs::write(data.path().join("db.sqlite"), [0x91; 128]).unwrap();
        std::fs::write(data.path().join("db.sqlite-wal"), b"wal").unwrap();
        private_dir(&cache.path().join("compose-v1")).unwrap();
        std::fs::write(cache.path().join("compose-v1/draft"), b"sealed").unwrap();
        private_dir(&cache.path().join("attachments-v1/a")).unwrap();
        *keychain.value.lock().unwrap() = None;
        let lost = unlock(data.path(), &keychain).err().unwrap();
        assert!(lost.downcast_ref::<KeyLost>().is_some());
        *keychain.value.lock().unwrap() = Some("bad key".into());
        let damaged = unlock(data.path(), &keychain).err().unwrap();
        assert!(damaged.downcast_ref::<KeyLost>().is_some());

        let aside = set_aside(data.path(), cache.path(), &keychain).unwrap();
        assert_eq!(std::fs::read(aside.join("db.sqlite")).unwrap(), [0x91; 128]);
        assert_eq!(std::fs::read(aside.join("db.sqlite-wal")).unwrap(), b"wal");
        assert!(aside.join("storage-v1").exists());
        let folder = aside.file_name().unwrap();
        let drafts = cache.path().join(folder).join("compose-v1/draft");
        assert_eq!(std::fs::read(drafts).unwrap(), b"sealed");
        assert!(!cache.path().join("attachments-v1").exists());
        // The damaged key is gone, so this start makes a new one.
        drop(unlock(data.path(), &keychain).unwrap());
        let new_key = keychain.value.lock().unwrap().clone().unwrap();
        assert_ne!(new_key, "bad key");
    }

    #[test]
    fn a_locked_keychain_is_not_a_lost_key() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = KeychainFixture::default();
        keychain.locked.store(true, Ordering::Relaxed);
        let error = unlock(dir.path(), &keychain).err().unwrap();
        assert!(error.downcast_ref::<KeyLost>().is_none());
    }

    #[tokio::test]
    async fn files_reject_tampering_wrong_keys_swaps_truncation_and_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let files = EncryptedFiles::attachments(dir.path(), test_key());
        let path = files.root().join("account/message/part");
        files.write(&path, b"a sensitive attachment").await.unwrap();
        let encrypted = tokio::fs::read(&path).await.unwrap();
        assert!(!encrypted.windows(10).any(|s| s == b"sensitive "));
        assert_eq!(files.read(&path).await.unwrap(), b"a sensitive attachment");
        files.write(&path, b"a sensitive attachment").await.unwrap();
        assert_ne!(
            tokio::fs::read(&path).await.unwrap(),
            encrypted,
            "fresh nonce on every write"
        );
        let wrong = EncryptedFiles::attachments(dir.path(), StorageKey::generate());
        assert!(wrong.read(&path).await.is_err());
        let swapped = files.root().join("account/message/other");
        tokio::fs::write(&swapped, &encrypted).await.unwrap();
        assert!(files.read(&swapped).await.is_err());
        let compose = EncryptedFiles::compose(dir.path(), test_key());
        private_dir(compose.root()).unwrap();
        let composed = compose.root().join("part");
        tokio::fs::write(&composed, &encrypted).await.unwrap();
        assert!(compose.read(&composed).await.is_err());
        for index in [0, MAGIC.len(), encrypted.len() - 1] {
            let mut damaged = encrypted.clone();
            damaged[index] ^= 1;
            tokio::fs::write(&path, damaged).await.unwrap();
            assert!(files.read(&path).await.is_err());
        }
        for bad in [&encrypted[..encrypted.len() - 1], &b"plaintext"[..], &[]] {
            tokio::fs::write(&path, bad).await.unwrap();
            assert!(files.read(&path).await.is_err());
        }
        assert!(files
            .write(&dir.path().join("outside"), b"x")
            .await
            .is_err());
        assert!(files
            .write(&files.root().join("../outside"), b"x")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn legacy_migration_preserves_attachments_and_resumes_without_plaintext_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("attachments/a/m/p");
        private_dir(legacy.parent().unwrap()).unwrap();
        // Attacker-controlled attachment bytes may even resemble an encrypted header.
        let bytes = [MAGIC, b"ordinary mail attachment"].concat();
        tokio::fs::write(&legacy, &bytes).await.unwrap();
        let files = EncryptedFiles::attachments(dir.path(), test_key());
        let target = files.root().join("a/m/p");
        files
            .write(&target, b"previous interrupted attempt")
            .await
            .unwrap();
        let compose_path = dir.path().join("compose/draft-id");
        private_dir(compose_path.parent().unwrap()).unwrap();
        tokio::fs::write(&compose_path, b"unsent attachment")
            .await
            .unwrap();
        private_dir(&dir.path().join("opened/id")).unwrap();
        tokio::fs::write(dir.path().join("opened/id/file.pdf"), b"opened copy")
            .await
            .unwrap();
        migrate_files(dir.path(), &test_key()).await.unwrap();
        assert_eq!(files.read(&target).await.unwrap(), bytes);
        let compose = EncryptedFiles::compose(dir.path(), test_key());
        assert_eq!(
            compose
                .read(&compose.root().join("draft-id"))
                .await
                .unwrap(),
            b"unsent attachment"
        );
        for old in ["attachments", "compose", "opened"] {
            assert!(!dir.path().join(old).exists());
        }
        migrate_files(dir.path(), &test_key()).await.unwrap();
        assert_eq!(files.read(&target).await.unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn migration_does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"keep me").unwrap();
        private_dir(&dir.path().join("compose")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("compose/link")).unwrap();
        assert!(migrate_files(dir.path(), &test_key()).await.is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"keep me");
    }
}
