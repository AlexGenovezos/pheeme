# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Pheeme** — an open-source (MIT), multi-platform Tauri 2 desktop Gmail client with Google Calendar planned post-v1 (React + Rust + SQLite). Users bring their own Google Cloud OAuth client (BYOC), so the app costs nothing to run. Domains: `pheeme.app`, `pheeme.email`. (The bundle identifier is `app.pheeme.desktop`, the crate is `pheeme`, and the GitHub repo is AlexGenovezos/pheeme.)

**Source of truth:** [docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md) sets scope, priorities and the phase order, and overrides `Gmail client project plan.md` wherever they disagree (see its §9). The plan remains the detailed technical reference.

**Current state:** Foundation, OAuth + multi-account onboarding, the Gmail API client, the app shell and the sync engine (design §12 steps 1–5) are implemented (progress per phase: GitHub epic #21). The list pane reads real mail from the cache; the rest of the mail UI (§12 step 6) is next.

## Commands

### Development

```bash
npm run dev          # Vite dev server only (frontend)
npm run tauri dev    # Full app with hot reload (runs both Vite + Rust)
npm run build        # TypeScript check + Vite production build
npm run test         # Vitest test runner
```

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
| `mail.rs` | Tauri-free mail service the commands call: cached list/thread/label reads, changes via the outbox |
| `accounts.rs` | Tauri-free account service: sign-in flow, list/remove, access tokens (cached in memory) |
| `identity.rs` | App identifier and keychain service constants |
| `secrets.rs` | OS keychain secret store: all accounts in one cached item (`accounts`), read once per launch; tokens never go in SQLite |

### Frontend State

Three Zustand stores:
- `accountStore` — connected accounts (load, upsert, remove)
- `mailStore` — the thread list for the active mailbox, reloaded on `sync:*` events
- `uiStore` — selected thread, active label, pane layout

### Database Schema Summary

Nine tables.
- `accounts` — Account identity and Gmail history_id for sync (no tokens; those are in the keychain)
- `labels` — Gmail labels with message/thread unread/total counters
- `threads` — Conversation rows, derived from their messages by `threads::recompute_threads` (never written directly by sync)
- `thread_labels` — Thread/label membership; label listing uses keyset-paged `list_threads`
- `messages` — Full message data; `to_addresses`, `cc_addresses`, `raw_headers` as JSON; `fully_fetched = 0` means metadata only
- `attachments` — Attachment metadata (content not stored); cascades from messages
- `outbox` / `outbox_messages` — Ordered queue of local changes and sends waiting for Gmail, with each target message's labels before the change
- `sync_state` — Per-account backfill position

## Key Conventions

- **IPC pattern:** Add a Rust fn in `commands/<domain>.rs`, register it in `lib.rs`'s `Builder`, add a typed wrapper in `src/lib/tauri.ts`.
- **DB queries:** Use `sqlx::query_as!` macros for compile-time checking. All queries go in `db/<entity>.rs`.
- **Thread labels** live in the `thread_labels` table, derived from `messages.label_ids`: change message labels, then call `recompute_threads` in the same transaction.
- **Mail changes** (archive, read, star, trash, send) go through `sync::outbox`, never straight to Gmail. Write transactions use `db::begin_write` (`BEGIN IMMEDIATE`).
- **Command errors** reject with `{ code, message }` (`CommandError` in `commands/mod.rs`): branch on `code`, show `message`.
- **Onboarding guide text** lives in `src/onboarding/steps.ts` and is mirrored in `docs/google-cloud-setup.md`; change both together.
- Tauri dev server runs on **port 1420** (HMR on 1421). Don't change these without updating `tauri.conf.json`.
