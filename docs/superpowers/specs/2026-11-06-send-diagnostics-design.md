# Slow email opens: show what's happening, and let users send diagnostics

Status: design, 2026-11-06. Author: Claude with Alex.

## Why

A new user installed Pheeme, clicked an email, and waited a long time with a blank reading pane. Alex had no way to see why: the user's machine isn't reachable over SSH, and although Pheeme already writes rotating logs to disk (`src-tauri/src/diagnostics.rs`), nothing lets a user send them, and nothing records how long an email took to open or what it waited on.

Two things, in Alex's words: "we should have an indication of what is going on if it's going to take a long time", and "a way to tell them to go to settings and send me some log info that would tell me why it's taking so long".

## What's actually slow (found in recon)

Initial sync downloads only the newest 50 Inbox threads in full (`engine.rs:119`, `inbox_first_page`); everything else arrives through the backfill, which pages through the mailbox at a throttled rate and stores bodies only for the last 180 days (`FULL_BODY_DAYS`). So for the first minutes after install, most emails (anything past the first 50 Inbox threads, other labels, search results) and every older email have no cached body. Opening one runs `MailService::get_thread` → `engine.load_thread_bodies` → `batch_get_messages` at `Priority::Sync`, and the command doesn't return until Gmail answers. Meanwhile:

- Opening competes for the same 8 background request slots as initial sync (which fills all 8 with 10 parallel `threads.get`) and backfill (`gmail/client.rs:24-30, 474-484`).
- All requests share one quota limiter; any 429 halves the rate for up to 60 s. Permits are held through backoff sleeps.
- Retries go up to 5 times with 1–16 s jittered backoff on top of a 30 s per-attempt timeout: a single request can take over 3 minutes.
- Prefetch of neighbouring rows (`src/mail/actions.ts:463`) starts more Sync-priority fetches.
- The UI renders nothing while waiting (`src/mail/ThreadView.tsx:178`, "this is a blink, no spinner"), and if the fetch fails the error is swallowed (`mail.rs:422`) and the user sees "Couldn't load this message — you may be offline", whatever the real cause.

## Goals

1. **The reading pane says what's happening** when an email takes more than a moment to open.
2. **Every email open is timed and its cause is logged**, so a log answers "why was it slow?".
3. **Settings › About › Send diagnostics** uploads a scrubbed log bundle to Alex in one click (plus an optional note). No code to read back to Alex.
4. **Save diagnostics…** writes the same bundle to a file, as a fallback when upload fails or the user prefers to email it.
5. **A small Cloudflare Worker on `diagnostics.pheeme.email`** receives uploads, stores them, and emails Alex.

## Non-goals

- Automatic or background telemetry. Nothing is sent unless the user clicks Send.
- Crash reporting.
- A dashboard or admin UI for browsing uploads (R2 dashboard / `wrangler` is enough).
- Sending diagnostics by composing a Gmail message (considered; Alex preferred the upload).

## Anti-goals (failure even if it works)

- Email contents, subjects, snippets, search terms or correspondents' addresses leaving the machine.
- A spinner that spins forever: every wait ends in the email, or an error with a real reason and Retry.
- A flicker of loading UI on cached opens that are already instant.
- The upload endpoint becoming a way to spam Alex's inbox or run up a Cloudflare bill.

## Part 1 — Loading indicator and open timing

### What the user sees

- First ~300 ms: nothing (cached opens are a blink and must stay that way).
- After that: a quiet loading state in the reading pane, "Downloading this message from Gmail…", using existing design tokens/components (follow `npm run lint`'s design-token check).
- When the backend knows a specific reason, the line says so, e.g.:
  - "Pheeme is still downloading your mailbox for the first time — this message is next in line." (waiting behind initial sync/backfill)
  - "Gmail is asking Pheeme to slow down. Retrying in 8 s…" (rate limited / backoff)
  - "Gmail isn't answering. Retrying…" (network error / timeout, with attempt count)
- On failure: the real reason (from the error `code`/`message`, scrubbed of URLs) and a **Try again** button, replacing today's generic "you may be offline".
- After ~15 s of waiting, add a small secondary link: "Taking too long? Send diagnostics" that opens Settings › About scrolled to the button. *(Claude's call.)*

The existing `EmailBody` "couldn't load" state for a single message within a loaded thread should get the same real-reason treatment.

### Making the open itself faster *(Claude's call — flagged to Alex)*

The indicator alone doesn't fix the user's experience; the recon shows the open is queued behind sync. The thread the user explicitly opened should fetch at a priority that doesn't wait for background slots (the client already has an `Interactive` priority used for attachment downloads). Prefetches of neighbouring rows stay at background priority. Keep this change small and measured: the open timing (below) should show the improvement.

### Progress from backend to frontend

The frontend needs to know the stage of an in-flight open. Suggested shape (builder may refine): while `load_thread_bodies` runs for a user-initiated open, the backend emits a `mail:thread_loading` event `{ accountId, threadId, stage, retryInMs?, attempt? }` with stages such as `queued` (waiting for a request slot or quota), `fetching`, `retrying`. `threadStore` tracks an in-flight/loading state per thread key (today it has none — `inflight` is module-local) and `ThreadView` renders it. Whether initial sync/backfill is running can come from the backend (`AccountSync.backfilling`, sync run lock) rather than being inferred in the frontend.

### Open timing in the log

Every user-initiated `get_thread` logs one structured line when it finishes, at `info` if it hit the network or took > 1 s, `debug` otherwise, with fields like:

- `source` (cache / gmail), `total_ms`
- `slot_wait_ms`, `quota_wait_ms`, `gmail_ms`, `db_ms`
- `retries`, last HTTP `status` / Gmail `reason`
- `messages_fetched`, `bytes` (approximate)
- `initial_sync_running`, `backfill_running`, current quota rate (if throttled)
- `outcome` (ok / error code)

No thread/message IDs are needed for diagnosis; use a short hash if correlating log lines matters. Also keep the last ~50 open timings in memory for the bundle summary.

## Part 2 — Diagnostics bundle

### Contents

A zip (add a `zip` crate; none is present today) containing:

- `summary.json` — app version, OS + arch, account count, per account: initial sync done?, backfill complete?, messages cached / with bodies, last sync time, current quota setting; the last ~50 open timings; the user's note; time of upload. No email addresses except the sender's own (see below).
- `logs/` — the most recent log text, capped so the zip stays well under the upload limit (e.g. last ~20 MB of raw log, which compresses heavily). Flush the non-blocking log writer before reading if feasible; `LogGuard` only flushes on shutdown today.

### Scrubbing (required before both upload and save)

Recon found these PII risks in current logs; fix at the source where possible and scrub the text regardless:

- `reqwest::Error` Display includes the request URL, and search URLs carry `q=` (search terms, e.g. `from:bob@x.com`) — logged at `gmail/client.rs:521` and propagated via `GmailError::Network/Offline` into many log lines and the `sync:error` event. Use `without_url()` at the source.
- Gmail error `message` text (`client.rs:571,590`) can echo request contents.
- `outbox.rs:494` logs rejected-change errors; `desktop.rs:135` logs arbitrary messages.
- Paths containing the OS username (`lib.rs:179,189`, `db/mod.rs:25`): replace the home directory with `~`.

The bundle scrubber then redacts any remaining email addresses (other than the sender's own account addresses), URL query strings, and home-directory paths. Write tests with log lines containing each pattern.

### Settings › About

`src/settings/AboutSettings.tsx` gets a "Diagnostics" section (add the words to the page `keywords`/`matches` so search finds it):

- **Send diagnostics** — opens a small dialog:
  - "What happened?" text box (optional).
  - "Sent as jane@gmail.com so the developer can reply" — the signed-in Gmail address. With several accounts, a picker defaulting to the first. With none (e.g. stuck in onboarding), an optional "Your email (so I can reply)" field.
  - A plain list of what's included and a line saying the logs never include email contents, subjects or contacts, and that the note is sent exactly as typed *(Claude's call: the note isn't scrubbed; the user wrote it to be read)*. A "Save a copy to look at first" link for anyone who wants to check.
  - Send → uploads from Rust → "Sent. Thanks — Alex will take a look." On failure → the reason, plus **Save diagnostics…** as the way out.
- **Save diagnostics…** — native save dialog (needs `dialog:allow-save` added to capabilities), writes the same zip.

Upload and save are Rust commands (webview CSP blocks outbound fetch); register in `lib.rs`, wrap in `src/lib/tauri.ts`, errors as `CommandError`. Browser preview (`src/preview/`) needs fixtures for the new commands.

## Part 3 — Cloudflare Worker

- New directory in the repo (e.g. `workers/diagnostics/`) with its own `wrangler.jsonc`, deployed to `diagnostics.pheeme.email` (zone already on Cloudflare).
- `POST /v1/upload`: body is the zip; metadata (version, OS, sender email, note) in the zip's `summary.json` and/or headers. Rejects anything over ~5 MB or not a zip.
- Stores the zip in an R2 bucket under a random ID with a date prefix. An R2 lifecycle rule deletes objects after 30 days (Cloudflare removes them typically within 24 h of expiry, so say "about 30 days" to users). Bucket is private; nothing can be listed or read without Alex's Cloudflare login.
- Emails Alex via Cloudflare Email Routing's `send_email` binding from `diagnostics@pheeme.email` to `ajg0360@gmail.com` (destination must be verified in Email Routing): subject like "Pheeme diagnostics — jane@gmail.com — v0.12 / macOS", body with the note, the summary highlights (slowest opens and their causes, sync state), the R2 object key plus the `wrangler r2 object get` command to download it, and **Reply-To set to the sender's address** so Alex can reply directly. The zip is **not** attached: it stays only in R2, so the 30-day retention actually holds *(Claude's call)*. The notification email itself lives in Alex's inbox like any support email; the privacy policy says so.
- Abuse limits, all on the free tier:
  - Per-IP burst limit with the Workers rate limiting binding (its windows are 10 s or 60 s and counts are per-location and approximate, e.g. 2 uploads per 60 s).
  - A global daily cap on accepted uploads (e.g. 200/day) kept in a single Durable Object counter, so it's exact across locations. Over the cap the Worker answers 429 and stores nothing, so storage and email volume are bounded *(Claude's call)*.
  - The app treats 429 like any failure: shows the reason and offers Save.
- The app falls back to Save when the endpoint fails or rate-limits.
- Deploying the Worker, creating the R2 bucket and verifying the Email Routing destination are steps on Alex's Cloudflare account: the builder prepares everything and asks before deploying.

## Other required changes

- `site/public/privacy.html` currently says the app collects no telemetry and that any crash reporting would be opt-in, never include email contents, and the policy would be updated first. Update it before shipping: describe the user-initiated diagnostics upload, what's in it, retention (30 days), and that it only happens when the user clicks Send.
- Mention the feature in the next release notes.

## Decided by Alex

- Show an indication when an email takes long to open; the plan for it ("sounds great").
- Users send diagnostics from Settings; the main path is a one-click upload to a Cloudflare Worker, not an email compose.
- No code the user has to read back; identify the upload by the user's own email address.
- Use the `pheeme.email` domain.

## Claude's calls (Alex may override)

- Notifications go to `ajg0360@gmail.com`.
- Making user-opened emails fetch at interactive priority, not just showing a spinner.
- The 15 s "Taking too long? Send diagnostics" link.
- 300 ms delay before the loading state; 5 MB upload cap; about 30-day retention in R2.
- The notification email carries the summary and note but not the zip.
- A global daily upload cap (Durable Object counter) in addition to the per-IP limit; over it, uploads are refused and the app offers Save.
- The user's note is sent as typed (disclosed in the dialog), not scrubbed.

## Left to the builder

- Exact event/stage model and store shape for loading state.
- Exact log field names and the in-memory timing buffer.
- Zip layout, log size cap, scrubber regexes (with tests).
- Worker code structure, rate-limit numbers, email formatting.
