# Foundation Fixes + PR CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase 1–2 codebase a sound base for OAuth and sync: correct identity, safe startup, keychain-only secrets, a schema that supports fast combined-inbox listing, a real CSP, and CI on every PR.

**Architecture:** Same two-process Tauri app. Rust changes are confined to `src-tauri/src/{lib.rs,identity.rs,secrets.rs,db/}` and the single migration `001_initial.sql` (edited in place because nothing has shipped). CI is one GitHub Actions workflow. The frontend only gets lint and test tooling plus the rename.

**Tech Stack:** Tauri 2, Rust (sqlx 0.8 SQLite with offline cache, keyring 3, thiserror), React 18 + TypeScript + Vite 6, Vitest 2, ESLint 9, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md` (§7 PR checks, §10 foundation fixes, §11 testing/dev loop, §12 step 1).

## Global Constraints

- Product name `Pheeme`; MIT license; no "Gmail" in product, package, or identifier names (spec §10.7).
- SQLite stores **no secrets**: OAuth refresh tokens and client secrets live only in the OS keychain (spec §10.1). Access tokens are memory-only *(plan's call: avoids an hourly keychain write and macOS keychain prompts)*.
- Every SQL query uses `sqlx::query!` / `query_as!` macros, and `src-tauri/.sqlx/` is regenerated with `cargo sqlx prepare` after any query or schema change (CLAUDE.md).
- All commands run with `SQLX_OFFLINE=true` except `cargo sqlx prepare`.
- CI tests are offline only: no real Google account, no secrets (spec §11).
- Dev ports stay 1420/1421 (CLAUDE.md).
- On this devbox, heavy commands go through the `heavy` slot wrapper (`heavy cargo test`, etc.).

## Review Focus

1. **Threads with no date (`last_message_date` NULL)** must still appear in listings and must not break pagination. Pinned by `list_threads_includes_undated_threads_last` (Task 4).
2. **The same Gmail thread ID in two accounts** (IDs are only unique per mailbox) must appear twice in All Inboxes, with no duplicates or skips across pages. Pinned by `list_threads_same_thread_id_in_two_accounts` (Task 4).
3. **Many threads with the same timestamp straddling a page boundary** must page without duplicates or gaps. Pinned by `list_threads_keyset_pages_ties_without_gaps` (Task 4).
4. **Re-syncing a thread whose labels changed** must replace its labels, not add to them, so an archived thread leaves the Inbox listing. Pinned by `upsert_thread_replaces_labels` (Task 3).
5. **A Linux machine with no Secret Service running** must produce a clear, user-readable error, not a panic or a silent fallback to the mock store. Pinned by `keyring_unavailable_maps_to_clear_error` (Task 5).

---

## Prerequisites (Alex, once, on the devbox — needs sudo)

The devbox can't compile Tauri without these. On the Mac, Task 8's script covers setup.

```bash
sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  librsvg2-dev libayatana-appindicator3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  build-essential pkg-config libssl-dev
cargo install sqlx-cli --no-default-features --features sqlite,rustls
cd <repo checkout> && npm ci
```

Verify with `cd src-tauri && SQLX_OFFLINE=true heavy cargo test`. Expected: the 2 existing tests pass.

Execution happens in a worktree: `wt switch -c feat/foundation` from `docs/pheeme-design`.

---

### Task 1: Pheeme identity, CSP, and license

**Files:**
- Create: `src-tauri/src/identity.rs`, `LICENSE`
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (`[package] name`, `[lib] name`, `description`), `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` (add `pub mod identity;`), `package.json` (`name`), `index.html` (`<title>`), `src/App.tsx` (text), `src-tauri/src/commands/mod.rs` (greet text), `docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md` §10.7
- Test: `src-tauri/src/identity.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `pub const APP_IDENTIFIER: &str = "app.pheeme.desktop";` and `pub const KEYCHAIN_SERVICE: &str = APP_IDENTIFIER;` in `crate::identity`. Crate lib name `pheeme_lib`.

The name is now decided and nothing has shipped, so the rename is free today. Waiting until release (as spec §10.7 assumed) would only add risk. *(Plan's call; update §10.7 to say the in-code rename happened in this phase and only the GitHub repo rename to `pheeme` remains, as Alex's action.)*

- [ ] **Step 1: Write the failing tests** in `identity.rs`:

```rust
#[test]
fn identifier_matches_tauri_conf() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(conf["identifier"], APP_IDENTIFIER);
    assert_eq!(conf["productName"], "Pheeme");
}

#[test]
fn csp_is_strict() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let csp = &conf["app"]["security"]["csp"];
    assert!(!csp.is_null(), "CSP must be set");
    let s = csp.to_string();
    assert!(s.contains("default-src") && s.contains("'self'"));
    assert!(!s.contains("unsafe-eval"));
    assert!(!s.contains("script-src 'self' 'unsafe-inline'"));
}
```

- [ ] **Step 2: Run them and confirm they fail.** Run `cd src-tauri && SQLX_OFFLINE=true heavy cargo test identity`. Expected: compile error (module missing), then assertion failures.
- [ ] **Step 3: Implement the changes.**
  - `tauri.conf.json`: set `productName` to `"Pheeme"`, `identifier` to `"app.pheeme.desktop"`, and the window `title` to `"Pheeme"`.
  - Set `app.security.csp` to the object form with these values:
    - `default-src`: `'self'`
    - `script-src`: `'self'`
    - `style-src`: `'self' 'unsafe-inline'`
    - `img-src`: `'self' data: asset: http://asset.localhost`
    - `connect-src`: `ipc: http://ipc.localhost`
    - `font-src`: `'self' data:`
    - `object-src`: `'none'`
    - `base-uri`: `'none'`
  - Set `app.security.devCsp` to the same values, with `ws://localhost:1421` added to `connect-src` for Vite HMR.
  - Cargo: package `pheeme`, lib `pheeme_lib`, and `main.rs` calls `pheeme_lib::run()`.
  - `package.json`: `name` becomes `"pheeme"`.
  - `LICENSE`: standard MIT text, `Copyright (c) 2026 Alex Genovezos`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `SQLX_OFFLINE=true heavy cargo test identity`. Expected: 2 passed. Then `npm run build`. Expected: success.
- [ ] **Step 5: Commit** with `git commit -m "chore: rename to Pheeme, add strict CSP and MIT license"`

---

### Task 2: Deterministic startup

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (inline tests); add `tempfile = "3"` under `[dev-dependencies]`

**Interfaces:**
- Consumes: `db::init_db(&Path) -> anyhow::Result<SqlitePool>` (exists).
- Produces: `pub struct AppState { pub db: SqlitePool }`, with no `Arc` because `SqlitePool` is already a cheap handle. Also `pub async fn build_state(data_dir: &Path) -> anyhow::Result<AppState>`. All top-level modules become `pub mod` so library items aren't dead code under `clippy -D warnings`.

- [ ] **Step 1: Write the failing test.**

```rust
#[tokio::test]
async fn build_state_creates_db_and_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let state = build_state(dir.path()).await.unwrap();
    assert!(dir.path().join("db.sqlite").exists());
    let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(n.0, 0);
}
```

- [ ] **Step 2: Run it and confirm it fails.** Run `SQLX_OFFLINE=true heavy cargo test build_state`. Expected: compile error, because `build_state` isn't defined.
- [ ] **Step 3: Implement it.** `setup` resolves `app_data_dir()`, then runs `let state = tauri::async_runtime::block_on(build_state(&data_dir))?;` and `app.manage(state);` **before returning `Ok(())`**. Remove the spawned task. On failure, `setup` returns the error, so the app exits with a logged message instead of panicking later.
- [ ] **Step 4: Run the test and confirm it passes.** Run `SQLX_OFFLINE=true heavy cargo test build_state`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "fix: initialize database before serving commands"`

---

### Task 3: Schema fixes — no secrets, attachments FK, thread_labels

**Files:**
- Modify: `src-tauri/src/db/migrations/001_initial.sql`, `src-tauri/src/db/accounts.rs`, `src-tauri/src/db/threads.rs`, `src-tauri/src/db/mod.rs` (tests), `src-tauri/.sqlx/*` (regenerated)
- Test: `src-tauri/src/db/mod.rs` and `src-tauri/src/db/threads.rs` (inline)

**Interfaces:**
- Produces:
  - `DbAccount` without `access_token_encrypted`, `refresh_token_encrypted` and `token_expiry`; `update_tokens` is deleted.
  - `DbThread` without `label_ids`.
  - `upsert_thread(pool: &SqlitePool, thread: &DbThread, label_ids: &[String]) -> Result<()>` replaces the thread's label set and rewrites `thread_labels.last_message_date`, all in one transaction.
  - `update_thread_labels(pool: &SqlitePool, account_id: &str, thread_id: &str, label_ids: &[String]) -> Result<()>`, which replaces the label set.
  - `get_thread_label_ids(pool: &SqlitePool, account_id: &str, thread_id: &str) -> Result<Vec<String>>`, sorted ascending.
  - `get_threads_by_label` is deleted; Task 4 replaces it.

**Schema (exact):**
- `accounts`: drop `access_token_encrypted`, `refresh_token_encrypted` and `token_expiry`. `client_id` stays (it isn't secret).
- `threads`: drop the `label_ids` column and the `idx_threads_account_label` index.
- `attachments`: add `FOREIGN KEY (message_id, account_id) REFERENCES messages(id, account_id) ON DELETE CASCADE`.
- New table:

```sql
CREATE TABLE thread_labels (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  last_message_date INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, thread_id, label_id),
  FOREIGN KEY (thread_id, account_id) REFERENCES threads(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_thread_labels_listing
  ON thread_labels(label_id, last_message_date DESC, account_id DESC, thread_id DESC);
```

`messages.label_ids` (JSON) stays as it is: labels per message are display data, not a listing key.

- [ ] **Step 1: Write the failing tests.**
  - `accounts_cascade_deletes_children` (extend the existing test): insert an account, label, thread (with labels `["INBOX"]`), message and attachment. Delete the account, then assert `labels`, `threads`, `thread_labels`, `messages` and `attachments` all have 0 rows.
  - `deleting_message_cascades_attachments`: delete one message and assert its attachments are gone while another message's attachments remain.
  - `upsert_thread_replaces_labels` (Review Focus 4): upsert with `["INBOX","CATEGORY_PRIMARY"]`, then again with `["CATEGORY_PRIMARY"]`. `get_thread_label_ids` must return `["CATEGORY_PRIMARY"]`.
  - `upsert_thread_updates_label_dates`: upsert with date 100, then again with date 200. Every `thread_labels` row for that thread must have `last_message_date = 200`.
  - `accounts_table_has_no_token_columns`: `PRAGMA table_info(accounts)` must have no column whose name contains `token`.
- [ ] **Step 2: Run them and confirm they fail.** Run `SQLX_OFFLINE=true heavy cargo test -p pheeme db::`. Expected: compile errors or failed assertions.
- [ ] **Step 3: Implement it.** Edit the migration as specified and update the structs and queries. `upsert_thread` runs inside one transaction:
  1. Upsert the `threads` row.
  2. `DELETE FROM thread_labels WHERE account_id=? AND thread_id=?`.
  3. Insert one row per label, with `COALESCE(last_message_date, 0)`.
- [ ] **Step 4: Regenerate the offline cache.** From `src-tauri/`:

```bash
export DATABASE_URL="sqlite://$PWD/dev.sqlite"
rm -f dev.sqlite* && sqlx database create && sqlx migrate run --source src/db/migrations
cargo sqlx prepare -- --all-targets
```

  Expected: `query data written to .sqlx`. Delete any old `.sqlx/query-*.json` the command reports as unused.
- [ ] **Step 5: Run the tests and confirm they pass.** Run `SQLX_OFFLINE=true heavy cargo test`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -m "fix(db): keychain-only secrets, attachment cascade, thread_labels table"`

---

### Task 4: Fast thread listing for per-account and All Inboxes views

**Files:**
- Modify: `src-tauri/src/db/threads.rs`, `src-tauri/.sqlx/*`
- Test: `src-tauri/src/db/threads.rs` (inline)

**Interfaces:**
- Consumes: `upsert_thread` and the `thread_labels` table (Task 3).
- Produces:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadCursor { pub last_message_date: i64, pub account_id: String, pub thread_id: String }

pub struct ThreadQuery<'a> {
    pub account_ids: &'a [String],      // one id = per-account view; all ids = All Inboxes
    pub label_id: &'a str,              // drives the index, e.g. "INBOX" or "CATEGORY_PRIMARY"
    pub also_label_id: Option<&'a str>, // intersection, e.g. Primary tab = CATEGORY_PRIMARY + INBOX
    pub before: Option<&'a ThreadCursor>,
    pub limit: i64,
}

pub struct ThreadPage { pub threads: Vec<DbThread>, pub next: Option<ThreadCursor> }

pub async fn list_threads(pool: &SqlitePool, q: &ThreadQuery<'_>) -> Result<ThreadPage>
```

Semantics:
- Ordering is `last_message_date DESC, account_id DESC, thread_id DESC`, read from `thread_labels`.
- `account_ids` is bound as one JSON array and filtered with `account_id IN (SELECT value FROM json_each(?))`, so the query stays a compile-checked macro.
- `before` uses the SQLite row-value comparison `(tl.last_message_date, tl.account_id, tl.thread_id) < (?, ?, ?)`.
- `also_label_id` adds an `EXISTS` against `thread_labels` for the same account and thread.
- `next` is `Some(cursor of the last row)` only when the page returned `limit` rows.
- Category tabs need `also_label_id = Some("INBOX")`, because Gmail category labels also stay on archived mail. *(Plan's call; it corrects the original plan's "filter by the category label alone".)*

- [ ] **Step 1: Write the failing tests** using a helper that seeds accounts `a1` and `a2` with threads:
  - `list_threads_orders_newest_first_across_accounts`: a1 has dates 300 and 100, a2 has 200. All Inboxes for `INBOX` returns 300, 200, 100.
  - `list_threads_same_thread_id_in_two_accounts` (Review Focus 2): thread `t1` exists in both a1 and a2. Both are returned. Paging with `limit = 1` yields both across two pages, with no repeats.
  - `list_threads_keyset_pages_ties_without_gaps` (Review Focus 3): 25 a1 threads all dated 500. Paging with `limit = 10` gives 10, 10, 5, then `next == None`. The union is all 25 IDs with no duplicates.
  - `list_threads_includes_undated_threads_last` (Review Focus 1): one thread with `last_message_date = None` plus one dated 100. The dated thread comes first, the undated one is still returned, and its cursor date is 0.
  - `list_threads_intersects_also_label`: an archived thread with `CATEGORY_PRIMARY` but no `INBOX` is excluded when `also_label_id = Some("INBOX")`.
  - `list_threads_respects_account_filter`: `account_ids = ["a1"]` returns no a2 threads.
- [ ] **Step 2: Run them and confirm they fail.** Run `SQLX_OFFLINE=true heavy cargo test list_threads`. Expected: compile error, because `list_threads` isn't defined.
- [ ] **Step 3: Implement `list_threads`** as specified, then regenerate `.sqlx` using the Task 3 Step 4 commands.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `SQLX_OFFLINE=true heavy cargo test`. Expected: all pass.
- [ ] **Step 5: Check that the index is used.** Run `EXPLAIN QUERY PLAN` for the All Inboxes query in `sqlite3 dev.sqlite`. Expected: the output shows `USING INDEX idx_thread_labels_listing` and no `SCAN thread_labels` or `USE TEMP B-TREE FOR ORDER BY`. Record the output in the commit message body.
- [ ] **Step 6: Commit** with `git commit -m "feat(db): keyset thread listing across accounts"`

---

### Task 5: Keychain secret store

**Files:**
- Create: `src-tauri/src/secrets.rs`
- Delete: `src-tauri/src/crypto.rs` and its `mod crypto;` line
- Modify: `src-tauri/Cargo.toml` and `src-tauri/src/lib.rs` (`pub mod secrets;`)
- Test: `src-tauri/src/secrets.rs` (inline)

**Interfaces:**
- Consumes: `identity::KEYCHAIN_SERVICE` (Task 1).
- Produces:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountSecrets { pub client_secret: String, pub refresh_token: String }

#[derive(Debug, thiserror::Error)]
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
    fn delete(&self, account_id: &str) -> Result<(), SecretsError>; // Ok if absent
}

pub struct KeyringStore;      // service = KEYCHAIN_SERVICE, user = format!("account:{account_id}"), value = JSON
pub struct MemoryStore(/* Mutex<HashMap<String, AccountSecrets>> */);
pub fn map_keyring_error(e: keyring::Error) -> SecretsError
```

**Dependency fix (a real bug):** keyring 3 has **no default platform backends**. With bare `keyring = "3"` it silently uses its in-memory mock on every OS, so tokens would vanish on restart. Set:

```toml
keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service", "crypto-rust"] }
```

Tests use `MemoryStore` because the keyring mock doesn't share state between `Entry` instances, so it can't test round-trips.

- [ ] **Step 1: Write the failing tests.**
  - `memory_store_round_trip`: put, get (returns `Some` with equal fields), delete, get (returns `None`).
  - `delete_missing_is_ok`: deleting an unknown account returns `Ok(())`.
  - `keyring_unavailable_maps_to_clear_error` (Review Focus 5): `map_keyring_error(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("x"))))` and the same for `PlatformFailure` both match `SecretsError::Unavailable`, and `to_string()` contains `"Secret Service"`.
  - `bad_encoding_maps_to_corrupt`: `keyring::Error::BadEncoding(vec![0xff])` maps to `Corrupt`.
  - `#[ignore] keyring_store_round_trip_on_this_os`: a real keychain round-trip, run by hand on the Mac with `cargo test -- --ignored keyring_store`.
- [ ] **Step 2: Run them and confirm they fail.** Run `SQLX_OFFLINE=true heavy cargo test secrets`. Expected: compile error.
- [ ] **Step 3: Implement it.** `KeyringStore::get` maps `NoEntry` to `Ok(None)`, and a JSON parse failure to `Corrupt`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `SQLX_OFFLINE=true heavy cargo test secrets`. Expected: 4 passed, 1 ignored. On the Mac, Alex runs the ignored test once. Expected: PASS, with possibly one keychain prompt.
- [ ] **Step 5: Commit** with `git commit -m "feat: keychain secret store with real platform backends"`

---

### Task 6: Frontend lint and test tooling

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces npm scripts: `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest`), and `test:ci` (`vitest run --passWithNoTests`). CI calls these by name.

- [ ] **Step 1: Install the dev dependencies.** Run `npm i -D eslint@9 @eslint/js typescript-eslint eslint-plugin-react-hooks globals`. Also pin `lucide-react` from `"latest"` to the installed version with a caret, so `npm ci` is reproducible.
- [ ] **Step 2: Write `eslint.config.js`** as a flat config. It uses `@eslint/js` recommended, `typescript-eslint` recommended and `react-hooks` recommended, with browser globals, and ignores `dist`, `src-tauri` and `node_modules`.
- [ ] **Step 3: Run the checks.** Run `npm run typecheck && npm run lint && npm run test:ci`. Expected: all three exit 0. Fix any findings in `src/`. There are only stubs, so expect at most trivial fixes.
- [ ] **Step 4: Commit** with `git commit -m "chore: add ESLint, typecheck and CI test scripts"`

---

### Task 7: PR CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the npm scripts from Task 6. Runs `cargo fmt`, `clippy` and `test` from `src-tauri/`.

Triggers: `pull_request` and pushes to `main`. Set `concurrency` to the workflow and ref, with `cancel-in-progress: true`. Every job sets `env: SQLX_OFFLINE: "true"`.

**Job `checks`** (matrix `os: [macos-latest, windows-latest, ubuntu-22.04]`, `fail-fast: false`):
1. `actions/checkout@v4`
2. `actions/setup-node@v4` with node `22` and `cache: npm`
3. On Ubuntu only: `sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libsoup-3.0-dev`
4. `dtolnay/rust-toolchain@stable` with `components: clippy, rustfmt`
5. `Swatinem/rust-cache@v2` with `workspaces: src-tauri`
6. `npm ci`, then `npm run typecheck`, `npm run lint`, `npm run test:ci`, `npm run build`
7. In `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`

**Job `sqlx-cache`** (ubuntu-22.04 only): checkout, the step 3 libs, the rust toolchain, rust-cache, and `taiki-e/install-action@v2` with `tool: sqlx-cli`. Then, in `src-tauri` with `DATABASE_URL=sqlite://$PWD/ci.sqlite` and `SQLX_OFFLINE` unset: run `sqlx database create`, `sqlx migrate run --source src/db/migrations`, then `cargo sqlx prepare --check -- --all-targets`. This fails the PR when someone changes a query without regenerating `.sqlx`.

**Job `bundle`** (same 3-OS matrix, `needs: checks`, PRs only): do the same setup, then run `npx tauri build --debug`. Upload `src-tauri/target/debug/bundle/**` with `actions/upload-artifact@v4`, named `pheeme-${{ matrix.os }}`, with `retention-days: 7`. The builds are unsigned and only for reviewing Windows and Linux (spec §11). Alex reviews on his Mac locally, not from these artifacts.

- [ ] **Step 1: Write `ci.yml`** as specified.
- [ ] **Step 2: Validate it locally.** Run `npx --yes action-validator .github/workflows/ci.yml`. Expected: no errors.
- [ ] **Step 3: Commit, push the branch, and open a draft PR.** That is the real test. Before arming any watcher, follow the CI-watching rules in `~/.claude/CLAUDE.md`: confirm checks were created and the PR is mergeable.
- [ ] **Step 4: Confirm green.** `gh pr checks <n>` shows all `checks`, `sqlx-cache` and `bundle` jobs passing. Fix and push until they do.

---

### Task 8: macOS dev loop

**Files:**
- Create: `scripts/setup-macos.sh`
- Modify: `README.md` (add a "Develop on macOS" section)

**Interfaces:**
- Produces `scripts/setup-macos.sh`. It is idempotent and exits non-zero with a one-line fix hint for anything missing. It does the following:
  1. Checks that `xcode-select -p` succeeds.
  2. Checks for `rustup` and `cargo`, and if they're missing, points to `https://rustup.rs`.
  3. Checks that Node is 22 or newer.
  4. Runs `rustup target add aarch64-apple-darwin x86_64-apple-darwin`, needed later for universal builds.
  5. Installs `sqlx-cli` with `--no-default-features --features sqlite,rustls` if it's absent.
  6. Runs `npm ci`.
  7. Prints `Ready: npm run tauri dev`.

- [ ] **Step 1: Write the script** (`set -euo pipefail`) and the README section. The section covers the clone, `scripts/setup-macos.sh`, `npm run tauri dev`, and how to run the ignored keychain test.
- [ ] **Step 2: Lint the script.** Run `shellcheck scripts/setup-macos.sh`. Expected: no findings.
- [ ] **Step 3: Alex runs it on the Mac**, followed by `npm run tauri dev`. Expected: the Pheeme window opens and shows the placeholder screen.
- [ ] **Step 4: Commit** with `git commit -m "docs: macOS development setup"`

---

## Out of scope for this plan (later phases, per spec §12)

OAuth commands, the Gmail client, the sync engine with its outbox table, the FTS5 search table, the browser preview mode with mocked IPC (it belongs with the app shell phase, when there is UI to preview), the release workflow, the updater, and notarization.
