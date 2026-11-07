# Slow-open indicator and Send diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening an uncached email shows what it's waiting on (and fetches ahead of background sync); users can send a scrubbed diagnostics bundle from Settings › About to a Cloudflare Worker that stores it and emails Alex.

**Architecture:** A tokio task-local *request probe* lets `GmailClient::execute` report slot/quota waits, retries and statuses for a user-opened thread without changing the `MailApi` trait; the same probe upgrades those requests to `Priority::Interactive`. `MailService::get_thread` emits `mail:thread_loading` stage events, logs one timing line per open and keeps the last 50 timings. A Tauri-free `support` module scrubs logs, builds a zip and uploads it (multipart) to `diagnostics.pheeme.email`, a dependency-free TypeScript Worker (R2 + `send_email` + rate-limit binding + a Durable Object daily counter).

**Tech Stack:** Rust (tokio, reqwest 0.12, zip, regex), React 18 + Zustand, Cloudflare Workers (TypeScript, wrangler).

**Spec:** `docs/superpowers/specs/2026-11-06-send-diagnostics-design.md`

## Global Constraints

- Endpoint: `https://diagnostics.pheeme.email/v1/upload` (Rust const `DIAGNOSTICS_URL`, overridable by env `PHEEME_DIAGNOSTICS_URL` for testing).
- Upload cap 5 MB (Worker rejects > 5 MB with 413; app keeps the zip ≤ 4.5 MB by trimming oldest log text).
- Notifications from `diagnostics@pheeme.email` to `ajg0360@gmail.com`, Reply-To = sender address. Zip **not** attached.
- R2 retention: lifecycle rule 30 days; user-facing copy says "about 30 days".
- Loading UI appears after 300 ms; "Taking too long? Send diagnostics" link after 15 s.
- Logs/bundles never contain email bodies, subjects, snippets, search terms, or addresses other than the user's own account addresses. The user's note is sent as typed and the UI says so.
- Command errors are `CommandError { code, message }`. New commands register in `lib.rs` and get wrappers in `src/lib/tauri.ts` and fixtures in `src/preview/`.
- Design tokens only in CSS (`npm run lint` checks). Copy is plain English, sentence case.
- Nothing is deployed to Cloudflare by the builders.

## Shared contract (all tasks rely on these exact names)

Rust → frontend:
- `get_thread(accountId, threadId, opened?: boolean)` — `opened` true for a user-initiated open (not prefetch).
- `ThreadDetailDto.bodyError: { code: string; message: string } | null` — set when bodies were missing and fetching them failed; `message` is user-facing and URL-free.
- Event `mail:thread_loading`, payload `ThreadLoading`:
  `{ accountId: string; threadId: string; stage: "queued" | "fetching" | "retrying" | "done"; attempt: number | null; retryInMs: number | null; reason: "rate_limited" | "network" | "server" | null; syncBusy: boolean }`
  (`syncBusy`: initial sync or backfill running for that account).
- `send_diagnostics(note: string, replyTo: string | null) -> void`; error codes `rate_limited`, `network`, `rejected`, `too_large`.
- `save_diagnostics(note: string, replyTo: string | null, path: string) -> void`.

App → Worker: `POST /v1/upload`, `multipart/form-data` with field `meta` (JSON `{ version, os, arch, replyTo: string|null, note: string (≤ 2000 chars), highlights: string[] (≤ 20) }`) and field `bundle` (`application/zip`). Responses: `204` stored; `400` malformed; `413` too large; `429` (+`Retry-After`) rate limited or daily cap; `5xx` failure.

Bundle zip layout: `summary.json`, `logs/pheeme.log` (concatenated newest-last, scrubbed, trimmed).

## Review Focus

1. Cached open (bodies present): no loading UI flash, no `mail:thread_loading` events, timing logged at `debug` only — test in Task 1 and Task 3.
2. Opening while offline: cached headers still render, `bodyError` carries "offline" reason, Try again works — Task 1 test `get_thread_reports_body_error_offline`, Task 3 test.
3. Prefetch (`opened` false) stays at Sync priority and emits no events — Task 1 test.
4. A log line with a search URL `…/messages?q=from%3Abob%40x.com` and a correspondent's address is scrubbed but the user's own address survives — Task 2 test.
5. Worker over daily cap or rate limit returns 429 and stores/sends nothing; app shows the reason and offers Save — Task 4 and Task 3 tests.

---

### Task 1: Probe, interactive priority, stage events, open timing (Rust)

**Files:**
- Create: `src-tauri/src/gmail/probe.rs` (register in `gmail/mod.rs`)
- Modify: `src-tauri/src/gmail/client.rs` (`execute`), `src-tauri/src/mail.rs` (`get_thread`, `ThreadDetailDto`), `src-tauri/src/commands/threads.rs`, `src-tauri/src/sync/events.rs` (new event), `src-tauri/src/sync/manager.rs` (expose `sync_busy(account_id) -> bool` from `run_lock`/`backfilling`), `src-tauri/src/diagnostics.rs` (timing buffer)

**Interfaces — Produces:**
- `gmail::probe::{RequestProbe, ProbeStage, with_probe}`:
  - `pub struct RequestProbe` (atomics/mutex inside) built by `RequestProbe::new(on_stage: impl Fn(ProbeStage) + Send + Sync + 'static) -> Arc<Self>`, with `snapshot() -> ProbeStats { slot_wait_ms, quota_wait_ms, gmail_ms, requests, retries, last_status: Option<u16>, last_reason: Option<String> }`.
  - `pub enum ProbeStage { Queued, Fetching, Retrying { attempt: u32, retry_in: Duration, reason: RetryReason } }`, `RetryReason { RateLimited, Network, Server }`.
  - `pub async fn with_probe<F: Future>(probe: Arc<RequestProbe>, f: F) -> F::Output` (tokio `task_local!`).
- In `execute`: when a probe is in scope, `Priority::Sync` is treated as `Interactive` (skip `background_permits`); report `Queued` before acquiring permits, `Fetching` once permits + quota are through, `Retrying{..}` before each backoff sleep; accumulate waits/statuses.
- `SyncEvent::ThreadLoading { account_id, thread_id, stage, attempt, retry_in_ms, reason, sync_busy }` named `"mail:thread_loading"`, serialized to the shared-contract payload.
- `MailService::get_thread(&self, account_id, thread_id, opened: bool)`; `ThreadDetailDto.body_error: Option<BodyErrorDto { code, message }>` (serde camelCase → `bodyError`).
- `diagnostics::OpenTimings` — bounded (50) `Mutex<VecDeque<OpenTiming>>` held by `MailService`, `pub fn recent(&self) -> Vec<OpenTiming>`; `OpenTiming { at_ms, source: "cache"|"gmail", total_ms, slot_wait_ms, quota_wait_ms, gmail_ms, retries, last_status, last_reason, messages_fetched, sync_busy, outcome }` (Serialize).

- [ ] **Step 1: Failing tests.** In `gmail/client.rs` tests (wiremock): `probe_upgrades_sync_requests_to_interactive` (hold all 8 background permits with slow mocked responses, then a probed `batch_get_messages` completes without waiting); `probe_reports_retry_stage_and_stats` (first response 429 with `Retry-After: 1`, then 200 → stages `[Queued, Fetching, Retrying{attempt:0, reason:RateLimited,..}, Fetching]`, `retries == 1`, `last_status == Some(429)`). In `mail.rs` tests (FakeGmail): `opened_get_thread_emits_loading_events_and_records_timing` (missing body → events include `fetching` then `done`, `recent()` has one `source: "gmail"` entry); `cached_get_thread_emits_nothing` (bodies present → no `ThreadLoading` events, timing `source: "cache"`); `prefetch_get_thread_emits_nothing` (`opened = false`); `get_thread_reports_body_error_offline` (fake returns `GmailError::Offline` → `Ok` with cached rows and `body_error.code == "offline"`, message contains no `http`).
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml probe_ get_thread` → FAIL (missing items).
- [ ] **Step 3: Implement.** Map `body_error` from the `SyncError`/`GmailError` → reuse the existing `CommandError` code mapping in `commands/mod.rs` so codes match what the UI already branches on. Log one `info` line `"thread opened"` with the `OpenTiming` fields when `source == "gmail"` or `total_ms > 1000`, else `debug`. `done` is emitted (opened only) after bodies are stored or the attempt failed. Update the command: `get_thread(state, account_id, thread_id, opened: Option<bool>)`.
- [ ] **Step 4:** Same `cargo test` → PASS; `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` clean.
- [ ] **Step 5:** Commit `feat(mail): fetch opened emails ahead of sync and report what they wait on`.

### Task 2: Scrubbing, bundle, upload and save commands (Rust)

**Files:**
- Create: `src-tauri/src/support/mod.rs`, `support/scrub.rs`, `support/bundle.rs`, `support/upload.rs`, `src-tauri/src/commands/support.rs`
- Modify: `src-tauri/Cargo.toml` (`zip` with deflate only, `regex`, reqwest feature `multipart`), `src-tauri/src/lib.rs` (register commands, keep log dir path in `AppState` as `log_dir: Option<PathBuf>`; replace home dir with `~` in the startup path logs), `src-tauri/src/gmail/client.rs` (`e.without_url()` before Display at the retry warn and in `GmailError::Offline/Network`), `src-tauri/src/db/mod.rs` (path log), `src-tauri/capabilities/default.json` (`dialog:allow-save`)

**Interfaces:**
- Consumes: `OpenTimings::recent()` (Task 1), `SyncManager::sync_busy` (Task 1).
- Produces:
  - `support::scrub::scrub(text: &str, own_addresses: &[String], home: Option<&Path>) -> String` — replaces email addresses not in `own_addresses` (case-insensitive) with `<email>`, query strings of `http(s)` URLs with `?<redacted>`, `q=<…>` up to whitespace/`&` with `q=<redacted>`, the home dir prefix with `~`.
  - `support::bundle::build(input: &BundleInput) -> Result<Vec<u8>, SupportError>`; `BundleInput { note: String, reply_to: Option<String>, summary: serde_json::Value, log_dir: Option<PathBuf>, own_addresses: Vec<String>, max_bytes: usize }` — reads `pheeme.log` and rotated `pheeme.log.N` (oldest first, newest last), takes at most the newest 20 MB of text, scrubs, zips; if the zip exceeds `max_bytes` (4.5 MB), halves the log text (dropping oldest) until it fits.
  - `support::upload::send(url: &str, meta: &UploadMeta, zip: Vec<u8>) -> Result<(), SupportError>`; `SupportError` → `CommandError` codes `rate_limited` (429; message includes "try again later"), `too_large` (413), `rejected` (other 4xx), `network` (connect/timeout/5xx). 60 s timeout, own `reqwest::Client`.
  - Summary builder `support::summary(…) -> serde_json::Value`: `{ version, os, arch, generatedAt, accounts: [{ initialSyncDone, backfillComplete, messages, messagesWithBodies, lastSyncedAt }], quotaPerMinute, recentOpens: OpenTiming[] }` — no addresses in `accounts` (index only). `highlights`: the 5 slowest recent opens as one-line strings like `"38.2 s from Gmail, 3 retries (429 rateLimitExceeded), sync busy"`.
  - Commands `send_diagnostics(note, reply_to)` and `save_diagnostics(note, reply_to, path)`.
- [ ] **Step 1: Failing tests.** `scrub_redacts_correspondents_search_terms_and_home` (input lines: `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Abob%40x.com failed`, `from bob@x.com to me@gmail.com`, `/home/jane/.local/share/app.pheeme.desktop/db.sqlite`; own `["me@gmail.com"]`, home `/home/jane` → no `bob@x.com`, no `from%3A`, contains `me@gmail.com`, contains `~/.local/share`); `bundle_contains_summary_and_newest_logs` (temp log dir with `pheeme.log.1` "old" and `pheeme.log` "new" → zip has `summary.json` and `logs/pheeme.log` with "old" before "new"); `bundle_trims_to_max_bytes` (incompressible random-hex log 10 MB, `max_bytes` 1 MB → zip ≤ 1 MB, newest line kept); `upload_maps_statuses` (wiremock: 204 → Ok, 429 → `rate_limited`, 413 → `too_large`, 400 → `rejected`; request is multipart with `meta` and `bundle` parts); `reqwest_errors_are_logged_without_urls` (Display of the `GmailError` from a connect failure to `http://127.0.0.1:9/x?q=secret` lacks `secret`).
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml support` → FAIL.
- [ ] **Step 3: Implement** per Interfaces. Commands read account emails from the account service for `own_addresses`.
- [ ] **Step 4:** tests PASS; clippy clean; `cargo sqlx prepare --check` if queries were added (run `cargo sqlx prepare` otherwise).
- [ ] **Step 5:** Commit `feat(support): build, scrub and upload a diagnostics bundle`.

### Task 3: Reading-pane loading state and Settings › About diagnostics (frontend)

**Files:**
- Modify: `src/lib/tauri.ts` (contract types + `getThread(accountId, threadId, opened = false)`, `THREAD_LOADING_EVENT`, `sendDiagnostics`, `saveDiagnostics`), `src/store/threadStore.ts` (`loading: Record<ThreadKey, ThreadLoading>`; foreground `load` passes `opened: true`, `prefetch` passes false; `subscribe` also listens to `mail:thread_loading`; entry cleared when the fetch settles or stage is `done`), `src/mail/ThreadView.tsx` (replace `content = null`), `src/mail/EmailBody.tsx` (show `bodyError.message` when present), `src/settings/AboutSettings.tsx`, `src/settings/pages.tsx` (About `keywords` += `diagnostics`, `logs`, `support`, `send`), `src/preview/*` (fixtures for the two commands; `getThread` accepts the extra arg)
- Create: `src/mail/ThreadLoading.tsx` (+ CSS in `mail.css`), `src/settings/DiagnosticsSection.tsx`, tests beside them

**Interfaces — Consumes:** the shared contract above.

Copy (exact):
- default: "Downloading this message from Gmail…"
- `syncBusy` and stage `queued`/`fetching`: "Pheeme is still downloading your mailbox for the first time. This message is next in line."
- `retrying` + `rate_limited`: "Gmail is asking Pheeme to slow down. Retrying in {n} s…"
- `retrying` + `network`/`server`: "Gmail isn't answering. Retrying (attempt {attempt + 1})…"
- after 15 s, link: "Taking too long? Send diagnostics" → `useSettingsStore.getState().openSettings("about")`.
- About section title "Diagnostics"; row "Send diagnostics", description "Sends recent logs to the developer so they can see why something was slow or broken. Logs never include your emails, subjects or contacts. Your note is sent as you type it."; inline form (no nested dialog): textarea "What happened?" (optional, max 2000), "Sent as {address} so the developer can reply" with an account select when there are several, a text field "Your email (so the developer can reply)" when there are none; buttons **Send** and **Save a copy…** (uses `save` from `@tauri-apps/plugin-dialog`, default name `pheeme-diagnostics.zip`). Success: "Sent. Thanks, Alex will take a look." Failure: the error message plus "You can save the file and email it instead." Kept in browser preview too (fixtures succeed).

- [ ] **Step 1: Failing tests.** `ThreadLoading.test.tsx`: renders nothing before 300 ms (fake timers), default copy after 300 ms, first-sync copy with `syncBusy`, rate-limit copy with `retryInMs: 8000` → "Retrying in 8 s", diagnostics link only after 15 s and it calls `openSettings("about")`. `threadStore` test: `load` calls `getThread(…, true)`, `prefetch` calls it with `false`; a `mail:thread_loading` event sets `loading[key]`; settling clears it. `EmailBody` test: `bodyError.message` replaces the generic offline line. `DiagnosticsSection.test.tsx`: Send calls `sendDiagnostics(note, "me@gmail.com")` with the single account's address; a `rate_limited` rejection shows its message and the save hint; no-accounts case sends the typed address.
- [ ] **Step 2:** `npm run test -- ThreadLoading threadStore EmailBody DiagnosticsSection` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm run test`, `npm run typecheck`, `npm run lint`, `npm run format:check` → all pass.
- [ ] **Step 5:** Commit `feat(mail): say what a slow email is waiting on, and send diagnostics from Settings`.

### Task 4: Diagnostics Worker + privacy policy

**Files:**
- Create: `workers/diagnostics/wrangler.jsonc`, `workers/diagnostics/src/index.ts` (entry: wires real bindings incl. `EmailMessage` from `cloudflare:email`, `DailyCap` DO class), `workers/diagnostics/src/handler.ts` (pure: `handleUpload(request: Request, deps: Deps): Promise<Response>`), `workers/diagnostics/src/types.ts` (minimal local interfaces for the R2/ratelimit/DO/email subsets used — no new npm deps), `workers/diagnostics/src/handler.test.ts` (`// @vitest-environment node`), `workers/diagnostics/README.md` (one-time setup: create bucket `pheeme-diagnostics`, lifecycle rule 30 days, verify `ajg0360@gmail.com` in pheeme.email Email Routing, `wrangler deploy`, how to fetch a bundle)
- Modify: `vitest.config.ts` (include `workers/**/*.test.ts`), `tsconfig.json` include `workers` if it typechecks cleanly with DOM lib (else a `workers/diagnostics/tsconfig.json` and add it to `npm run typecheck`), `site/public/privacy.html` ("Analytics and telemetry" section: no automatic telemetry; Send diagnostics in Settings uploads only when you click Send; what's in it; your address and note; stored about 30 days; developer gets a notification email)

**Interfaces:**
- `Deps { bucket: { put(key, body, opts) }, perIp: { limit({ key }): Promise<{ success: boolean }> }, dailyCap: { take(): Promise<boolean> }, notify(mail: { subject: string; replyTo: string | null; text: string }): Promise<void>, now(): Date, id(): string }`.
- wrangler: `name: "pheeme-diagnostics"`, route `{ pattern: "diagnostics.pheeme.email", custom_domain: true }`, R2 binding `BUNDLES` → `pheeme-diagnostics`, `ratelimits` binding `PER_IP` (limit 2, period 60), DO `DAILY_CAP` class `DailyCap` with `new_sqlite_classes` migration (cap 200/UTC day), `send_email` binding `NOTIFY` with `destination_address: "ajg0360@gmail.com"`.
- Order in `handleUpload`: method/path (404/405) → per-IP limit (429) → size (`content-length` > 5 MB or actual bundle > 5 MB → 413) → parse multipart, validate `meta` JSON and zip magic `PK\x03\x04` (400) → daily cap (429, `Retry-After` seconds to next UTC midnight) → `bucket.put("YYYY-MM-DD/<id>.zip", bundle, { customMetadata: { version, os, replyTo } })` → `notify` (failure logged, still 204) → 204.
- Email: subject `Pheeme diagnostics: {replyTo ?? "anonymous"} ({version}, {os})`; text = note, highlights (one per line), object key and `wrangler r2 object get pheeme-diagnostics/<key> --file <id>.zip --remote`.
- [ ] **Step 1: Failing tests:** `stores_and_notifies` (valid upload → 204, one put under today's date prefix, notify called with replyTo + highlights in text); `rejects_oversize` (413, no put); `rejects_non_zip` (400); `per_ip_limited` (429, no put/notify); `daily_cap_reached` (429 with Retry-After, no put/notify); `notify_failure_still_204`.
- [ ] **Step 2:** `npm run test -- workers` → FAIL.
- [ ] **Step 3: Implement.** Build the notification MIME by hand (text/plain, UTF-8, `From`, `To`, `Reply-To`, `Subject` RFC 2047-encoded if non-ASCII, `Message-ID`, `Date`) in `index.ts`.
- [ ] **Step 4:** `npm run test`, `npm run typecheck`, `npm run lint`, `npm run format:check`; `npx wrangler deploy --dry-run --config workers/diagnostics/wrangler.jsonc` bundles without errors.
- [ ] **Step 5:** Commit `feat(support): Cloudflare Worker that receives diagnostics`.

## Execution

Tasks 1→2 run sequentially (Task 2 consumes Task 1). Tasks 3 and 4 run in parallel with them against the shared contract. Each implementer commits only its own files (`git add <paths>`, never `-A`); on `index.lock` contention, retry. Whole-branch review on Sol (`sol-loop`) after all four land.
