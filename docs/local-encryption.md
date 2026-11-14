# Local mail encryption

Pheeme encrypts its local mail database with SQLCipher, including message bodies,
subjects, addresses, drafts, contacts, calendar events, tasks and the search index.
The database's write-ahead log and rollback journals are encrypted too. SQLite
temporary tables use memory. Search and offline reading work as before.

Cached attachments, inline images and attachments staged for composing use
XChaCha20-Poly1305 authenticated encryption, with a fresh nonce on every write.
Ciphertext is bound to its purpose and relative file path, so replacing one
message's attachment with another's does not produce readable content. File
sizes and cache directory names (including Gmail message IDs) remain visible.

Pheeme generates independent random 256-bit keys for the database and attachment
files. They are stored together in the OS keychain under the service
`app.pheeme.desktop`, item `local-storage-v1`. They are never written to app
settings or files beside the database. Sign-in credentials remain separate
keychain entries. Access tokens remain in memory.

The system keychain must be available at startup, even for offline use. On Linux,
run and unlock a Secret Service provider such as GNOME Keyring or KWallet. If the
keychain is unavailable, Pheeme stops with an error instead of writing plaintext.
Only one Pheeme process can use a data folder at a time.

## Upgrading an existing installation

The first launch saves and reads back the keys before changing mail storage.
It checkpoints the old SQLite write-ahead log, exports the database into an
encrypted file, rebuilds the search index and verifies database integrity and
relationships before replacing the original. Allow free disk space for a second
database during this step. There is no retained plaintext database backup.

Existing cached and staged attachments are converted into separate encrypted
directories (`attachments-v1` and `compose-v1`). Each original is removed only
after its encrypted replacement has been written and synced. Draft attachments
keep their existing handles. An interrupted conversion resumes at the next
launch; an incomplete database export is rebuilt from the original. Migration
errors stop startup rather than discarding unsent work or using plaintext.

Removing old files cannot erase copies in existing backups, filesystem snapshots
or freed disk blocks. Continue using full-disk encryption (FileVault, BitLocker
or LUKS) and encrypted backups. Do not downgrade to a version of Pheeme that
predates local encryption: it cannot read the encrypted database.

## Backups and recovery

A backup of app files alone is insufficient to restore encrypted mail. Preserve
the original OS keychain through your operating system's supported backup and
restore process. Pheeme never silently replaces a missing or damaged key for an
existing encrypted store, and it never resets that store automatically. Restore
the original keychain before retrying. Without the key, local data cannot be
decrypted; mail already synced to Gmail remains available there, but unsynced
local work may not be recoverable.

If the key is missing or damaged, the startup dialog also offers **Start
again**: Pheeme moves the unreadable database and staged draft attachments into
an `unreadable-<time>` folder in its data folder, deletes the attachment cache,
makes a new key, and downloads mail again after you sign in. If you later
restore the old key, quit Pheeme and move those files back to read them.

## Files opened or saved outside Pheeme

Saving an attachment to Downloads deliberately creates an ordinary readable
file. Opening an attachment in another desktop application also requires a
plaintext copy, under the app cache's `opened` folder. On Unix these directories
are restricted to the current user; Windows inherits the user's app-data ACL.
Pheeme removes opened copies at startup and attempts to remove them on exit;
after a crash they remain until the next launch. Copies older than a day are
also cleared when opening another attachment. Other applications may retain
their own copies.

Diagnostic logs, custom themes and installed mods are outside this encrypted
mail store. Logs can contain personal metadata; review them before sharing
([Local diagnostics](diagnostics.md)). Encryption protects copied storage files
without their keys. It provides limited protection against malware running as
your user while Pheeme and the keychain are unlocked, or against apps you have
authorized to access mail.

## Building

Cargo bundles SQLCipher and a static OpenSSL crypto provider, so users do not
need to install SQLCipher or OpenSSL. Building the bundled provider requires Perl
and a C build toolchain (plus Make on Unix); Windows builds need a compatible
Perl installation in PATH. SQLx offline metadata uses the same SQL schema and
can still be prepared against a disposable plaintext development database.
