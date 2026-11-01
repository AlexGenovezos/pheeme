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

pub trait SecretStore: Send + Sync {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError>;
    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError>;
    fn delete(&self, account_id: &str) -> Result<(), SecretsError>;
}

/// Calls may block on an OS keychain prompt; async callers must use `spawn_blocking`.
pub struct KeyringStore;

// Keyring backends are not safe for concurrent access to the same entry.
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn entry_name(account_id: &str) -> String {
    format!("account:{account_id}")
}

pub(crate) fn decode(json: &str) -> Result<AccountSecrets, SecretsError> {
    serde_json::from_str(json).map_err(|_| SecretsError::Corrupt)
}

impl KeyringStore {
    fn with_entry<T>(
        account_id: &str,
        operation: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
    ) -> keyring::Result<T> {
        let _guard = KEYRING_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &entry_name(account_id))?;
        operation(&entry)
    }
}

impl SecretStore for KeyringStore {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError> {
        let value = serde_json::to_string(secrets)
            .map_err(|error| SecretsError::Other(error.to_string()))?;
        Self::with_entry(account_id, |entry| entry.set_password(&value)).map_err(map_keyring_error)
    }

    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError> {
        let value = match Self::with_entry(account_id, |entry| entry.get_password()) {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(error) => return Err(map_keyring_error(error)),
        };
        decode(&value).map(Some)
    }

    fn delete(&self, account_id: &str) -> Result<(), SecretsError> {
        match Self::with_entry(account_id, |entry| entry.delete_credential()) {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
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
            decode("{\"client_secret\":\"x\"}"),
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
    fn keychain_entry_name_is_stable() {
        // Changing either value orphans every token already stored in users' keychains.
        assert_eq!(entry_name("abc"), "account:abc");
        assert_eq!(KEYCHAIN_SERVICE, "app.pheeme.desktop");
    }

    #[test]
    #[ignore]
    fn keyring_store_round_trip_on_this_os() {
        let store = KeyringStore;
        let account_id = format!("test-{}", std::process::id());
        let expected = secrets();
        store.put(&account_id, &expected).unwrap();
        assert_eq!(store.get(&account_id).unwrap(), Some(expected));
        store.delete(&account_id).unwrap();
        assert_eq!(store.get(&account_id).unwrap(), None);
    }
}
