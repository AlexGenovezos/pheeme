# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Pheeme** — an open-source (MIT), multi-platform Tauri 2 desktop Gmail client with Google Calendar planned post-v1 (React + Rust + SQLite). Users bring their own Google Cloud OAuth client (BYOC), so the app costs nothing to run. Domains: `pheeme.app`, `pheeme.email`. (The bundle identifier is `app.pheeme.desktop`, the crate is `pheeme`, and the GitHub repo is AlexGenovezos/pheeme.)

**Source of truth:** [docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md) sets scope, priorities and the phase order, and overrides `Gmail client project plan.md` wherever they disagree (see its §9). The plan remains the detailed technical reference.

**Current state:** Phases 1–11 of design §12 are built: foundation, OAuth + multi-account onboarding, the Gmail API client, the sync engine, the app shell, the mail UI (v0.6), compose (v0.8), search (v0.9), labels (Phase 9: create, edit, delete, colour and show/hide through Gmail's labels API, a nested Labels sidebar section, searchable Label as… (`l`) and Move to… (`v`), coloured chips in the list and conversation), notifications and the tray (Phase 10) and settings (Phase 11, v0.17). Phases 1–11 have passed acceptance (progress per phase: GitHub epic #21); what remains of Phase 12 is cross-platform QA, polish and accessibility. Phase 11 added list density, hiding the reading pane, default reply, confirm before sending, per-account Inbox tabs (mail from a hidden tab shows as Primary), a notification schedule, Clear downloaded mail and reopening the setup guide. v0.9 also includes encrypted Google Cloud client transfer between devices, offline release notes in Settings › About, and default-on persistent diagnostic logs.

## Commands

### Development

```bash
npm run dev          # Vite dev server only (frontend)
npm run tauri dev    # Full app with hot reload (runs both Vite + Rust)
npm run build        # Type check (tsrs) + Vite production build
npm run typecheck    # tsrs, the Rust port of TypeScript 7.1 (beta); typecheck:typescript runs the same checks with tsc 7
npm run test         # Vitest test runner
npm run lint         # oxlint, warnings fail (config: .oxlintrc.json) + design-token check
npm run format       # oxfmt formats TS/JS/CSS/JSON/YAML/HTML (.oxfmtrc.json); CI runs format:check
npm run release:prepare -- X.Y   # bump the version, draft docs/releases/vX.Y.md
npm run release:check -- X.Y     # gate before tagging (the release workflow runs it too)
```

Releases follow the `release` skill (`.claude/skills/release/SKILL.md`).

### Rust / Database

```bash
# From src-tauri/
cargo check --manifest-path src-tauri/Cargo.toml
sqlx database create
sqlx migrate run
cargo sqlx prepare   # Regenerates .sqlx/ offline query cache (required after schema changes)
```

SQLx uses **compile-time query validation** against `.sqlx/` offline cache. After any schema or query change, run `cargo sqlx prepare` before committing.

### Database location

SQLite DB is created at the platform app data dir at runtime. Migrations live in [src-tauri/src/db/migrations/](src-tauri/src/db/migrations/).

## Architecture

### Two-Process Model

- **Frontend** (`src/`) — React 18 + TypeScript, built with Vite. Communicates with Rust via Tauri's `invoke()` IPC. Typed wrappers live in [src/lib/tauri.ts](src/lib/tauri.ts).
- **Backend** (`src-tauri/src/`) — Rust Tauri app. Exposes commands, manages DB, handles Gmail API and OAuth.

### Rust Module Layout

| Module | Purpose |
|--------|---------|
| `lib.rs` | Bootstraps `AppState` (SQLite pool), runs migrations, registers Tauri commands (commands register here, not in `main.rs`) |
| `db/` | All SQLite CRUD via SQLx — one file per entity (messages, threads, labels) |
| `commands/` | Tauri command handlers (the IPC surface the frontend calls) |
| `gmail/` | Gmail REST API client. `auth.rs` is OAuth (PKCE + loopback redirect); the rest lands in Phase 3 |
| `sync/` | `engine.rs` initial/incremental (`history.list`)/expiry-reconcile/backfill; `outbox.rs` optimistic ops + safe sends; `manager.rs` per-account scheduling and triggers; `api.rs` the `MailApi` trait (`fake.rs` is the in-memory Gmail for tests) |
| `http.rs` | Every `reqwest` client is built here (`client`, `client_builder`), which installs the rustls crypto provider; clippy rejects `reqwest::Client::new`/`builder` and `reqwest::get` |
| `render.rs` | Email HTML sanitizer (`ammonia`) and signed `pheeme-att` URLs for inline `cid:` images |
| `attachment_cache.rs` / `attachment_kind.rs` | Attachment bytes on disk (`{cache}/attachments/{account}/{message}/{row}`): a sweep at launch (and after every 50 MB of downloads) removes orphans, then the least recently used files past 500 MB; `clear` deletes them all. `attachment_kind` decides which files the preview shows and which open in the default app |
| `telemetry.rs` | Anonymous usage ping (on by default; Settings › Diagnostics and the welcome screen turn it off): once a day after an account is connected, a random install ID, version, OS and chip go to the diagnostics Worker's `/v1/ping`. Never from debug builds. `node scripts/installs.mjs` reads the counts |
| `body_retention.rs` | Periodic trim (launch, then every 6 h): bodies of mail older than the 180-day body window go back to metadata only 30 days after they were downloaded; `clear_all` (Clear downloaded mail) does it for every body at once |
| `mail.rs` | Tauri-free mail service the commands call: cached list/thread/label reads, changes via the outbox |
| `contacts.rs` | Tauri-free recipient suggestions for To/Cc/Bcc, answered locally: addresses from synced mail (the `contacts` table, kept by a trigger on `messages`) plus Google Contacts and "Other contacts" downloaded through the People API (`gmail/people.rs`) after launch and every 6 h. Settings › Contacts walks an account through turning the People API on and signing in again |
| `labels.rs` | Tauri-free label service: create, rename/re-nest (cascading to sublabels), colour, visibility and delete (with sublabels), straight to Gmail's labels API (not the outbox), then written to the cache |
| `compose/` | Tauri-free compose service: MIME building (`lettre`), Reply/Reply All/Forward templates, staged attachments, Gmail drafts, sends (with undo window) via the outbox |
| `accounts.rs` | Tauri-free account service: sign-in flow, list/remove, access tokens (cached in memory) |
| `identity.rs` | App identifier and keychain service constants |
| `secrets.rs` | OS keychain secret store: all accounts in one cached item (`accounts`), read once per launch; tokens never go in SQLite |

### Frontend State

Seven Zustand stores:
- `accountStore` — connected accounts (load, upsert, remove)
- `mailStore` — the active mailbox or search results (paged, optimistic patches), reloaded on `sync:*` events; search combines instant local matches with background Gmail pages
- `labelStore` — per-account labels, label counts and category counts, plus the All Inboxes unread count
- `threadStore` — thread-detail cache with prefetch; evicts on `sync:messages_updated`
- `inboxTabsStore` — per-account hidden Inbox tabs (Primary is always shown)
- `uiStore` — active mailbox, search text and account scope, selected thread, multi-select, pane layout
- `composeStore` (`src/compose/`) — open compose panels (autosave, close prompt) and sends waiting out undo or Gmail's confirmation; a refused or undone send reopens its panel

Settings is a dialog over the app (`src/settings/`). Pages, sections and rows are declared as data in `src/settings/pages.tsx`: a new setting is one `SettingDef` there. Keyboard shortcuts come from the command registry; user rebindings are overrides stored by `src/keyboard/bindings.ts`, so label a button with `useKeybinding(commandId)` rather than a literal key.

Label UI lives in `src/labels/`: the label tree (nesting by `/` in names), palette and chip colours, the searchable picker behind Label as… and Move to…, and the create/edit/delete dialogs.

Compose panels dock at the bottom of the window (`src/compose/ComposeHost.tsx`); the TipTap editor is lazy-loaded with the panel. A panel is a `data-owns-keys` region, so single-key shortcuts don't fire inside it. Mail actions (archive, trash, star, read, labels, reply, new message) live in `src/mail/actions.ts`, shared by buttons, menus and shortcuts. Clicking an attachment (or Space on it) opens a Quick Look-style preview over the blurred app (`src/mail/preview/`): PDFs (pdf.js), Word (docx-preview, in a script-less sandboxed frame), spreadsheets and CSV, images and text, each reader lazy-loaded; opening a conversation prefetches its attachments into the disk cache. Browser preview (`npm run dev`) answers every command from `src/preview/` fixtures, which mutate and emit `sync:messages_updated` like the app.

The speed reader (`src/speedread/`) flashes one word at a time from emails that are mostly prose. `text.ts` decides which emails qualify and extracts their paragraphs, `words.ts` holds the focus-letter and pause rules, and its settings (`settings.ts`) are shared by the reader dialog and Settings › Appearance.

### Database Schema Summary

Twelve tables.
- `accounts` — Account identity and Gmail history_id for sync (no tokens; those are in the keychain)
- `labels` — Gmail labels with message/thread unread/total counters
- `threads` — Conversation rows, derived from their messages by `threads::recompute_threads` (never written directly by sync)
- `thread_labels` — Thread/label membership; label listing uses keyset-paged `list_threads`
- `messages` — Full message data; `to_addresses`, `cc_addresses`, `raw_headers` as JSON; `fully_fetched = 0` means metadata only; `body_fetched_at` is when the cached body was downloaded (drives `body_retention`)
- `attachments` — Attachment metadata incl. `content_id`/`is_inline` (content is cached on disk, not stored); cascades from messages
- `outbox` / `outbox_messages` — Ordered queue of local changes and sends waiting for Gmail, with each target message's labels before the change
- `sync_state` — Per-account backfill position
- `contacts` — Every address an account has exchanged mail with (sent/received counts, last dates), kept by a trigger on `messages`, for recipient suggestions
- `google_contacts` / `google_contacts_sync` — The account's downloaded Google Contacts and how the last download went

## Key Conventions

- **IPC pattern:** Add a Rust fn in `commands/<domain>.rs`, register it in `lib.rs`'s `Builder`, add a typed wrapper in `src/lib/tauri.ts`.
- **DB queries:** Use `sqlx::query_as!` macros for compile-time checking. All queries go in `db/<entity>.rs`.
- **Thread labels** live in the `thread_labels` table, derived from `messages.label_ids`: change message labels, then call `recompute_threads` in the same transaction.
- **Mail changes** (archive, read, star, trash, send) go through `sync::outbox`, never straight to Gmail (drafts are the exception: saved straight to the drafts API). Write transactions use `db::begin_write` (`BEGIN IMMEDIATE`).
- **Label metadata changes** (create, rename, delete, colour, visibility) go straight to Gmail through `LabelService` (`labels.rs`), not the outbox, and hold the per-account label lock. Label sync takes that lock with `try_lock`, so message sync never waits on it.
- **User-initiated Gmail calls** (label, draft and search commands, outbox dispatch) run inside `gmail::user_action`, ahead of sync and the backfill: wrap any new command that calls Gmail the same way.
- **Command errors** reject with `{ code, message }` (`CommandError` in `commands/mod.rs`): branch on `code`, show `message`.
- **Onboarding guide text** lives in `src/onboarding/steps.ts` and is mirrored in `docs/google-cloud-setup.md`; change both together.
- Tauri dev server runs on **port 1420** (HMR on 1421). Don't change these without updating `tauri.conf.json`.
