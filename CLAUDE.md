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
| `gmail/` | Gmail REST API client. `auth.rs` is OAuth (PKCE + loopback redirect); `usage.rs` counts, in memory, each account's Gmail quota units per minute for the last hour by source (`usage_source` scopes: the outbox in `sync/manager.rs`, assistants in `local_api`; else by priority) and Gmail's rate-limit refusals, for Settings › Accounts (`gmail_quota_usage`) |
| `sync/` | `engine.rs` initial/incremental (`history.list`)/expiry-reconcile/backfill; `outbox.rs` optimistic ops + safe sends; `manager.rs` per-account scheduling and triggers; `connectivity.rs` notices when Google can't be reached (a sync fails to connect): syncs and queued changes pause, a light check runs every 5 s, and reconnecting syncs every account and makes waiting changes due (`network:status`, one sidebar note); `api.rs` the `MailApi` trait (`fake.rs` is the in-memory Gmail for tests) |
| `http.rs` | Every `reqwest` client is built here (`client`, `client_builder`), which installs the rustls crypto provider; clippy rejects `reqwest::Client::new`/`builder` and `reqwest::get` |
| `cadence.rs` | One clock for the background checks: mail (10 s), calendar and tasks (60 s, 15 s in front) each sleep until the next whole multiple of their period after a shared start, so they wake the computer together |
| `render.rs` | Email HTML sanitizer (`ammonia`) and signed `pheeme-att` URLs for inline `cid:` images |
| `attachment_cache.rs` / `attachment_kind.rs` | Attachment bytes on disk (`{cache}/attachments/{account}/{message}/{row}`): a sweep at launch (and after every 50 MB of downloads) removes orphans, then the least recently used files past 500 MB; `clear` deletes them all. `attachment_kind` decides which files the preview shows and which open in the default app |
| `telemetry.rs` | Anonymous usage ping (on by default; Settings › Diagnostics and the welcome screen turn it off): once a day after an account is connected, a random install ID, version, OS and chip go to the diagnostics Worker's `/v1/ping`. Never from debug builds. `node scripts/installs.mjs` reads the counts |
| `body_retention.rs` | Periodic trim (launch, then every 6 h): bodies of mail older than the 180-day body window go back to metadata only 30 days after they were downloaded; `clear_all` (Clear downloaded mail) does it for every body at once |
| `mail.rs` | Tauri-free mail service the commands call: cached list/thread/label reads, changes via the outbox |
| `contacts.rs` | Tauri-free recipient suggestions for To/Cc/Bcc, answered locally: addresses from synced mail (the `contacts` table, kept by a trigger on `messages`) plus Google Contacts and "Other contacts" downloaded through the People API (`gmail/people.rs`) after launch and every 6 h. Settings › Contacts walks an account through turning the People API on and signing in again |
| `calendar/` | Tauri-free Calendar mode backend (the UI is `src/calendar/`; reads and writes). `service.rs` answers calendars, the events in a range (each with `canEdit`) and searches over them (`search_calendar_events`, every word in title, place, description or guests) from the cache and runs its own sync loop (60 s, 15 s while Calendar mode is in front), apart from mail sync; `sync.rs` syncs each calendar with its Calendar API `syncToken` (`singleEvents=false`; 410 Gone means a full re-sync); `recurrence.rs` expands repeating events locally (`rrule`); `gmail/calendar.rs` is the API client. Access is an incremental consent (`ClientChoice::Calendar`, `auth::CALENDAR_SCOPES`) asked only when the user opens the calendar; status changes emit `calendar:access`, cache changes `calendar:updated`. Writes go straight to the Calendar API, not the outbox, and reach the cache only after Google confirms: `writes.rs` (create, edit, delete, move, copy, with `If-Match` etags; a 412 refetches and fails with `conflict`), `repeating.rs` (edits and deletes of repeating events in three scopes: this, this and following, all), `rsvp.rs` (answers an invite, always `sendUpdates=all`; `respond_to_invite` serves Mail's invite card) and `edit.rs` (`EventEdit` validation and body building). `ics.rs` parses the invitations emails carry (RFC 5545: METHOD, UID, SEQUENCE, `TZID` including Outlook's Windows names and unknown zones through their `VTIMEZONE`, all-day, RRULE, RECURRENCE-ID, guests' PARTSTAT, meeting links; fixtures from Google, Outlook and Apple in `calendar/fixtures/`), and `invite.rs` answers `message_invite`: the invitation with the live event from the cache by iCalUID (primary calendar first, the occurrence for a RECURRENCE-ID) and the resource to import when it isn't there. `MailService::invite_text` reads the message's `text/calendar` part (else its `.ics` file) from the attachment cache or Gmail. `sendUpdates` defaults to `none`. Commands wrap in `user_action`. `reminders.rs` fires each shown event's notification reminders (its own, else the calendar's defaults; all-day events only their own) as desktop notifications: planned from the cache 24 h ahead, re-planned on `calendar:updated`/`calendar:access` and before each fires, a reminder up to 5 min late still fires once (sleep, late launch), what fired is kept in `calendar_reminders_fired`; declined events, hidden calendars, Settings › Notifications (Event reminders switch, schedule) and OS permission skip it. `desktop.rs` shows it (`NotifyTarget::Event`); a click opens Calendar mode on the event's day with its popover |
| `tasks/` | Tauri-free Google Tasks backend (the UI is `src/tasks/`). `service.rs` answers task lists, a list's tasks (subtasks after their parent) and tasks due in a date range from the cache, and runs its own sync loop on the calendar's cadence (60 s, 15 s while Calendar mode is in front, right after a write), apart from mail and calendar sync. `sync.rs` polls each list with `updatedMin` (the Tasks API has no sync token; deleted tasks come as `deleted: true`) and reads it in full every 6 h. Polled only for accounts that allowed calendar access (the `tasks` scope is part of `auth::CALENDAR_SCOPES`) or were triggered; its own status in `tasks_access`, so a Tasks API that is off never affects the calendar. Emits `tasks:updated` and `tasks:access`. `writes.rs` (add, edit, complete, delete, reorder, indent, move to another list; create, rename, delete lists) goes straight to the Tasks API, not the outbox, and caches only what Google confirms; a write holds the account's sync gate so a running sync can't cache an older version. `gmail/tasks.rs` is the API client. Commands wrap in `user_action` |
| `local_api/` | The local API for AI assistants (and later scripts): the only way in for MCP. Enforces the Settings › MCP switch, per-client tokens (SHA-256 in `assistant_clients`) and the activity log (each call's exact arguments and what came back: a write's answer, a read's ids), and calls the services above, never SQL of its own. Tools are declared once in `requests.rs` (`Request` + `catalog`) |
| `mcp/` | The MCP server over `local_api`: Streamable HTTP on `127.0.0.1:43830/mcp` (hyper, plain JSON, no SSE), bearer token, Host/Origin checked against loopback. Runs only while assistants are allowed |
| `filters.rs` | Every Gmail filter, described in words with label names (sender rules are the narrow kind `sender_rules.rs` edits) |
| `labels.rs` | Tauri-free label service: create, rename/re-nest (cascading to sublabels), colour, visibility and delete (with sublabels), straight to Gmail's labels API (not the outbox), then written to the cache |
| `compose/` | Tauri-free compose service: MIME building (`lettre`), Reply/Reply All/Forward templates, staged attachments, Gmail drafts, sends (with undo window) via the outbox |
| `accounts.rs` | Tauri-free account service: sign-in flow, list/remove, access tokens (cached in memory) |
| `identity.rs` | App identifier and keychain service constants |
| `secrets.rs` | OS keychain secret store: all accounts in one cached item (`accounts`), read once per launch; tokens never go in SQLite |

### Frontend State

Eleven Zustand stores:
- `accountStore` — connected accounts (load, upsert, remove)
- `mailStore` — the active mailbox or search results (paged, optimistic patches), reloaded on `sync:*` events; search combines instant local matches with background Gmail pages
- `labelStore` — per-account labels, label counts and category counts, plus the All Inboxes unread count
- `threadStore` — thread-detail cache with prefetch; evicts on `sync:messages_updated`
- `inboxTabsStore` — per-account hidden Inbox tabs (Primary is always shown)
- `uiStore` — active mailbox, search text and account scope, selected thread, multi-select, pane layout
- `calendarStore` (`src/calendar/`) — Mail or Calendar in front (`mode`), the Day/Week/Month view (both remembered), the day shown, each account's calendars and access, the events of the months around the days on screen (kept in memory, so switching views or stepping draws at once; a day outside them shows only once its events are read), the open event popover, and the email pinned beside the calendar (`pinned`, with the time Day/Week open scrolled to)
- `tasksStore` (`src/tasks/`) — every account's task lists and tasks access, each list's tasks (read while the Tasks panel is open), the dated tasks of the days the calendar shows, the task open for editing, and whether the panel is open (remembered); changes show at once, go straight to the Tasks API, and snap back with a toast if Google refuses
- `editStore` (`src/calendar/`) — calendar editing: the new event being placed (quick create), the open editor, the question a write waits on (`ask`), an event being dragged or saved somewhere new, events hidden while being deleted, and calendar search
- `composeStore` (`src/compose/`) — open compose panels (autosave, close prompt) and sends waiting out undo or Gmail's confirmation; a refused or undone send reopens its panel
- `signatures` (`src/compose/signatures.ts`) — per-account signature choices for new messages and replies/forwards (Gmail's, the account's own, or none) and the last fetched Gmail signatures (`users.settings.sendAs`), both in localStorage. The signature sits in the body as one `div.gmail_signature` block (`SignatureNode`), above the separately held quote; Settings › Signatures edits them

Calendar mode (`src/calendar/`) replaces the mail panes when `calendarStore.mode` is `calendar` (Mail | Calendar switch at the top of the sidebar, `mod+1`/`mod+2`). Dates are `YYYY-MM-DD` strings and times UTC ms shown in the first account's Google Calendar time zone (`dates.ts`); `layout.ts` places events (overlap columns, all-day band, month cells with "+N more"). In Calendar mode the conversation commands aren't registered and mailbox commands lose their keys, so `d`/`w`/`m`/`t`/`j`/`k`/`g` are free for the calendar. Editing follows the website: click or drag empty hours/days for the quick-create popover (`QuickCreate.tsx`); `c` and Create open quick add (`QuickAdd.tsx`), where a sentence like "Lunch with Sam Friday at noon at Joe's /work" becomes the event, highlighted as it's read (`sentence.ts`: chrono-node and rules, no AI; time, repeat, length, place after "at", people after "with" offered from contacts and invited only when picked, `/calendar`, and "todo …" for a Google Task), with Undo on the toast; More options or `e` for the editor dialog (`EventEditor.tsx`, its model and the only-what-changed `EventEdit` in `eventForm.ts`), drag to move or the bottom edge to resize (`drag.ts`, targets marked `data-cal-drop`), Delete/Backspace, Duplicate and Copy to from the popover, `/` to search (`CalendarSearch.tsx`). `actions.ts` asks the repeating-event and send-to-guests questions (`EditPrompt.tsx`), writes, and on `conflict` reloads; only events with `canEdit` show edit affordances.

Calendar inside Mail: a message with a `text/calendar` part or `.ics` file (`src/mail/invitePart.ts`, from its attachment list, so the card holds its place from the first frame) gets the invite card at the top of the conversation (`InviteCard.tsx`): what, when, where (Join for a meeting link), organizer and guests' answers, Yes / Maybe / No and More options (a note; "only this event" for a series), and a mini day view of the hours around it from every shown calendar with clashes named (`invite.ts` holds the rules: the live event over the email's, the cancelled/moved/updated notice, clashes). It answers on the calendar's copy when cached, else by UID through `respond_to_calendar_invite`; an account without calendar access sees the invitation and an Allow button. **Open … in Calendar** and **Create event from email** (`mailActions.ts`; toolbar, More actions, palette, `shift+e`) switch to Calendar mode on that day with the email pinned in a left column (`PinnedEmail.tsx`: the card, the start of the text, Unpin, Back to Mail). Create event fills step 5's editor from the email (`fromEmail.ts`): the subject without `Re:`/`Fwd:`, the thread's people but you, a link back to Gmail plus the start of the text, and the first time `chrono-node` finds in the subject and text (relative to when it was sent; a date alone is all-day), else the next half hour, on the receiving account's calendar. The unnamed `text/calendar` part isn't listed as an attachment.

Google Tasks UI lives in `src/tasks/`. The Tasks panel (`TasksPanel.tsx`) sits at the right edge in both modes, opened from the rail beside it or `mod+shift+t` (`view.toggleTasks`): every account's lists, with add, edit (title, details, due date), complete, delete, drag to reorder, indent/outdent (`mod+]`/`mod+[`) and move to another list, plus create/rename/delete lists; an account without access gets Allow, one whose Tasks API is off gets a link to turn it on. `outline.ts` holds the ordering rules (completed split, where a drag or indent lands as `parent`/`previous`). Dated tasks show on the calendar through `DatedTasks.tsx` (`useDatedTasks`, `TaskChip`) and `gridLayout.ts`, which places them in the first free row of their day after the events; the calendar sidebar's task-list ticks (`SidebarTaskLists.tsx`) choose which lists show.

Settings is a dialog over the app (`src/settings/`). Pages, sections and rows are declared as data in `src/settings/pages.tsx`: a new setting is one `SettingDef` there. Keyboard shortcuts come from the command registry; user rebindings are overrides stored by `src/keyboard/bindings.ts`, so label a button with `useKeybinding(commandId)` rather than a literal key.

Label UI lives in `src/labels/`: the label tree (nesting by `/` in names), palette and chip colours, the searchable picker behind Label as… and Move to…, and the create/edit/delete dialogs.

Compose panels dock at the bottom of the window (`src/compose/ComposeHost.tsx`); the TipTap editor is lazy-loaded with the panel. A panel is a `data-owns-keys` region, so single-key shortcuts don't fire inside it. Mail actions (archive, trash, star, read, labels, reply, new message) live in `src/mail/actions.ts`, shared by buttons, menus and shortcuts. Clicking an attachment (or Space on it) opens a Quick Look-style preview over the blurred app (`src/mail/preview/`): PDFs (pdf.js), Word (docx-preview, in a script-less sandboxed frame), PowerPoint (`@aiden0z/pptx-renderer`, slides mounted as they scroll into view, external media blocked), spreadsheets and CSV, images and text, each reader lazy-loaded; opening a conversation prefetches its attachments into the disk cache. Browser preview (`npm run dev`) answers every command from `src/preview/` fixtures, which mutate and emit `sync:messages_updated` like the app.

The speed reader (`src/speedread/`) flashes one word at a time from emails that are mostly prose. `text.ts` decides which emails qualify and extracts their paragraphs, `words.ts` holds the focus-letter and pause rules, and its settings (`settings.ts`) are shared by the reader dialog and Settings › Appearance.

### Database Schema Summary

Twenty-one tables.
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
- `calendars` / `events` — Each account's Google calendars (with `hidden`, Pheeme's local sidebar tick, and the sync token) and their events; a repeating event is stored once (`recurrence`) with its changed or cancelled occurrences (`recurring_event_id`), and expanded when read
- `calendar_reminders_fired` — Event reminders already shown (or dropped for the schedule), per occurrence and lead time, so a restart never shows one twice; pruned after 2 days
- `calendar_access` — Per account: whether calendar access was allowed and how the last calendar sync went, plus the user's Calendar time zone and week start
- `task_lists` / `tasks` — Each account's Google Tasks lists (with `hidden`, Pheeme's local sidebar tick, and the poll mark `synced_through_ms` / `full_synced_at`) and their tasks (parent, position, notes, due date, status, raw JSON)
- `tasks_access` — Per account: whether its tasks can be read (`api_disabled` means the Tasks API is off) and when they last synced, kept apart from `calendar_access`
- `assistant_clients` / `assistant_activity` — Connected MCP clients (token hashes) and their latest 1,000 tool calls with arguments and results

## Key Conventions

- **IPC pattern:** Add a Rust fn in `commands/<domain>.rs`, register it in `lib.rs`'s `Builder`, add a typed wrapper in `src/lib/tauri.ts`.
- **DB queries:** Use `sqlx::query_as!` macros for compile-time checking. All queries go in `db/<entity>.rs`.
- **Thread labels** live in the `thread_labels` table, derived from `messages.label_ids`: change message labels, then call `recompute_threads` in the same transaction.
- **Mail changes** (archive, read, star, trash, send) go through `sync::outbox`, never straight to Gmail (drafts are the exception: saved straight to the drafts API). Write transactions use `db::begin_write` (`BEGIN IMMEDIATE`).
- **Label metadata changes** (create, rename, delete, colour, visibility) go straight to Gmail through `LabelService` (`labels.rs`), not the outbox, and hold the per-account label lock. Label sync takes that lock with `try_lock`, so message sync never waits on it.
- **AI assistant tools** go in `local_api` (a `Request` variant and a `catalog` entry, side by side), calling a service; the MCP layer never needs to change. Keep writes to the outbox and services the UI uses.
- **User-initiated Gmail calls** (label, draft and search commands, outbox dispatch) run inside `gmail::user_action`, ahead of sync and the backfill: wrap any new command that calls Gmail the same way.
- **Command errors** reject with `{ code, message }` (`CommandError` in `commands/mod.rs`): branch on `code`, show `message`.
- **No layout shift when data loads:** a component must have the same size and the same elements before and after its data arrives. Render every line, button and value slot from the first frame, with a `Skeleton` (`src/components/ui/Skeleton.tsx`) or placeholder in place of the missing value; don't add or remove elements (`{data && …}`) once it loads. Messages about empty or missing data ("no network", "no results") show only after the load has finished, never during it: keep "not loaded yet" (`null`) apart from "loaded and empty" (`[]`).
- **Onboarding guide text** lives in `src/onboarding/steps.ts` and is mirrored in `docs/google-cloud-setup.md`; change both together.
- Tauri dev server runs on **port 1420** (HMR on 1421). Don't change these without updating `tauri.conf.json`.
