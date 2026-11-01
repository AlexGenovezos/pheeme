# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Pheeme** — an open-source (MIT), multi-platform Tauri 2 desktop Gmail client with Google Calendar planned post-v1 (React + Rust + SQLite). Users bring their own Google Cloud OAuth client (BYOC), so the app costs nothing to run. Domains: `pheeme.app`, `pheeme.email`. (The repo and bundle identifier still use placeholder names until the rename just before the first signed release.)

**Source of truth:** [docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md) sets scope, priorities and the phase order, and overrides `Gmail client project plan.md` wherever they disagree (see its §9). The plan remains the detailed technical reference.

**Current state:** Phase 1 (scaffold) and Phase 2 (SQLite layer) are committed. Next is "Foundation fixes + PR CI" (design §10–§12), before OAuth.

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
| `gmail/` | Gmail REST API client: auth, messages, threads, labels, drafts |
| `sync/` | Background sync engine using Gmail History API for incremental updates |
| `crypto.rs` | Token encryption/decryption for keyring-stored OAuth tokens |

### Frontend State

Three Zustand stores (defined, not yet wired up):
- `accountStore` — auth state, active account
- `mailStore` — threads, messages, labels cache
- `uiStore` — selected thread, active label, pane layout

### Database Schema Summary

Five tables. Known gaps scheduled in design §10: `attachments` has no foreign key (no cascade yet), token columns on `accounts` are to be removed (tokens belong in the OS keychain), and label filtering moves from the JSON `label_ids` column to a `thread_labels` table.
- `accounts` — OAuth tokens (encrypted), Gmail history_id for sync
- `labels` — Gmail labels with unread/total counters
- `threads` — Conversation threads; `label_ids` stored as JSON array
- `messages` — Full message data; `to_addresses`, `cc_addresses`, `raw_headers` as JSON
- `attachments` — Attachment metadata (content not stored)

## Key Conventions

- **IPC pattern:** Add a Rust fn in `commands/<domain>.rs`, register it in `lib.rs`'s `Builder`, add a typed wrapper in `src/lib/tauri.ts`.
- **DB queries:** Use `sqlx::query_as!` macros for compile-time checking. All queries go in `db/<entity>.rs`.
- **Label IDs** are stored as `TEXT` JSON arrays in SQLite — use serde for serialization on both sides.
- Tauri dev server runs on **port 1420** (HMR on 1421). Don't change these without updating `tauri.conf.json`.
