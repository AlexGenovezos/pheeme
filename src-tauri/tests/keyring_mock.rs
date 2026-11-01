//! Own test binary: the mock builder is process-global and must not leak into
//! the ignored real-keychain test.

use pheeme_lib::secrets::{KeyringStore, SecretStore};

#[test]
fn keyring_store_missing_entry_is_none_and_delete_ok() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let store = KeyringStore;
    assert!(matches!(store.get("never-written"), Ok(None)));
    assert!(matches!(store.delete("never-written"), Ok(())));
}
