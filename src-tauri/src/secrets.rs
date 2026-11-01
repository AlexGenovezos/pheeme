use crate::identity::KEYCHAIN_SERVICE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountSecrets {
    pub client_secret: String,
    pub refresh_token: String,
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum SecretsError {
    #[error("No system keychain is available. On Linux, install and unlock a Secret Service provider such as GNOME Keyring or KWallet, then try again.")]
    Unavailable,
    #[error("Stored credentials for this account are unreadable; please sign in again.")]
    Corrupt,
    #[error("Keychain error: {0}")]
    Other(String),
}

pub trait SecretStore: Send + Sync {
    fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), SecretsError>;
    fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, SecretsError>;
    fn delete(&self, account_id: &str) -> Result<(), SecretsError>;
}

pub struct KeyringStore;

impl KeyringStore {
    fn with_entry<T>(
        account_id: &str,
        operation: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
    ) -> keyring::Result<T> {
        let _guard = keyring_lock().lock().map_err(|_| {
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
                "keyring lock poisoned",
            )))
        })?;
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &format!("account:{account_id}"))?;
        operation(&entry)
    }
}

fn keyring_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
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
        serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| SecretsError::Corrupt)
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
    match error {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            SecretsError::Unavailable
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
        assert_eq!(map_keyring_error(unavailable), SecretsError::Unavailable);

        let failure = keyring::Error::PlatformFailure(Box::new(std::io::Error::other("x")));
        let error = map_keyring_error(failure);
        assert_eq!(error, SecretsError::Unavailable);
        assert!(error.to_string().contains("Secret Service"));
    }

    #[test]
    fn bad_encoding_maps_to_corrupt() {
        assert_eq!(
            map_keyring_error(keyring::Error::BadEncoding(vec![0xff])),
            SecretsError::Corrupt
        );
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
