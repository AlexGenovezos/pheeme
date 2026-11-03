use crate::identity::KEYCHAIN_SERVICE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSecrets {
    pub client_secret: String,
    pub refresh_token: String,
}

impl std::fmt::Debug for AccountSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "AccountSecrets { client_secret: \"<redacted>\", refresh_token: \"<redacted>\" }",
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("{}", unavailable_message(.0))]
    Unavailable(#[source] keyring::Error),
    /// The keychain exists but refused to prompt: it's locked, or this process runs
    /// outside the user's desktop session (e.g. started over SSH).
    #[error("{LOCKED_MESSAGE}")]
    Locked(#[source] keyring::Error),
    #[error("Stored credentials for this account are unreadable; please sign in again.")]
    Corrupt,
    #[error("Keychain error: {0}")]
    Other(String),
}

fn unavailable_message(cause: &keyring::Error) -> String {
    if cfg!(target_os = "linux") {
        "No system keychain is available. On Linux, install and unlock a Secret Service provider such as GNOME Keyring or KWallet, then try again.".to_owned()
    } else {
        format!("the system keychain is unavailable: {cause}")
    }
}

const LOCKED_MESSAGE: &str = "Your keychain is locked, or Pheeme can't ask for keychain access from here. Unlock your Mac and try again. If Pheeme was started from a terminal over SSH, start it on the Mac itself.";

/// macOS `errSecInteractionNotAllowed`: the keychain needs a prompt it isn't allowed to show.
#[cfg(target_os = "macos")]
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

#[cfg(target_os = "macos")]
fn interaction_not_allowed(cause: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    cause
        .downcast_ref::<security_framework::base::Error>()
        .is_some_and(|error| error.code() == ERR_SEC_INTERACTION_NOT_ALLOWED)
}

#[cfg(not(target_os = "macos"))]
fn interaction_not_allowed(_: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    false
}

pub trait SecretStore: Send + Sync {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError>;
    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError>;
    fn delete(&self, account_id: &str) -> Result<(), SecretsError>;
}

/// Named items under the app's keychain service. A missing item reads as `None` and
/// deletes as `Ok`.
pub trait Keychain: Send + Sync {
    fn read(&self, name: &str) -> keyring::Result<Option<String>>;
    fn write(&self, name: &str, value: &str) -> keyring::Result<()>;
    fn delete(&self, name: &str) -> keyring::Result<()>;
}

/// The real OS keychain.
pub struct OsKeychain;

impl Keychain for OsKeychain {
    fn read(&self, name: &str) -> keyring::Result<Option<String>> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write(&self, name: &str, value: &str) -> keyring::Result<()> {
        keyring::Entry::new(KEYCHAIN_SERVICE, name)?.set_password(value)
    }

    fn delete(&self, name: &str) -> keyring::Result<()> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// The keychain item holding every account's secrets. Renaming it orphans every
/// stored sign-in.
pub(crate) const VAULT: &str = "accounts";

/// Windows caps a credential at 2560 bytes of UTF-16, so a big vault is split across
/// `accounts`, `accounts:1`, `accounts:2`… Elsewhere it is always one item.
const PART_CHARS: usize = if cfg!(windows) { 1280 } else { usize::MAX };

fn part_name(index: usize) -> String {
    if index == 0 {
        VAULT.to_owned()
    } else {
        format!("{VAULT}:{index}")
    }
}

/// Before the vault, each account had its own item. They move into the vault when
/// first read.
pub(crate) fn legacy_entry_name(account_id: &str) -> String {
    format!("account:{account_id}")
}

pub(crate) fn decode(json: &str) -> Result<AccountSecrets, SecretsError> {
    serde_json::from_str(json).map_err(|_| SecretsError::Corrupt)
}

fn split(text: &str, max_chars: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let end = rest
            .char_indices()
            .nth(max_chars)
            .map_or(rest.len(), |(index, _)| index);
        parts.push(&rest[..end]);
        rest = &rest[end..];
    }
    parts
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Vault {
    accounts: HashMap<String, AccountSecrets>,
}

struct Loaded {
    vault: Vault,
    /// Items the vault occupies, so a write that needs fewer can delete the rest.
    parts: usize,
}

/// Keeps every account's secrets in one keychain item, read once per process and
/// cached. macOS asks for access per item and per app build, so this is one prompt
/// per launch however many accounts are connected.
///
/// Calls may block on an OS keychain prompt; async callers must use `spawn_blocking`.
pub struct KeyringStore<K = OsKeychain> {
    keychain: K,
    part_chars: usize,
    /// Held across keychain calls: backends aren't safe for concurrent access to one
    /// item, and concurrent first reads then share one load.
    loaded: Mutex<Option<Loaded>>,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self::with_keychain(OsKeychain, PART_CHARS)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: Keychain> KeyringStore<K> {
    pub fn with_keychain(keychain: K, part_chars: usize) -> Self {
        assert!(part_chars > 0, "part_chars must be positive");
        Self {
            keychain,
            part_chars,
            loaded: Mutex::new(None),
        }
    }

    /// Runs `op` on the cached vault, reading it from the keychain on first use.
    /// A failed read isn't cached, so a locked or missing keychain is retried.
    fn with_loaded<T>(
        &self,
        op: impl FnOnce(&mut Loaded) -> Result<T, SecretsError>,
    ) -> Result<T, SecretsError> {
        let mut guard = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(self.load().map_err(map_keyring_error)?);
        }
        op(guard.as_mut().expect("vault loaded above"))
    }

    fn load(&self) -> keyring::Result<Loaded> {
        let Some(mut json) = self.keychain.read(VAULT)? else {
            return Ok(Loaded {
                vault: Vault::default(),
                parts: 0,
            });
        };
        let mut parts = 1;
        // A prefix of a JSON object never parses, so the first parse that succeeds
        // has every part. One item never needs a second read.
        loop {
            if let Ok(vault) = serde_json::from_str(&json) {
                return Ok(Loaded { vault, parts });
            }
            match self.keychain.read(&part_name(parts))? {
                Some(next) => {
                    json.push_str(&next);
                    parts += 1;
                }
                None => {
                    // Treated as empty: every account asks to sign in again, and the
                    // next sign-in overwrites it.
                    tracing::warn!("the stored credentials are unreadable; discarding them");
                    return Ok(Loaded {
                        vault: Vault::default(),
                        parts,
                    });
                }
            }
        }
    }

    /// Writes `vault`, then adopts it, so after a failed write the cache still
    /// matches what the keychain had.
    fn save(&self, loaded: &mut Loaded, vault: Vault) -> Result<(), SecretsError> {
        let json = serde_json::to_string(&vault)
            .map_err(|error| SecretsError::Other(error.to_string()))?;
        let chunks = split(&json, self.part_chars);
        // Part 0 last: until it changes, a vault that fitted in one item still reads
        // as the old one.
        for (index, chunk) in chunks.iter().enumerate().skip(1).rev() {
            self.keychain
                .write(&part_name(index), chunk)
                .map_err(map_keyring_error)?;
        }
        self.keychain
            .write(VAULT, chunks[0])
            .map_err(map_keyring_error)?;
        for index in chunks.len()..loaded.parts {
            if let Err(error) = self.keychain.delete(&part_name(index)) {
                tracing::warn!("couldn't delete an unused keychain item: {error}");
            }
        }
        *loaded = Loaded {
            vault,
            parts: chunks.len(),
        };
        Ok(())
    }

    fn insert(
        &self,
        loaded: &mut Loaded,
        account_id: &str,
        secrets: AccountSecrets,
    ) -> Result<(), SecretsError> {
        let is_new = !loaded.vault.accounts.contains_key(account_id);
        let mut vault = loaded.vault.clone();
        vault.accounts.insert(account_id.to_owned(), secrets);
        self.save(loaded, vault)?;
        if is_new {
            // It may have an item from before the vault, now stale.
            if let Err(error) = self.keychain.delete(&legacy_entry_name(account_id)) {
                tracing::warn!("couldn't delete the old keychain item for {account_id}: {error}");
            }
        }
        Ok(())
    }
}

impl<K: Keychain> SecretStore for KeyringStore<K> {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError> {
        self.with_loaded(|loaded| self.insert(loaded, account_id, secrets.clone()))
    }

    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError> {
        self.with_loaded(|loaded| {
            if let Some(secrets) = loaded.vault.accounts.get(account_id) {
                return Ok(Some(secrets.clone()));
            }
            let legacy = self
                .keychain
                .read(&legacy_entry_name(account_id))
                .map_err(map_keyring_error)?;
            let Some(json) = legacy else {
                return Ok(None);
            };
            let secrets = decode(&json)?;
            self.insert(loaded, account_id, secrets.clone())?;
            Ok(Some(secrets))
        })
    }

    fn delete(&self, account_id: &str) -> Result<(), SecretsError> {
        self.with_loaded(|loaded| {
            if loaded.vault.accounts.contains_key(account_id) {
                let mut vault = loaded.vault.clone();
                vault.accounts.remove(account_id);
                self.save(loaded, vault)?;
            }
            self.keychain
                .delete(&legacy_entry_name(account_id))
                .map_err(map_keyring_error)
        })
    }
}

#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, AccountSecrets>>);

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemoryStore {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError> {
        self.0
            .lock()
            .map_err(|_| SecretsError::Other("memory secret store lock poisoned".into()))?
            .insert(account_id.to_owned(), secrets.clone());
        Ok(())
    }

    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| SecretsError::Other("memory secret store lock poisoned".into()))?
            .get(account_id)
            .cloned())
    }

    fn delete(&self, account_id: &str) -> Result<(), SecretsError> {
        self.0
            .lock()
            .map_err(|_| SecretsError::Other("memory secret store lock poisoned".into()))?
            .remove(account_id);
        Ok(())
    }
}

pub fn map_keyring_error(error: keyring::Error) -> SecretsError {
    match &error {
        keyring::Error::PlatformFailure(cause) if interaction_not_allowed(cause.as_ref()) => {
            SecretsError::Locked(error)
        }
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            SecretsError::Unavailable(error)
        }
        keyring::Error::BadEncoding(_) => SecretsError::Corrupt,
        other => SecretsError::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn secrets() -> AccountSecrets {
        AccountSecrets {
            client_secret: "client-secret".into(),
            refresh_token: "refresh-token".into(),
        }
    }

    #[test]
    fn memory_store_round_trip() {
        let store = MemoryStore::new();
        let expected = secrets();
        store.put("a1", &expected).unwrap();
        assert_eq!(store.get("a1").unwrap(), Some(expected));
        store.delete("a1").unwrap();
        assert_eq!(store.get("a1").unwrap(), None);
    }

    #[test]
    fn delete_missing_is_ok() {
        assert!(MemoryStore::new().delete("missing").is_ok());
    }

    #[test]
    fn keyring_unavailable_maps_to_clear_error() {
        let unavailable = keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("x")));
        assert!(matches!(
            map_keyring_error(unavailable),
            SecretsError::Unavailable(_)
        ));

        let failure = keyring::Error::PlatformFailure(Box::new(std::io::Error::other("x")));
        let error = map_keyring_error(failure);
        assert!(matches!(error, SecretsError::Unavailable(_)));
        if cfg!(target_os = "linux") {
            assert!(error.to_string().contains("Secret Service"));
        } else {
            assert!(error.to_string().contains("x"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn interaction_not_allowed_maps_to_locked() {
        let cause = security_framework::base::Error::from_code(ERR_SEC_INTERACTION_NOT_ALLOWED);
        let error = map_keyring_error(keyring::Error::PlatformFailure(Box::new(cause)));
        assert!(matches!(error, SecretsError::Locked(_)));
        assert!(error.to_string().contains("keychain is locked"));

        let other = security_framework::base::Error::from_code(-25293); // errSecAuthFailed
        let error = map_keyring_error(keyring::Error::PlatformFailure(Box::new(other)));
        assert!(matches!(error, SecretsError::Unavailable(_)));
    }

    #[test]
    fn bad_encoding_maps_to_corrupt() {
        assert!(matches!(
            map_keyring_error(keyring::Error::BadEncoding(vec![0xff])),
            SecretsError::Corrupt
        ));
    }

    #[test]
    fn account_secrets_debug_redacts() {
        let s = AccountSecrets {
            client_secret: "cs-123".into(),
            refresh_token: "rt-456".into(),
        };
        let out = format!("{:?}", s);
        assert!(!out.contains("cs-123"));
        assert!(!out.contains("rt-456"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn decode_rejects_non_json_and_missing_fields() {
        let err = decode("not json").unwrap_err();
        assert!(matches!(err, SecretsError::Corrupt));
        assert!(!err.to_string().contains("not json"));
        assert!(matches!(
            decode(r#"{"client_secret":"x"}"#),
            Err(SecretsError::Corrupt)
        ));
    }

    #[test]
    fn decode_round_trips_serialized_secrets() {
        let expected = secrets();
        let json = serde_json::to_string(&expected).unwrap();
        assert_eq!(decode(&json).unwrap(), expected);
    }

    #[test]
    fn keychain_item_names_are_stable() {
        // Changing any of these orphans every sign-in already stored in users' keychains.
        assert_eq!(VAULT, "accounts");
        assert_eq!(part_name(2), "accounts:2");
        assert_eq!(legacy_entry_name("abc"), "account:abc");
        assert_eq!(KEYCHAIN_SERVICE, "app.pheeme.desktop");
    }

    #[test]
    #[ignore]
    fn keyring_store_round_trip_on_this_os() {
        // Shares the real vault with an installed Pheeme; it only adds and removes its
        // own test accounts. Enough of them to pass Windows' 2560-byte limit, so the
        // vault is split there.
        let ids: Vec<_> = (0..8)
            .map(|n| format!("test-{}-{n}", std::process::id()))
            .collect();
        let secrets = |n: usize| AccountSecrets {
            client_secret: format!("client-secret-{n}"),
            refresh_token: format!("{n}-{}", "r".repeat(200)),
        };
        let store = KeyringStore::new();
        for (n, id) in ids.iter().enumerate() {
            store.put(id, &secrets(n)).unwrap();
        }
        let reopened = KeyringStore::new();
        for (n, id) in ids.iter().enumerate() {
            assert_eq!(reopened.get(id).unwrap(), Some(secrets(n)));
        }
        for id in &ids {
            reopened.delete(id).unwrap();
        }
        let reopened = KeyringStore::new();
        for id in &ids {
            assert_eq!(reopened.get(id).unwrap(), None);
        }
    }

    /// An in-memory keychain that counts reads and can fail its next call.
    #[derive(Default)]
    struct FakeKeychain {
        items: Mutex<HashMap<String, String>>,
        reads: AtomicUsize,
        fail_next: AtomicBool,
    }

    impl FakeKeychain {
        fn with(items: &[(&str, &str)]) -> Self {
            let fake = Self::default();
            *fake.items.lock().unwrap() = items
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect();
            fake
        }

        fn check(&self) -> keyring::Result<()> {
            if self.fail_next.swap(false, Ordering::SeqCst) {
                return Err(keyring::Error::NoStorageAccess(Box::new(
                    std::io::Error::other("locked"),
                )));
            }
            Ok(())
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = self.items.lock().unwrap().keys().cloned().collect();
            names.sort();
            names
        }
    }

    impl Keychain for FakeKeychain {
        fn read(&self, name: &str) -> keyring::Result<Option<String>> {
            self.check()?;
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.items.lock().unwrap().get(name).cloned())
        }

        fn write(&self, name: &str, value: &str) -> keyring::Result<()> {
            self.check()?;
            self.items
                .lock()
                .unwrap()
                .insert(name.to_owned(), value.to_owned());
            Ok(())
        }

        fn delete(&self, name: &str) -> keyring::Result<()> {
            self.check()?;
            self.items.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn store(keychain: FakeKeychain) -> KeyringStore<FakeKeychain> {
        KeyringStore::with_keychain(keychain, usize::MAX)
    }

    /// A new process over the same keychain contents.
    fn relaunch(store: KeyringStore<FakeKeychain>) -> KeyringStore<FakeKeychain> {
        let part_chars = store.part_chars;
        let items = store.keychain.items.into_inner().unwrap();
        let keychain = FakeKeychain::default();
        *keychain.items.lock().unwrap() = items;
        KeyringStore::with_keychain(keychain, part_chars)
    }

    fn secrets_n(n: usize) -> AccountSecrets {
        AccountSecrets {
            client_secret: format!("client-secret-{n}"),
            refresh_token: format!("refresh-token-{n}"),
        }
    }

    #[test]
    fn all_accounts_share_one_item_read_once_per_process() {
        let store = store(FakeKeychain::default());
        store.put("a1", &secrets_n(1)).unwrap();
        store.put("a2", &secrets_n(2)).unwrap();
        assert_eq!(store.keychain.names(), ["accounts"]);

        let store = relaunch(store);
        for _ in 0..3 {
            assert_eq!(store.get("a1").unwrap(), Some(secrets_n(1)));
            assert_eq!(store.get("a2").unwrap(), Some(secrets_n(2)));
        }
        assert_eq!(store.keychain.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn pre_vault_item_moves_into_the_vault_on_first_read() {
        let old = serde_json::to_string(&secrets_n(1)).unwrap();
        let store = store(FakeKeychain::with(&[("account:a1", &old)]));
        assert_eq!(store.get("a1").unwrap(), Some(secrets_n(1)));
        assert_eq!(store.keychain.names(), ["accounts"]);

        let store = relaunch(store);
        assert_eq!(store.get("a1").unwrap(), Some(secrets_n(1)));
        assert_eq!(store.keychain.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unreadable_pre_vault_item_is_corrupt() {
        let store = store(FakeKeychain::with(&[("account:a1", "not json")]));
        assert!(matches!(store.get("a1"), Err(SecretsError::Corrupt)));
    }

    #[test]
    fn signing_in_again_replaces_the_pre_vault_item() {
        let old = serde_json::to_string(&secrets_n(1)).unwrap();
        let store = store(FakeKeychain::with(&[("account:a1", &old)]));
        store.put("a1", &secrets_n(2)).unwrap();
        assert_eq!(store.keychain.names(), ["accounts"]);
        assert_eq!(relaunch(store).get("a1").unwrap(), Some(secrets_n(2)));
    }

    #[test]
    fn delete_removes_the_account_and_any_pre_vault_item() {
        let store = store(FakeKeychain::default());
        store.put("a1", &secrets_n(1)).unwrap();
        store.put("a2", &secrets_n(2)).unwrap();
        store.keychain.write("account:a1", "left over").unwrap();
        store.delete("a1").unwrap();
        assert_eq!(store.keychain.names(), ["accounts"]);

        let store = relaunch(store);
        assert_eq!(store.get("a1").unwrap(), None);
        assert_eq!(store.get("a2").unwrap(), Some(secrets_n(2)));
    }

    #[test]
    fn large_vault_is_split_across_items_and_shrinks_back() {
        let store = KeyringStore::with_keychain(FakeKeychain::default(), 40);
        for n in 1..=3 {
            store.put(&format!("a{n}"), &secrets_n(n)).unwrap();
        }
        assert!(store.keychain.names().len() > 2);

        let store = relaunch(store);
        for n in 1..=3 {
            assert_eq!(store.get(&format!("a{n}")).unwrap(), Some(secrets_n(n)));
        }
        store.delete("a1").unwrap();
        store.delete("a2").unwrap();
        let json =
            serde_json::to_string(&store.with_loaded(|l| Ok(l.vault.clone())).unwrap()).unwrap();
        assert_eq!(store.keychain.names().len(), json.len().div_ceil(40));
        assert_eq!(relaunch(store).get("a3").unwrap(), Some(secrets_n(3)));
    }

    #[test]
    fn unreadable_vault_is_replaced_by_the_next_sign_in() {
        let store = store(FakeKeychain::with(&[("accounts", "{\"accounts\":")]));
        assert_eq!(store.get("a1").unwrap(), None);
        store.put("a1", &secrets_n(1)).unwrap();
        assert_eq!(relaunch(store).get("a1").unwrap(), Some(secrets_n(1)));
    }

    #[test]
    fn unavailable_keychain_is_retried() {
        let store = store(FakeKeychain::default());
        store.keychain.fail_next.store(true, Ordering::SeqCst);
        assert!(matches!(store.get("a1"), Err(SecretsError::Unavailable(_))));
        assert_eq!(store.get("a1").unwrap(), None);
    }

    #[test]
    fn failed_write_keeps_the_previous_secrets() {
        let store = store(FakeKeychain::default());
        store.put("a1", &secrets_n(1)).unwrap();
        store.keychain.fail_next.store(true, Ordering::SeqCst);
        assert!(store.put("a1", &secrets_n(2)).is_err());
        assert_eq!(store.get("a1").unwrap(), Some(secrets_n(1)));
        assert_eq!(relaunch(store).get("a1").unwrap(), Some(secrets_n(1)));
    }

    #[test]
    fn split_keeps_characters_whole() {
        assert_eq!(split("aé€b", 2), ["aé", "€b"]);
        assert_eq!(split("abc", usize::MAX), ["abc"]);
    }
}
