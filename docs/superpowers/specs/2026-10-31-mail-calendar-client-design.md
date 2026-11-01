# Design: Pheeme — open-source Gmail + Google Calendar desktop client

**Date:** 2026-10-31
**Status:** Approved by Alex, 2026-10-31 (reviewed by Sol, 5 rounds)
**Relationship to `Gmail client project plan.md`:** that plan stays the detailed technical reference (OAuth flow, Gmail API surface, sync algorithm, HTML rendering, compose). This document sets product intent, scope, and priorities, and **overrides the plan wherever they disagree**. Overrides are listed in [§9](#9-changes-to-the-existing-plan).

---

## 1. Intent

Good native Gmail clients today tend to be single-platform, slow to update, and paid by subscription. Part of that subscription is structural: an app that accesses Gmail's restricted scopes through a shared OAuth client must pass Google's annual third-party security assessment, and users fund it.

The goal: **a polished, native-feeling Gmail client with a built-in Google Calendar, on macOS, Windows, and Linux, that is free to use and free to run, and that feels instant.** It will be open-sourced.

The "free" part is achieved with **bring-your-own-client (BYOC)**: each user creates their own Google Cloud project and OAuth client. Nobody pays Google, nobody runs a server, and mail never touches infrastructure we own.

## 2. Who it's for

Technical people — developers and people comfortable following a 15-minute Google Cloud setup guide. Non-technical users are explicitly not the audience. Because of this, the **setup guide is product, not documentation** (see the existing plan, Phase 3).

Alex's own daily use is the first bar: v1 is done when Alex can make Pheeme his only mail client.

## 3. Goals, non-goals, anti-goals

### Goals
- Gmail-native (Gmail REST API, real labels and category tabs — not IMAP).
- Feels instant on every common action (see [§5](#5-speed-principles)).
- UI polish on par with the best native Mac mail and calendar apps, and with T3 Code.
- Multiple Google accounts, with both a combined inbox and per-account views.
- Google Calendar as a first-class second mode of the app (post-v1).
- Day and night themes in v1; fully custom themes later.
- Open source with a full GitHub release pipeline and self-updating app.

### Non-goals
- Non-Gmail providers (Outlook, iCloud, generic IMAP).
- A hosted backend of any kind (no sync server, no push relay, no telemetry server).
- Mobile apps.
- Pixel-perfect rendering of every marketing email.

### Anti-goals (would be a failure even if everything "works")
- **UI that feels like a web page in a box.** This is the #1 risk Alex named. Janky spacing, browser-style focus rings, selectable UI chrome, layout shift, spinners on common paths, inconsistent components — any of these is a failure.
- Any recurring cost to users or to the project for Google API access.
- Waiting on the network to show something the app has already seen.

## 4. Scope

### v1 — "Alex's daily mail client"
1. **BYOC onboarding** — paste client ID + secret, authorize in browser, done. Add a second account through the same flow; by default it reuses the stored client, so one Google Cloud project serves both. *(Builder's call:)* credentials are stored **per account** (the schema already has `client_id` per account), and "add account" offers "use a different OAuth client". This covers a work Google Workspace account whose admin requires an org-internal OAuth client.
   - **In-app setup tutorial (v1, decided by Alex).** First launch opens a full, step-by-step guided walkthrough that takes a user from "no Google Cloud project" to a connected inbox without leaving the app for instructions. One screen per step, each with: what to do and why, a screenshot of the Google Cloud Console screen, a button that deep-links to the exact console page (Gmail API library page, OAuth consent screen, credentials page, etc.), and copy-to-clipboard buttons for every value to type (app name, scopes, client type). Steps: create project → enable Gmail API (and Calendar API, see §8) → configure consent screen → **publish to "In production"** (with the 7-day-token explanation) → create a Desktop OAuth client → paste client ID + secret → authorize, including a screen that explains the "Google hasn't verified this app" warning before the user sees it. Progress is saved so the user can quit and resume at the same step. Known failures get a plain-language troubleshooting screen with the fix (`redirect_uri_mismatch`, `access_denied`/`org_internal`, `admin_policy_enforced` for blocked Workspace accounts, `invalid_client`, a token that dies after 7 days because the app was left in Testing). The tutorial is reachable later from Settings → Accounts → "Add account" and Help. The README guide mirrors it, sharing the same screenshots.
2. **Multi-account**
   - Sidebar shows **All Inboxes** (combined) plus each account separately.
   - In the combined view each row shows a small per-account color dot.
   - Replying always sends from the account that received the message.
3. **Inbox with category tabs** — Primary, Social, Promotions, Updates, Forums, each with an unread count. Tabs work in both combined and per-account views (Primary under All Inboxes = Primary from every account). Per-account toggle for which tabs show (existing plan, Phases 6 and 11).
4. **Reading** — threaded conversations, sandboxed HTML rendering, external images blocked by default, attachments.
5. **Actions** — archive, delete, star, mark read/unread, apply/remove labels, all optimistic.
6. **Compose** — new, reply, reply-all, forward, drafts synced to Gmail, undo-send.
7. **Search** — see [§5](#5-speed-principles) for the local-first behaviour.
8. **Labels** — view, create, rename, delete, color.
9. **Notifications** — desktop notification for new Primary mail; tray icon with unread count.
10. **Settings** — accounts, category toggles, appearance, compose options, privacy.
11. **Themes** — Light and Dark, following the OS by default, with a manual override. Built on the token-based theme system in [§6](#6-ui-quality-bar-and-theming) so custom themes later are additive.
12. **Release pipeline + auto-update** — [§7](#7-release-pipeline-and-distribution).

### Post-v1, in order
1. **Calendar mode** ([§8](#8-calendar-mode-post-v1)).
2. **Custom themes** (user-installable theme files).
3. Gmail push via Pub/Sub (existing plan, Phase 10 "Future").
4. Mail extras, tracked as GitHub issues labelled `post-v1`: snooze (#1), scheduled send (#2), signatures (#3), send-as aliases (#4), contact autocomplete (#5). Snooze and scheduled send are local-only because Gmail's API has neither.

### v2
- **AI integration via a local MCP server** ([#6](https://github.com/AlexGenovezos/pheeme/issues/6)): MCP clients (Claude Code, Claude Desktop, …) can search mail, read threads, list labels/events, find free time, and create drafts, all served from the local cache. Read-only by default, with write tools individually opt-in, **no direct send** (drafts only), an activity log, and localhost only.

### Architecture rule that v2 depends on (applies from now)
Business logic lives in Rust service modules that don't depend on Tauri (`db/`, `gmail/`, `sync/`, and later `mail/` and `calendar/` services). `commands/` stays a thin IPC adapter: it parses arguments, calls a service, and maps errors. The MCP server (or any future API) is then a second adapter over the same services, not a rewrite.

## 5. Speed principles

"Stupid fast" means *perceived* speed. These are requirements, not aspirations:

- **Local-first reads.** Every view (thread list, thread, label switch, tab switch, account switch, combined inbox) renders from SQLite. The network is never on the critical path for something already cached. Google syncs in the background.
- **Optimistic writes.** Every mutation updates the local cache and the UI immediately, then calls Gmail. *(Builder's call:)* mutations go into a persisted **outbox** table and replay in order when connectivity returns, so archiving on a plane just works. Roll back (with a non-blocking toast) only when Gmail definitively rejects the change, not on network failure. (Builds on the existing plan Phase 5 `pending_op_id` mechanism; design the outbox in from day one of the sync phase.) Label changes, read state, star and trash are naturally idempotent and safe to replay. **Sends are not:** every outgoing message gets a client-generated `Message-ID` header (persisted with the outbox entry) before the first attempt; after an ambiguous failure (timeout, connection drop, 5xx), the app **never re-sends automatically**. Gmail's search index lags, so it rechecks Sent for `rfc822msgid:<id>` with backoff (≈30 s, 2 min, 10 min) and also watches incremental sync for that Message-ID. A search that itself fails (offline, 5xx, 429) doesn't count as a check; it is retried and the schedule only advances on a search that completed and returned no match. If the message appears at any point, the send is marked done. If it's still missing after the last completed check, the message stays in Outbox as "not confirmed" and the app **keeps watching sync for that Message-ID indefinitely**, clearing the entry automatically if it shows up later. The user can press **Send again**, which first shows a confirmation that it may already have been delivered (with a link to the Sent search) before re-sending with the same Message-ID. Sends Gmail clearly rejected are handled by status: 401 → refresh the token and retry, 429 → back off and retry, other 4xx → stop and show the error.
- **Keyboard first.** Gmail-style shortcuts (`j`/`k`, `e`, `#`, `r`, `a`, `f`, `c`, `/`, `g i`…), a command palette (`Cmd/Ctrl+K`), and a single shortcut to toggle Mail ↔ Calendar. Every action reachable without the mouse.
- **No spinners on common paths.** Lists are virtualized. While a thread is open, the next and previous threads are prefetched so `j`/`k` is instant. Skeletons are only acceptable on an account's very first sync.
- **Instant launch.** The window shows the last view from cache immediately, then syncs. No blank white flash.
- **Search is local-first.** *(Builder's call, overriding the plan's Gmail-only search.)* Typing searches cached mail instantly via SQLite FTS5; Gmail's `q=` search runs in parallel and merges in results that aren't cached yet. Gmail operators are passed through to the API.
- **Cache depth.** *(Builder's call.)* Enough local mail that normal use never waits: label/thread metadata for the whole mailbox, and full bodies for recent mail (start with ~6 months or the latest few thousand threads per account, then tune). Older bodies fetch on open and are cached from then on.

Treat a regression in any of these as a bug.

## 6. UI quality bar and theming

**Reference points:** best-in-class native Mac mail clients (mail layout and density), Notion Calendar (calendar), T3 Code and VS Code (theming, keyboard feel, command palette).

**Requirements:**
- **One design system from day one.** All spacing, type scale, radii, shadows, motion durations, and colors come from design tokens (CSS custom properties). No hard-coded colors or ad-hoc spacing in components.
- **App-native feel.** No text selection on chrome; no browser-default focus rings (use designed, keyboard-only focus indicators); no layout shift as data arrives; native context menus; native scrolling behaviour; subtle, fast motion (≈100–150 ms).
- **Same look on every OS** — the app's own polished style, not imitating macOS everywhere. Per-OS window integration only: real traffic lights and vibrancy on macOS, proper title-bar controls on Windows/Linux.
- **UI review gate.** Every phase that ships screens includes an explicit UI-quality review against this section before the phase is called done — not just "it functions".

**Theming architecture:**
- A theme is a file that maps token names → values (colors at minimum; optionally fonts). Light and Dark ship as two built-in theme files.
- Mode: System (default) / Light / Dark.
- Email bodies get the dark-mode treatment from the existing plan (Phase 6, HTML rendering).
- *Builder's call, post-v1:* make custom themes importable from VS Code color-theme JSON by mapping VS Code color keys onto our tokens, so many existing themes work on day one of custom themes. Not required for v1, but the v1 token names should be chosen with that mapping in mind.

## 7. Release pipeline and distribution

- **License:** MIT. Public GitHub repo.
- **PR checks (GitHub Actions):** Rust tests, `cargo clippy`, frontend type-check, lint, and tests, on macOS, Windows, and Ubuntu runners. This lands **early** (with the next phase of work), not at the end.
- **Release on tag:** pushing `vX.Y` builds all platforms (via `tauri-action`) and publishes a GitHub Release:
  - macOS: universal (Apple Silicon + Intel) `.dmg`, **signed and notarized** with Alex's existing Apple Developer account.
  - Windows: `.msi` and NSIS `.exe`, **unsigned**. The README documents the SmartScreen "More info → Run anyway" step.
  - Linux: `.AppImage` and `.deb`.
- **Versions** are two-part (`vX.Y`); 0.x is beta, and 1.0 marks leaving beta.
- **Auto-update:** `tauri-plugin-updater` (plugin init, `updater:default` capability, updater public key and endpoint in `tauri.conf.json`, `createUpdaterArtifacts` enabled) pointed at GitHub Releases (`latest.json`), with update artifacts signed by a Tauri updater key stored as a GitHub secret. The app checks on launch and periodically, and installs on restart. This directly addresses slow update cycles.
- **Secrets needed in GitHub:** Apple signing certificate + password, Apple ID / app-specific password / team ID for notarization, Tauri updater private key + password.

## 8. Calendar mode (post-v1)

**What it's for:** while reading an email that asks to meet, flip to the calendar, see availability, and book it — without leaving the app. Alex likes Notion Calendar (formerly Cron) but not that it's now owned by Notion.

**Shape (Alex chose layout C):**
- The app has two top-level modes: **Mail** and **Calendar**, switched with one keystroke or a mode switcher.
- Calendar is a full Notion-Calendar-style view (day / week, plus month as a builder's call), showing all accounts' calendars with per-account colors.
- When switching to Calendar from an open email, that email stays **pinned** in a narrow sidebar so its content stays visible while picking a time.
- Creating an event from that state prefills title (from subject) and guests (from the thread participants). *(Builder's call on exact prefill rules.)*
- Core v1-of-calendar actions: view, create, edit, delete, RSVP, see free/busy for guests if the API allows. *(Builder's call on scope beyond view/create/edit/RSVP.)*

**Access:** Google Calendar API in the same BYOC project. Calendar scopes are "sensitive", not "restricted", so they add no assessment cost; with BYOC the user just enables one more API. The setup guide should tell users to enable the Calendar API **from the start**, so adding Calendar later doesn't require re-doing setup — the app will request the calendar scope incrementally when Calendar mode first opens.

**Data:** same local-first rules as mail: events cached in SQLite, incremental sync with Calendar API `syncToken`, optimistic edits.

## 9. Changes to the existing plan

| Area | Existing plan | This design |
|---|---|---|
| Scope | Mail only | Mail v1, then Calendar mode, then custom themes |
| Accounts | Per-account views | Plus **All Inboxes** combined view with tabs |
| Search | Gmail API only, spinner while waiting | Local FTS5 instant + Gmail merge |
| Themes | system / light / dark setting | Token-based theme files; Light/Dark built-in; custom post-v1 |
| CI/CD | Phase 12, at the end | PR checks now; release + updater as a v1 phase |
| Mac signing | "Notarization setup" | Signed + notarized via Alex's Apple account |
| Windows signing | Unspecified | Unsigned, documented |
| UI polish | Phase 12 "General Polish" | Continuous: design system first, UI review gate per phase |
| Setup guide | Gmail API only | Also enable Calendar API up front |
| Onboarding | Form + README guide | Full in-app guided tutorial with deep links, copy buttons, resume, troubleshooting |

## 10. Current state and foundation fixes (do before Phase 3)

Phases 1 (scaffold) and 2 (SQLite layer) are committed. Before building on them:

1. **Token storage.** The `accounts` table has `access_token_encrypted` / `refresh_token_encrypted` columns, but the plan says tokens live only in the OS keychain. *(Builder's call:)* follow the plan — tokens and the client secret go in the keychain via `keyring`; SQLite stores no secrets. Drop those columns in a new migration (Phase 2 is unreleased, so editing `001_initial.sql` is also acceptable) and decide whether `crypto.rs` is still needed. Handle Linux systems without a Secret Service with a clear error, per plan Phase 12.
2. **Startup race.** `lib.rs` registers `AppState` inside a spawned task, so a command invoked before the DB is ready fails with "state not managed". Initialize the pool before the app starts serving commands (e.g. `block_on` in `setup`).
3. **Label lookup and combined-inbox queries.** `threads.label_ids` is a JSON array filtered with `json_each` per row, paginated with `OFFSET`: every list view scans all of an account's threads, which breaks the speed principle on large mailboxes, and the DB layer is per-account only. Replace with a `thread_labels(account_id, thread_id, label_id, last_message_date)` table indexed on `(label_id, last_message_date DESC)`, keyset pagination (`last_message_date`, `account_id`, `id`), and cross-account queries for All Inboxes and its category tabs.
4. **Attachments integrity.** `attachments` has no foreign key at all, so account or message deletion leaves orphans. Add `FOREIGN KEY (message_id, account_id) REFERENCES messages(id, account_id) ON DELETE CASCADE`.
5. **Webview CSP.** `tauri.conf.json` has `"csp": null`. Ship a strict app CSP now; email bodies still render in the sandboxed iframe described in plan Phase 6.
6. **Schema still to come in later phases** (listed so they aren't forgotten): a durable, ordered **outbox** table in the sync phase (operation payload, idempotency key, retry state, rollback data), and an **FTS5** external-content table over messages in the search phase, maintained in the same transaction as message upserts.
7. **Identity.** The product name is **Pheeme** (decided by Alex; a playful respelling of Pheme, Greek goddess of news and messages). The bundle identifier drives the app-data directory, keychain service name, and updater identity, so changing it after a shipped build would orphan users' data and break updates; the identifier is therefore fixed before anything ships. *(Plan's call, superseding the earlier "rename before the first signed build" assumption: nothing has shipped, so the in-code rename is free today.)* The in-code rename happened in the Foundation phase: product name `Pheeme`, identifier `app.pheeme.desktop` (centralized in `src-tauri/src/identity.rs`, also used as the keychain service name), crate `pheeme` / lib `pheeme_lib`, npm package `pheeme`. The GitHub repo rename to `pheeme` was Alex's action and is done (`AlexGenovezos/pheeme`). Domains owned (registered by Alex on Cloudflare, 2026-10-31): **`pheeme.app`** (website, release links) and **`pheeme.email`**. `pheeme.com` is taken by someone else. Keep "Gmail" out of the product and repo names (Google trademark).
8. **Dev environment.** The Linux devbox lacks Tauri's system libraries (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, etc.) and `node_modules`. CI on Ubuntu runners must install these too.
9. **Stale docs.** `CLAUDE.md` says "current state is Phase 1"; the plan says commands register in `main.rs` (they register in `lib.rs`).

Items 1, 3 and 4 can edit `001_initial.sql` in place (nothing has shipped), followed by `cargo sqlx prepare`.

## 11. Testing and verification

*(Builder's calls.)*
- CI runs only offline tests: Gmail/Calendar API behaviour is tested against recorded JSON fixtures and a mock HTTP server, never a real account (secrets are unavailable to fork PRs in a public repo).
- **Alex's Mac is the primary place the app runs and gets reviewed** (decided by Alex). The dev loop must not depend on CI: the Mac has the Rust + Node toolchain, Alex pulls a branch and runs `npm run tauri dev` (hot reload for the UI, fast incremental Rust rebuilds). The README gets a "Develop on macOS" section and a one-command setup script.
- End-to-end checks against a real Gmail account (OAuth, sync, send) are manual, run by Alex on the Mac.
- *(Builder's call:)* a **browser preview mode**: the frontend can run in a plain browser with a mocked Tauri IPC layer fed by fixture data, so UI work can be checked on the Linux devbox without a native build.
- PR CI also uploads per-OS build artifacts, for checking Windows/Linux builds without a local toolchain on those OSes.

## 12. Proposed v1 phase order

Revised from the plan's 12 phases. Each phase ends with tests passing and, where it ships UI, the UI review gate.

1. **Foundation fixes + PR CI** (§10, §7 PR checks).
2. **OAuth + multi-account onboarding + in-app setup tutorial** (plan Phase 3; tutorial per §4 item 1, built on the Phase 5 design system once it exists — the backend flow lands here, the polished tutorial screens land with the app shell). README guide drafted here.
3. **Gmail API client** (plan Phase 4).
4. **Sync engine** (plan Phase 5), including the optimistic-op machinery and cross-account queries.
5. **App shell + design system + Light/Dark themes** — tokens, window chrome per OS, keyboard/command-palette infrastructure. *Done before feature screens so every screen is built on it.*
6. **Mail UI** — sidebar with All Inboxes + accounts, tabs, virtualized list, thread view, actions, prefetch (plan Phase 6).
7. **Compose** (plan Phase 7).
8. **Search** (plan Phase 8, local-first per §5).
9. **Labels** (plan Phase 9).
10. **Notifications + tray** (plan Phase 10).
11. **Settings** (plan Phase 11).
12. **Release pipeline + auto-update + cross-platform QA** (§7, plan Phase 12).

Then post-v1: Calendar mode → custom themes.

## 13. Left to the builder

- Exact design-token names and values, type scale, and motion curves (within §6).
- Cache-depth numbers and tuning (§5).
- Keyboard shortcut map beyond the Gmail-standard set.
- Library choices not fixed by the plan (e.g. virtualization library, command-palette component), as long as they don't add a web-page feel.
- Calendar detail scope beyond view/create/edit/RSVP.
