# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Pheeme** — an open-source (MIT), multi-platform Tauri 2 desktop Gmail client with Google Calendar planned post-v1 (React + Rust + SQLite). Users bring their own Google Cloud OAuth client (BYOC), so the app costs nothing to run. Domains: `pheeme.app`, `pheeme.email`. (The bundle identifier is `app.pheeme.desktop`, the crate is `pheeme`, and the GitHub repo is AlexGenovezos/pheeme.)

**Source of truth:** [docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md) sets scope, priorities and the phase order, and overrides `Gmail client project plan.md` wherever they disagree (see its §9). The plan remains the detailed technical reference.

**Current state:** Foundation, OAuth + multi-account onboarding, the Gmail API client, the app shell and the sync engine (design §12 steps 1–5) are implemented (progress per phase: GitHub epic #21). The Phase 6 mail UI (§12 step 6) is implemented on branch `feat/mail-ui`: sidebar with All Inboxes and per-account category inboxes, virtualized multi-select list, thread view with sandboxed HTML bodies and attachments, optimistic actions with undo. Compose (Phase 7) is next.

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
| `render.rs` | Email HTML sanitizer (`ammonia`) and signed `pheeme-att` URLs for inline `cid:` images |
| `mail.rs` | Tauri-free mail service the commands call: cached list/thread/label reads, changes via the outbox |
| `compose/` | Tauri-free compose service: MIME building (`lettre`), Reply/Reply All/Forward templates, staged attachments, Gmail drafts, sends (with undo window) via the outbox |
| `accounts.rs` | Tauri-free account service: sign-in flow, list/remove, access tokens (cached in memory) |
| `identity.rs` | App identifier and keychain service constants |
| `secrets.rs` | OS keychain secret store: all accounts in one cached item (`accounts`), read once per launch; tokens never go in SQLite |

### Frontend State

Five Zustand stores:
- `accountStore` — connected accounts (load, upsert, remove)
- `mailStore` — the thread list for the active mailbox (paged, optimistic patches), reloaded on `sync:*` events
- `labelStore` — per-account labels, label counts and category counts, plus the All Inboxes unread count
- `threadStore` — thread-detail cache with prefetch; evicts on `sync:messages_updated`
- `uiStore` — active mailbox, selected thread, multi-select, pane layout

Settings is a dialog over the app (`src/settings/`). Pages, sections and rows are declared as data in `src/settings/pages.tsx`: a new setting is one `SettingDef` there. Keyboard shortcuts come from the command registry; user rebindings are overrides stored by `src/keyboard/bindings.ts`, so label a button with `useKeybinding(commandId)` rather than a literal key.

Mail actions (archive, trash, star, read, labels) live in `src/mail/actions.ts`, shared by buttons, menus and shortcuts. Browser preview (`npm run dev`) answers every command from `src/preview/` fixtures, which mutate and emit `sync:messages_updated` like the app.

### Database Schema Summary

Nine tables.
- `accounts` — Account identity and Gmail history_id for sync (no tokens; those are in the keychain)
- `labels` — Gmail labels with message/thread unread/total counters
- `threads` — Conversation rows, derived from their messages by `threads::recompute_threads` (never written directly by sync)
- `thread_labels` — Thread/label membership; label listing uses keyset-paged `list_threads`
- `messages` — Full message data; `to_addresses`, `cc_addresses`, `raw_headers` as JSON; `fully_fetched = 0` means metadata only
- `attachments` — Attachment metadata incl. `content_id`/`is_inline` (content is cached on disk, not stored); cascades from messages
- `outbox` / `outbox_messages` — Ordered queue of local changes and sends waiting for Gmail, with each target message's labels before the change
- `sync_state` — Per-account backfill position

## Key Conventions

- **IPC pattern:** Add a Rust fn in `commands/<domain>.rs`, register it in `lib.rs`'s `Builder`, add a typed wrapper in `src/lib/tauri.ts`.
- **DB queries:** Use `sqlx::query_as!` macros for compile-time checking. All queries go in `db/<entity>.rs`.
- **Thread labels** live in the `thread_labels` table, derived from `messages.label_ids`: change message labels, then call `recompute_threads` in the same transaction.
- **Mail changes** (archive, read, star, trash, send) go through `sync::outbox`, never straight to Gmail (drafts are the exception: saved straight to the drafts API). Write transactions use `db::begin_write` (`BEGIN IMMEDIATE`).
- **Command errors** reject with `{ code, message }` (`CommandError` in `commands/mod.rs`): branch on `code`, show `message`.
- **Onboarding guide text** lives in `src/onboarding/steps.ts` and is mirrored in `docs/google-cloud-setup.md`; change both together.
- Tauri dev server runs on **port 1420** (HMR on 1421). Don't change these without updating `tauri.conf.json`.
