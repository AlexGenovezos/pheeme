# Sync Engine (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every account's SQLite cache fresh in the background (initial sync, history-based incremental sync, history-expiry reconcile, backfill), with a persisted, ordered outbox for optimistic mutations and safe sends, and serve every list view (per account and All Inboxes) from SQLite.

**Architecture:** Tauri-free services under `src-tauri/src/sync/` talk to Gmail through a `MailApi` trait (implemented by `GmailClient`, faked in tests by an in-memory `FakeGmail`). All derived state (thread rows, `thread_labels`, flags) is recomputed from cached messages by one function, so sync, backfill, outbox and rollback can't drift apart. A `SyncManager` owns per-account locks, the 90 s timer and triggers; a `MailService` is the read/mutate API that thin Tauri commands call. Events go through a `SyncEvents` sink that the Tauri layer maps to `app.emit`.

**Tech Stack:** Rust (tokio, sqlx 0.8 SQLite with compile-time macros, async-trait, wiremock for client tests), React + Zustand + Vitest for the small frontend slice.

**Spec:** `docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md` (§5 optimistic writes, cache depth; §10 item 6; §12 step 4), ticket #12, plan Phase 5 in `Gmail client project plan.md`.

## Global Constraints

- Business logic stays Tauri-free (`db/`, `gmail/`, `sync/`, `mail.rs`); `commands/` only parses args, calls a service, maps errors to `CommandError { code, message }`.
- SQL lives in `db/<entity>.rs` via `sqlx::query!`/`query_as!` macros; run `cargo sqlx prepare -- --all-targets` after schema/query changes (CI runs `--check`).
- New schema goes in a new migration `002_sync.sql` (v0.2+ shipped with `001`; never edit `001`).
- Never `INSERT OR REPLACE` on `threads` (cascades `thread_labels`).
- Tokens never touch SQLite. Tests are offline only (fake API or wiremock).
- Gmail quota: keep `GmailClient`'s 10-request cap; pause 1 s between backfill pages.
- Primary category label id is `CATEGORY_PERSONAL` (Gmail API), not `CATEGORY_PRIMARY`.
- Event names exactly: `sync:started`, `sync:messages_updated`, `sync:labels_updated`, `sync:completed`, `sync:error`, plus `outbox:rejected` and `outbox:send_status`. Payloads camelCase.
- Heavy commands go through `heavy` (`heavy cargo test`), per devbox rules.

## Builder's calls (decided here)

1. **History id for initial sync:** read `profile.historyId` *before* listing anything and store that. It is never newer than any change we didn't see, so every later change is replayed by `history.list`, and replaying is idempotent. (Strictly safer than "historyId of the newest fetched message", which the ticket names; same intent — never trust list-response ids.)
2. **Initial page:** `threads.list(INBOX, 50)` then `threads.get(full)` per thread (concurrent, capped by the client), so first paint has whole conversations.
3. **Cache depth:** backfill walks `messages.list` (all mail, newest first, 500/page). Full bodies until the first page whose oldest message is older than 180 days; `metadata` after that. Bodies of `fully_fetched = 0` messages load on open (`MailService::get_thread`). No thread-count cap yet.
4. **Optimistic ops vs sync = rebase.** After any write that touches a thread (history, backfill, reconcile, rollback), pending ops on that thread's messages are re-applied in `seq` order on top of the new server state. Because label ops are set operations, a history record produced by our own op becomes a no-op — the "matching history records are dropped" requirement — and another device's unrelated changes survive. Ops target the **message ids recorded at enqueue time**, executed with `messages.batchModify` (new client method), so mail arriving later in the thread is never touched.
5. **Rollback** on definitive rejection (Gmail 4xx other than 401/429): refetch the op's messages with `format=minimal`; if that fails, restore the per-message `prior_label_ids` saved at enqueue. Then rebase remaining ops, recompute, emit `outbox:rejected`.
6. **Trash** local effect: add `TRASH`. Derived thread labels ignore trashed/spam messages for every other label, so trashed mail leaves Inbox etc. immediately.
7. **History-expiry reconcile:** profile id first; refresh labels + the INBOX first page as in initial; list all message ids (`messages.list`, ids only); delete cached messages missing from the server list; refetch `minimal` for cached ids still present (labels), newest first; reset backfill so uncached mail is fetched. (Cached spam/trash gets dropped because `messages.list` excludes it; acceptable.)
8. **Category counts:** labels table counters (`messages_*`, new `threads_*`) refreshed from `labels.get` for `INBOX` + the five `CATEGORY_*` labels on every incremental sync with changes; tab counts for All Inboxes computed locally (threads in `INBOX ∩ CATEGORY_x ∩ UNREAD`).
9. **Send commands** (compose, "Send again" confirmation UI) arrive in Phase 7; Phase 4 ships the tested service API (`queue_send`, `resend`) and the outbox states.
10. **Plan review fixes (Sol round 1, all accepted):**
    - S1: a send is persisted as `checking` **before** `send_message` is called, so a crash mid-send is recovered by confirmation checks, never an automatic resend. Unsent errors (`Offline`, `RateLimit`, `Auth`) move it back to `pending`.
    - S2: every confirmation path requires `SENT` (cache/sync: message has `SENT`; search: `rfc822msgid:<id> in:sent`), so a draft with the same Message-ID can't confirm a send.
    - S3: `match_sends` runs inside the same transaction that writes messages and the history cursor; labels and counters are refreshed on every incremental sync (cheap: 1 list + 6 gets), so a failed refresh heals on the next one.
    - S4: one per-account async write lock (`write_lock: Arc<tokio::sync::Mutex<HashSet<String>>>`, the set holding tombstones) wraps every sync/backfill write transaction; backfill checks tombstones under it, immediately before inserting. Tombstones clear when backfill completes.
    - S5: loading bodies writes only body fields (`messages::set_body`, attachments, `has_attachment`) and recomputes the thread; labels and flags are left alone.
    - S6: thread ops record thread ids and `created_at`. At execution, each thread's membership is fetched (`get_thread(Minimal)`) and every message with `internalDate <= created_at` is included with the recorded ones, so uncached older messages are archived too and later arrivals are not.
    - S7: complete enumeration (backfill, reconcile) uses `includeSpamTrash=true` (`GmailClient::list_all_messages`).
11. **Frontend slice:** typed wrappers + events, `mailStore` loads `list_threads` for the active mailbox and reloads on `sync:messages_updated`; `ListPane` renders store data (preview mock returns fixtures in the same shape). Thread view, All Mail (`ALL`) and actions stay fixture/"not yet" until Phase 6.

## Review Focus

1. Account removed while its sync/backfill is running → no panic, no error toast loop; the loop drops the account (FK failures are swallowed for unknown accounts). Test in Task 8.
2. History page 2 fails (network) after page 1 succeeded → nothing applied, `history_id` unchanged, next sync retries from the same id. Test in Task 5.
3. `messagesAdded` for a message deleted before we fetch it (404) → treated as deleted, sync still succeeds. Test in Task 5.
4. Message permanently deleted while a backfill page is in flight → not resurrected (manager keeps recent deletes per account; backfill skips them). Test in Task 6.
5. App offline for hours with queued ops → ops stay `pending`, order preserved, one transient failure stops later ops for that account only; other accounts proceed. Test in Task 7.

---

## File Structure

- Create `src-tauri/src/db/migrations/002_sync.sql` — schema below.
- Create `src-tauri/src/db/outbox.rs` — outbox + outbox_messages CRUD.
- Create `src-tauri/src/db/sync_state.rs` — per-account backfill/sync bookkeeping.
- Modify `src-tauri/src/db/messages.rs` — `rfc822_message_id`, executor-generic writes, label set update, lookups.
- Modify `src-tauri/src/db/threads.rs` — new columns, `recompute_threads`, `unread_counts`.
- Modify `src-tauri/src/db/labels.rs` — `threads_*` columns, `replace_labels`.
- Modify `src-tauri/src/gmail/{error.rs,client.rs,messages.rs}` — `GmailError::Offline`, `batch_modify_messages`, `search_messages`.
- Create `src-tauri/src/sync/api.rs` — `MailApi` trait + `GmailClient` impl.
- Create `src-tauri/src/sync/fake.rs` (`#[cfg(test)]`) — `FakeGmail`.
- Create `src-tauri/src/sync/convert.rs` — `ParsedMessage` → rows; `derive_thread`.
- Create `src-tauri/src/sync/events.rs` — `SyncEvent`, `SyncEvents`, `RecordingEvents` (test).
- Replace `src-tauri/src/sync/engine.rs` — initial, incremental, reconcile, backfill step, load bodies.
- Delete `src-tauri/src/sync/history.rs` (stub; history handling lives in engine).
- Create `src-tauri/src/sync/outbox.rs` — enqueue, rebase, process, rollback, send safety.
- Create `src-tauri/src/sync/manager.rs` — `SyncManager`.
- Create `src-tauri/src/mail.rs` — `MailService` + camelCase DTOs.
- Modify `src-tauri/src/lib.rs`, `src-tauri/src/commands/{threads.rs,labels.rs,mod.rs}`, create `src-tauri/src/commands/sync.rs`.
- Frontend: `src/lib/tauri.ts`, `src/store/mailStore.ts` (+ test), `src/shell/ListPane.tsx`, `src/preview/install.ts`, `src/App.tsx` (event subscription), docs (`CLAUDE.md` current state + schema summary).

### Schema (`002_sync.sql`)

```sql
ALTER TABLE messages ADD COLUMN rfc822_message_id TEXT;
CREATE INDEX idx_messages_rfc822 ON messages(account_id, rfc822_message_id);

ALTER TABLE threads ADD COLUMN from_name TEXT;      -- latest message's sender
ALTER TABLE threads ADD COLUMN from_address TEXT;
ALTER TABLE threads ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;

ALTER TABLE labels ADD COLUMN threads_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labels ADD COLUMN threads_unread INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_state (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  backfill_page_token TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  backfill_bodies_done INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER
);

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,               -- pending_op_id and idempotency key (uuid v4)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'modify' | 'trash' | 'send'
  payload TEXT NOT NULL,                 -- JSON: modify {add,remove}; send {raw}
  status TEXT NOT NULL,                  -- 'pending' | 'checking' | 'unconfirmed' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,  -- unix ms
  checks_done INTEGER NOT NULL DEFAULT 0,      -- sends: completed Sent searches
  rfc822_message_id TEXT,                -- sends: client-generated Message-ID
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_outbox_account ON outbox(account_id, seq);

-- Messages an op targets, with rollback data.
CREATE TABLE outbox_messages (
  op_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  prior_label_ids TEXT NOT NULL,         -- JSON array before the op
  PRIMARY KEY (op_id, message_id)
);
CREATE INDEX idx_outbox_messages_thread ON outbox_messages(account_id, thread_id);
```

Completed ops are deleted (cascade clears `outbox_messages`).

---

### Task 1: Schema + DB layer

**Files:** migration, `db/outbox.rs`, `db/sync_state.rs`, `db/messages.rs`, `db/threads.rs`, `db/labels.rs`, `db/mod.rs` (tests), `.sqlx/`.

**Interfaces — Produces** (all `anyhow::Result`; writes take `&mut SqliteConnection` so callers can batch them in one transaction; reads take `impl SqliteExecutor` or `&SqlitePool`):
- `DbMessage` gains `rfc822_message_id: Option<String>`; `DbThread` gains `from_name`, `from_address: Option<String>`, `is_starred: i64`; `DbLabel` gains `threads_total`, `threads_unread: i64`.
- `messages::upsert_message_tx(conn, &DbMessage)` (existing body-preserving upsert, also stores `rfc822_message_id`), keep `upsert_message(pool, ..)` as a wrapper.
- `messages::insert_message_if_absent(conn, &DbMessage) -> bool` (true if inserted).
- `messages::set_labels(conn, account_id, message_id, &[String]) -> bool` — writes `label_ids` JSON, `is_read = !UNREAD`, `is_starred = STARRED`; false if missing.
- `messages::label_map(conn, account_id, &[String]) -> HashMap<String, (String /*thread*/, Vec<String>)>`.
- `messages::thread_ids_of(conn, account_id, &[String]) -> HashMap<String, String>`; `messages::existing_ids(conn, account_id, &[String]) -> HashSet<String>`; `messages::all_ids(pool, account_id) -> Vec<(String, String, i64)>` (id, thread, date) newest first; `messages::delete_tx(conn, account_id, id)`.
- `messages::find_by_rfc822(conn, account_id, &str) -> Option<String>`.
- `attachments::replace_for_message(conn, account_id, message_id, &[DbAttachment])`.
- `threads::recompute_threads(conn, account_id, &[String]) -> RecomputeResult { created, updated, removed: Vec<String> }` — loads each thread's messages, calls `sync::convert::derive_thread`, upserts the thread + replaces `thread_labels`, deletes threads with no messages.
- `threads::unread_counts(pool, &[String] account_ids) -> Vec<(String /*label*/, i64)>` — unread thread counts for `INBOX` and `INBOX ∩ CATEGORY_{PERSONAL,SOCIAL,PROMOTIONS,UPDATES,FORUMS}` across the given accounts.
- `labels::replace_labels(conn, account_id, &[DbLabel])` — upsert all, delete local labels not in the set; `labels::update_counts(conn, account_id, label_id, messages_total, messages_unread, threads_total, threads_unread)`.
- `sync_state::{get(pool, account) -> DbSyncState, reset_backfill(conn, account), save_backfill(conn, account, token: Option<&str>, bodies_done: bool, complete: bool), touch(conn, account, now)}`.
- `outbox::{insert(conn, &DbOp, &[DbOpMessage]), pending_for_account(pool, account) -> Vec<DbOp>` (status pending/checking ordered by seq), `ops_touching_threads(conn, account, &[thread]) -> Vec<(DbOp, Vec<DbOpMessage>)>` (status pending only, seq order), `messages_of(conn, op_id)`, `delete(conn, op_id)`, `update_status(conn, op_id, status, attempts, next_attempt_at, checks_done, last_error)`, `unconfirmed_sends(conn, account) -> Vec<DbOp>` (kind send, status checking|unconfirmed), `get(pool, op_id)`}.

`derive_thread` (Task 3) must exist for `recompute_threads`; implement Task 3's `convert.rs` first within this task if convenient, or stub-then-fill — tests for `recompute_threads` live here.

- [ ] Step 1: tests in `db/mod.rs`: `migration_002_adds_sync_tables` (tables `outbox`, `outbox_messages`, `sync_state` exist; `messages.rfc822_message_id` column exists); `recompute_threads_derives_labels_and_deletes_empty` (two messages, one `[INBOX,UNREAD]` one `[SENT]` → thread labels `INBOX,SENT,UNREAD`, `unread_count == 1`; delete both messages → thread removed, returned in `removed`); `trashed_message_only_contributes_trash` (messages `[INBOX]` and `[INBOX,TRASH]` → labels `INBOX,TRASH`; only the trashed one → labels `TRASH`); `unread_counts_across_accounts` (acct-1 thread INBOX+CATEGORY_PERSONAL+UNREAD, acct-2 thread INBOX+CATEGORY_SOCIAL+UNREAD, acct-2 read thread → INBOX 2, CATEGORY_PERSONAL 1, CATEGORY_SOCIAL 1); `outbox_cascades_messages_and_orders_by_seq`; `set_labels_updates_flags` (`[STARRED]` → is_read 1, is_starred 1; `[UNREAD]` → is_read 0).
- [ ] Step 2: run `heavy cargo test db::` — fails.
- [ ] Step 3: migration + functions above; update existing tests/constructors for new fields.
- [ ] Step 4: `heavy cargo test db::` passes; `cargo sqlx prepare -- --all-targets` with `DATABASE_URL` pointed at a migrated scratch DB under `$TMPDIR`.
- [ ] Step 5: commit `feat(db): sync schema — outbox, sync state, thread sender/star`.

### Task 2: Gmail client additions

**Files:** `gmail/error.rs`, `gmail/client.rs`, `gmail/messages.rs`, `gmail/fixtures/` if needed.

**Produces:**
- `GmailError::Offline(String)` — the request never reached Gmail (connect failure after retries). `code() == "network"`.
- `GmailClient::batch_modify_messages(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<(), GmailError>` — `POST messages/batchModify`, chunks of 1000.
- `GmailClient::search_messages(&self, q: &str, page_token: Option<&str>, max_results: u32) -> Result<MessageListResponse, GmailError>` — `messages.list` with `q`.

- [ ] Step 1: wiremock tests: `connect_failure_is_offline` (base URL `http://127.0.0.1:1`, `fast_retry`, `send_message` → `GmailError::Offline`); `batch_modify_posts_ids_and_labels` (body matches `{"ids":[..],"addLabelIds":["STARRED"],"removeLabelIds":["INBOX"]}`); `batch_modify_chunks_over_1000` (1001 ids → 2 requests); `search_messages_passes_q` (`q=rfc822msgid:<a@b>`).
- [ ] Step 2: fail. Step 3: implement (in `execute`, a send error with `e.is_connect()` when out of retries returns `Offline`). Step 4: pass. Step 5: commit `feat(gmail): batchModify, search, offline error`.

### Task 3: MailApi trait, FakeGmail, conversion, events

**Files:** `sync/mod.rs`, `sync/api.rs`, `sync/fake.rs`, `sync/convert.rs`, `sync/events.rs`.

**Produces:**
```rust
#[async_trait] pub trait MailApi: Send + Sync {
  async fn profile_history_id(&self) -> Result<String, GmailError>;
  async fn list_labels(&self) -> Result<Vec<Label>, GmailError>;
  async fn get_label(&self, id: &str) -> Result<Label, GmailError>;
  async fn list_threads(&self, label: &str, page_token: Option<&str>, max: u32) -> Result<ThreadListResponse, GmailError>;
  async fn get_thread(&self, id: &str, format: MessageFormat) -> Result<Thread, GmailError>;
  async fn list_messages(&self, page_token: Option<&str>, max: u32) -> Result<MessageListResponse, GmailError>;
  async fn search_messages(&self, q: &str) -> Result<MessageListResponse, GmailError>;
  async fn batch_get_messages(&self, ids: &[String], format: MessageFormat) -> Vec<(String, Result<Message, GmailError>)>;
  async fn list_history(&self, start: &str, page_token: Option<&str>) -> Result<HistoryListResponse, GmailError>;
  async fn batch_modify(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<(), GmailError>;
  async fn trash_message(&self, id: &str) -> Result<(), GmailError>;
  async fn send_message(&self, raw: &str) -> Result<String /*gmail id*/, GmailError>;
}
```
- `impl MailApi for GmailClient` (delegation).
- `FakeGmail` (test-only): an in-memory mailbox (`Mutex<State>`) with `add_message(FakeMsg)`, `set_labels`, `delete`, a history log (`history_id` counter; every mutation appends a record), `expire_history_before(id)`, `fail_next(method: &'static str, GmailError)` queue, call counters, `sent: Vec<String>` raws, and `respond_send_then_fail(GmailError)` (records the send then returns the error, to model ambiguous failure). Messages are built with a `payload` carrying `From`, `Subject`, `Message-ID`, `Date` headers and a text body, honouring `MessageFormat` (minimal: no payload; metadata: headers only; full: headers + body). `search_messages` supports `rfc822msgid:<id>` only. `list_messages` is newest first and excludes TRASH/SPAM.
- `convert::to_db_message(account_id, &ParsedMessage, fully_fetched: bool) -> (DbMessage, Vec<DbAttachment>)`; `convert::derive_thread(account_id, thread_id, &[DbMessage]) -> Option<(DbThread, Vec<String>)>` — subject of the earliest message, snippet/from/date of the latest, counts, `is_starred` if any starred, labels per Builder's call 6.
- `events::SyncEvent` enum: `Started{account_id}`, `MessagesUpdated{account_id, added, removed, modified: Vec<String>}` (thread ids), `LabelsUpdated{account_id}`, `Completed{account_id}`, `Error{account_id, code, message}`, `OpRejected{account_id, op_id, kind, message}`, `SendStatus{account_id, op_id, status}`; `fn name(&self) -> &'static str`; `#[serde(rename_all_fields = "camelCase", untagged)]`-style payload (no tag). `pub trait SyncEvents: Send + Sync { fn emit(&self, event: SyncEvent); }`; `NoopEvents`; test `RecordingEvents` with `take() -> Vec<SyncEvent>`.

- [ ] Step 1: tests: `derive_thread_picks_latest_sender_and_earliest_subject`; `to_db_message_metadata_has_no_body`; `event_names_and_camel_case_payload` (`MessagesUpdated` serializes `{"accountId":..,"added":[..],..}`, name `sync:messages_updated`); `fake_history_records_label_changes`.
- [ ] Step 2–4: fail, implement, pass. Step 5: commit `feat(sync): MailApi seam, fake Gmail, row conversion, events`.

### Task 4: Initial sync + labels + load bodies

**Files:** `sync/engine.rs`.

**Produces:** `pub struct SyncEngine { db: SqlitePool, api: Arc<dyn MailApi>, account_id: String, events: Arc<dyn SyncEvents> }` with:
- `pub async fn run_initial_sync(&self) -> Result<(), SyncError>` — emit Started; `h = profile_history_id()`; `sync_labels()`; `threads.list(INBOX, 50)` + `get_thread(Full)` each (buffer_unordered 10); one transaction: upsert messages/attachments, `recompute_threads`, `outbox::rebase` (Task 7 — call a `rebase_threads` that is a no-op until Task 7 lands), `update_history_id(h)`, `sync_state::reset_backfill`; emit MessagesUpdated, LabelsUpdated, Completed.
- `async fn sync_labels(&self, refresh_counts: bool)` — `list_labels` → `replace_labels`; when `refresh_counts`, `get_label` for `INBOX` + 5 categories → `update_counts`.
- `pub async fn load_thread_bodies(&self, thread_id: &str) -> Result<(), SyncError>` — fetch `Full` for that thread's messages with `fully_fetched = 0`; upsert; errors from the network are returned (caller shows cache).
- `SyncError` (`thiserror`): `Gmail(GmailError)`, `Db(anyhow::Error)`, with `code()` (`history_expired`/`network`/`auth`/… from GmailError, `internal` for Db).
- Constants: `INITIAL_THREADS: u32 = 50`, `FULL_BODY_DAYS: i64 = 180`, `BACKFILL_PAGE: u32 = 500`, `CATEGORY_LABELS: [&str; 5]`.

- [ ] Step 1: tests (FakeGmail + temp DB): `initial_sync_caches_inbox_threads_and_history_id` (3 inbox threads, one with a SENT reply → 3 threads listed under INBOX via `threads::list_threads`, reply cached, `accounts.history_id == profile id before sync`, events order Started…Completed); `initial_sync_stores_labels_and_category_counts`; `load_thread_bodies_fetches_unfetched_only` (metadata-only message gets body, already-full one isn't refetched — assert fake call count).
- [ ] Step 2–4. Step 5: commit `feat(sync): initial sync`.

### Task 5: Incremental sync + expiry reconcile

**Produces:**
- `pub async fn run_incremental_sync(&self) -> Result<SyncOutcome, SyncError>` (`SyncOutcome { changed: bool }`). No stored id → `run_initial_sync`. Page `list_history` fully into memory first (any page error → return error, apply nothing). Fold records in order into per-message intent: `Fetch` / `Delete{thread}` / `Labels(Vec<String>)` (delta applied to the cached set, or to the set carried by the record when uncached → `Fetch`). Fetch `Full` in one `batch_get_messages`; 404 → `Delete`. One transaction: deletes, upserts, `set_labels`, `recompute_threads` (affected = union of thread ids before and after), `rebase_threads`, `update_history_id(response.history_id from the last page)`, `sync_state::touch`. Then, if changed: `sync_labels(true)`, `outbox::match_sends` (Task 7; no-op until then), emit MessagesUpdated (added/removed/modified from `RecomputeResult`) and LabelsUpdated. Always emit Started/Completed. Record deleted ids via a `deleted: &Mutex<HashSet<String>>` passed in by the manager (field `recent_deletes: Arc<Mutex<HashSet<String>>>` on `SyncEngine`).
- `history_expired` (`GmailError::is_history_expired`) → `pub async fn run_full_resync(&self)` per Builder's call 7, emits the same events.

- [ ] Step 1: tests: `incremental_applies_added_deleted_and_label_changes`; `incremental_stores_top_level_history_id` (record ids < response id → stored = response id); `incremental_paginates_all_pages`; `incremental_failed_second_page_applies_nothing` (Review Focus 2); `added_then_deleted_before_fetch_is_ignored` (Review Focus 3: fake returns 404 for the id); `history_expiry_reconciles_existing_cache` (expire history; server deleted one cached message and archived another → after sync the deleted one is gone, the archived one left INBOX, a new server message appears after backfill reset, history id = new profile id, no error event); `incremental_refreshes_category_counts`.
- [ ] Step 2–4. Step 5: commit `feat(sync): incremental sync and history-expiry reconcile`.

### Task 6: Backfill

**Produces:** `pub async fn backfill_step(&self) -> Result<BackfillProgress, SyncError>` (`enum BackfillProgress { More, Done }`): load `sync_state`; if complete → `Done`. `list_messages(token, 500)`; skip ids already cached or in `recent_deletes`; fetch `Full` unless `backfill_bodies_done` else `Metadata`; one transaction: `insert_message_if_absent` (+ attachments), `recompute_threads`, `rebase_threads`, `save_backfill(next, bodies_done || oldest_date_on_page < now-180d, next.is_none())`. Emit MessagesUpdated if anything was inserted.

- [ ] Step 1: tests: `backfill_pages_until_done_and_switches_to_metadata` (fake: 3 pages; page 2's oldest is 200 days old → page 3 fetched as metadata, `fully_fetched = 0`; returns `Done` on the last); `backfill_does_not_overwrite_newer_cache` (message already cached with labels `[INBOX]`, server copy `[]` → stays `[INBOX]`); `backfill_skips_recent_deletes` (Review Focus 4).
- [ ] Step 2–4. Step 5: commit `feat(sync): background backfill with body window`.

### Task 7: Outbox — optimistic ops, rebase, rollback, send safety

**Files:** `sync/outbox.rs` (+ wire `rebase_threads`/`match_sends` into engine).

**Produces:**
- `pub async fn enqueue_modify(pool, account_id, thread_ids: &[String], add: &[String], remove: &[String]) -> Result<EnqueueResult>` and `enqueue_trash(pool, account_id, thread_ids)`. One transaction: resolve the threads' cached message ids, snapshot each message's labels into `outbox_messages`, insert op (`status pending`), apply the delta locally (`set_labels`), `recompute_threads`. `EnqueueResult { op_id, threads: RecomputeResult }`. No messages → no op.
- `pub async fn rebase_threads(conn, account_id, thread_ids) -> Result<()>` — for pending modify/trash ops touching those threads (seq order), re-apply each op's delta to its recorded messages that still exist; then recompute. Engine calls it inside its write transactions (before its own final recompute, or recompute once after).
- `pub async fn process(pool, api: &dyn MailApi, account_id, events, now_ms) -> Result<()>` — ops in seq order. `modify` → `batch_modify(ids,…)`; `trash` → `trash_message` per id (404 = done). Success → delete op. Classification `fn classify(&GmailError) -> Failure { Transient, Rejected }`: `Offline | Network | RateLimit | Auth | Api 5xx | Decode` → Transient (attempts+1, `next_attempt_at = now + min(5 s · 2^attempts, 5 min)`, **stop** processing this account); `Api` 4xx (except 429) → Rejected → `rollback`, emit OpRejected, continue. Ops whose `next_attempt_at > now` block later ops (order).
- `async fn rollback(pool, api, op)` per Builder's call 5.
- Sends: `pub async fn queue_send(pool, account_id, raw_rfc822: &[u8]) -> Result<String /*op id*/>` — reuse an existing `Message-ID` header or prepend `Message-ID: <{uuid}@pheeme.app>\r\n`; store base64url raw in payload and the id (with brackets) in `rfc822_message_id`. Processing a `pending` send: `send_message` → Ok: delete op, emit SendStatus `sent`. `Offline | RateLimit | Auth` → stay `pending` with backoff (safe: never delivered). `Network | Api 5xx | Decode` → `checking`, `checks_done = 0`, `next_attempt_at = now + 30 s`, emit SendStatus `checking`; **never auto-resend**. `Api 4xx` → `failed`, `last_error`, emit SendStatus `failed`. `checking` due: first `messages::find_by_rfc822` in cache → done; else `search_messages("rfc822msgid:<id>")`: match → done; search error → retry in 30 s without advancing; no match → `checks_done += 1`, next delay from `[30 s, 120 s, 600 s][checks_done]`, after the 3rd → `unconfirmed` (emit). Sends in `checking`/`unconfirmed`/`failed` don't block other ops.
- `pub async fn match_sends(conn, account_id, new_rfc822_ids: &[String]) -> Vec<String /*op ids done*/>` — called by incremental sync (and initial/backfill) for every inserted message's Message-ID; matching `checking`/`unconfirmed` sends are deleted and SendStatus `sent` emitted by the caller.
- `pub async fn resend(pool, op_id) -> Result<()>` — only from `unconfirmed` or `failed`: back to `pending`, same Message-ID, `checks_done = 0`.

- [ ] Step 1: tests: `enqueue_archive_applies_locally_and_persists_op`; `op_survives_restart_and_replays_in_order` (two ops on one thread: star then archive; reopen pool; process → fake received batchModify calls in order; thread not in INBOX, starred); `incremental_sync_during_in_flight_op_keeps_optimistic_state` (enqueue archive; fake still has INBOX; incremental sync with an unrelated label change on that message → still not in INBOX, unrelated change applied); `history_record_from_own_op_is_noop`; `new_message_in_thread_after_archive_is_not_archived`; `rejected_op_rolls_back_with_later_ops_reapplied` (ops A=star, B=archive; fake rejects A with 400 → star removed, archive kept, OpRejected emitted); `network_failure_keeps_op_pending_and_blocks_later_ops` (Review Focus 5, includes a second account that proceeds); `ambiguous_send_never_resends_and_confirms_via_search` (fake records send then returns Network; process at t, t+30 s with search error (no advance), t+60 s match → op deleted, `fake.sent.len() == 1`); `unconfirmed_send_cleared_by_sync` (3 completed empty searches → `unconfirmed`; message with that Message-ID arrives via history → op gone, SendStatus `sent`); `send_4xx_fails_and_resend_reuses_message_id`; `offline_send_stays_pending`.
- [ ] Step 2–4. Step 5: commit `feat(sync): persisted outbox with optimistic ops and safe sends`.

### Task 8: SyncManager, MailService, commands, events wiring

**Files:** `sync/manager.rs`, `mail.rs`, `lib.rs`, `commands/{threads,labels,sync,mod}.rs`, `accounts.rs` (`AccountService` becomes `Arc`-shared; `remove_account` unchanged).

**Produces:**
- `SyncManager::new(db, api_for: Arc<dyn Fn(&str) -> Arc<dyn MailApi> + Send + Sync>, events: Arc<dyn SyncEvents>) -> Arc<Self>`. Production factory: `GmailClient::new(Arc::new(AccountTokens::new(accounts.clone(), id)))`, cached per account.
- `pub async fn sync_account(&self, account_id) -> Result<(), SyncError>` — per-account `tokio::Mutex`; `outbox::process`, then `run_incremental_sync`, then `outbox::process` again if anything was due; afterwards ensure a backfill task is running for the account. Errors → emit `sync:error {accountId, code, message}`; an account that no longer exists in `accounts` is dropped silently (Review Focus 1).
- `pub fn trigger(self: &Arc<Self>, account_id: Option<String>)` — spawn; coalesces (if a sync for the account is running, mark dirty and run once more after).
- `pub fn trigger_focus(self: &Arc<Self>)` — `trigger(None)` unless the last focus trigger was < 15 s ago.
- `pub fn start(self: &Arc<Self>)` — spawn the loop: sync all accounts now, then every 90 s (`SYNC_INTERVAL`).
- Backfill task per account: loop `backfill_step` with `BACKFILL_PAUSE = 1 s`; stops on `Done`, error (retried on next sync), or account removal.
- `MailService { db, sync: Arc<SyncManager> }`: `list_threads(ThreadListArgs) -> ThreadPageDto`, `get_thread(account_id, thread_id) -> ThreadDetailDto` (calls `load_thread_bodies`, ignoring network errors), `list_labels(account_id) -> Vec<LabelDto>`, `mailbox_counts(account_ids) -> Vec<CountDto>`, `modify_threads(account_id, thread_ids, add, remove)` / `trash_threads(account_id, thread_ids)` (enqueue → emit MessagesUpdated for the local change → `sync.trigger(account)`). DTOs camelCase; `ThreadSummaryDto { id, accountId, subject, snippet, fromName, fromAddress, date, unread, starred, hasAttachment, messageCount }` (same field names as `FixtureThread`).
- Commands: `list_threads`, `get_thread`, `list_labels`, `mailbox_counts`, `modify_threads`, `trash_threads`, `sync_now(account_id: Option<String>)`. `complete_oauth` triggers a sync for the new account. `lib.rs`: `AppState { db, accounts: Arc<AccountService>, mail: MailService, sync: Arc<SyncManager> }`; `build_state(data_dir, secrets, events)`; `TauriEvents(AppHandle)` emits `event.name()` with the payload; window `Focused(true)` → `trigger_focus`; `sync.start()` in `setup`.

- [ ] Step 1: tests: `manager_drops_removed_account_without_error_event` (delete the account row mid-loop; no `Error` event, no panic); `trigger_coalesces_concurrent_requests` (fake counts `list_history` ≤ 2 for 5 concurrent triggers); `list_threads_dto_matches_fixture_shape` (serialize → keys equal the FixtureThread keys minus `mailbox`, `body`); `modify_threads_emits_and_triggers`.
- [ ] Step 2–4. `heavy cargo clippy --all-targets -- -D warnings`. Step 5: commit `feat(sync): manager, mail service, commands`.

### Task 9: Frontend slice + docs

**Files:** `src/lib/tauri.ts`, `src/store/mailStore.ts`, `src/store/mailStore.test.ts`, `src/shell/ListPane.tsx`, `src/preview/install.ts`, `src/App.tsx`, `CLAUDE.md`.

**Produces:** wrappers `listThreads(args)`, `getThread`, `listLabels`, `mailboxCounts`, `modifyThreads`, `trashThreads`, `syncNow`; types `ThreadSummary`, `ThreadPage`, `SyncEventName`; `useMailStore` with `threads`, `next`, `load(accountIds, labelId, alsoLabelId?)`, `subscribe()` (listens to `sync:messages_updated` / `sync:completed` and reloads the current query). ListPane renders `useMailStore` threads (accounts from `accountStore`), keeps its UX. Preview mock `list_threads` returns `{ threads: ThreadSummary[], next: null }` from fixtures.

- [ ] Step 1: `mailStore.test.ts`: `loads threads for the active mailbox across accounts` (mock invoke receives `{ accountIds: [a,b], labelId: "INBOX" }`); `reloads on sync:messages_updated`. Existing `AppShell`/`App` tests keep passing in preview mode.
- [ ] Step 2–4: `npm run typecheck && npm run lint && npm run test:ci`.
- [ ] Step 5: update `CLAUDE.md` (current state, schema summary: 9 tables incl. outbox, sync_state; `sync/` module table). Commit `feat(ui): list pane reads from the sync cache`.
