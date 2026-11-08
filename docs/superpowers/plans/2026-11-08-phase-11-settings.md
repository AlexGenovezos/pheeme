# Phase 11 Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 11 (issue #19) by adding the settings it lists that Pheeme doesn't have yet: list density, hiding the reading pane, default reply, confirm before sending, per-account Inbox tabs, a notification schedule, clearing downloaded mail, and a way back into the setup guide.

**Architecture:** Each setting is a `SettingDef` row in `src/settings/pages.tsx`, or a page `Component` when it's per account. Settings only the webview needs are stored in localStorage, the way existing settings are (`composeSettings.ts`, `readingSettings.ts`, the `uiStore` layout). Settings Rust has to know (Inbox tabs, the notification schedule) go in the `app_settings` key/value table through `db::settings`. Each setting takes effect straight away, with no restart.

**Tech Stack:** React 18 + Zustand + Vitest. Rust (Tauri 2, SQLx/SQLite, chrono).

**Spec:** Issue #19, which is design doc §4 items 10–11 and §12 step 11 (`docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md`). Where this plan narrows or departs from the issue, the change is marked *(call)*.

## Global Constraints

- Every new setting shows its new value straight away and keeps it after a restart.
- No `tauri-plugin-store` *(call)*: localStorage and `app_settings` already persist settings, and adding a third store would duplicate them.
- New Tauri commands follow the IPC pattern: a fn in `src-tauri/src/commands/<domain>.rs`, registered in `lib.rs`, a typed wrapper in `src/lib/tauri.ts` or `src/desktop/api.ts`, and a handler in `src/preview/install.ts` so `npm run dev` keeps working.
- Commands reject with `CommandError { code, message }`.
- Any changed or new `sqlx::query!` needs `cargo sqlx prepare` (run from `src-tauri/`), and the regenerated `.sqlx/` gets committed.
- Copy uses sentence case and plain words in the existing tone ("Show sidebar", "Mailboxes and labels on the left."). No exclamation marks.
- CSS uses design tokens only, because `npm run lint` runs the token check.
- Gate for each task: `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run test` for frontend changes; `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` (from `src-tauri/`) for Rust changes.
- Commit messages use conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hiding a tab while it's open:** the view moves to that account's Primary; it doesn't stay on an empty, hidden mailbox. (Task 5 test `hiding the open tab goes to Primary`.)
2. **Counts with hidden tabs:** Primary's unread badge includes the unread mail from hidden tabs, account by account, when All Inboxes covers two accounts with different settings. (Task 4 test `unread_counts_primary_absorbs_hidden_tabs_per_account`.)
3. **Work hours across midnight:** a 22:00–06:00 schedule alerts at 23:30 and 05:59 and stays quiet at 12:00. (Task 6 test `schedule_overnight_range_wraps_midnight`.)
4. **Clearing while composing:** draft bodies survive "Clear downloaded mail", so an open or saved draft doesn't lose its text. (Task 7 test `clear_bodies_keeps_drafts`.)
5. **Moving through the list with the reading pane hidden:** the arrow keys and j/k move a highlight; they don't open each conversation (which would swap the list away after one keypress). Enter opens the highlighted one, `u` goes back to the list with that row still highlighted. (Task 2 tests.)

---

## PR layout (gh stack, bottom to top)

1. `phase11-layout`: Tasks 1–2 (list density, reading pane)
2. `phase11-compose`: Task 3
3. `phase11-inbox-tabs`: Tasks 4–5
4. `phase11-notify-schedule`: Task 6
5. `phase11-privacy-help`: Tasks 7–8
6. Task 9 (docs) goes on the top PR.

---

### Task 1: List density

Comfortable is today's three-line row (sender, subject, snippet). Compact drops the snippet and makes rows shorter *(call: Gmail's compact is one line, but two lines fit Pheeme's narrow list pane)*.

**Files:**
- Modify: `src/store/uiStore.ts` (persisted `listDensity`)
- Modify: `src/mail/ThreadList.tsx:38-45,177` (row height by density), `src/mail/ThreadRow.tsx` (no snippet when compact)
- Modify: `src/styles/tokens.css` (add `--row-height-thread-compact: 56px`), `src/mail/mail.css`
- Modify: `src/settings/pages.tsx` (Appearance › Layout › "List density")
- Test: `src/store/uiStore.test.ts` (create if absent), `src/mail/ThreadList.test.tsx`

**Interfaces:**
- Produces: `type ListDensity = "comfortable" | "compact"`; on `UiState`: `listDensity: ListDensity`, `setListDensity(d: ListDensity): void`, persisted in the `pheeme.layout` object as `listDensity` (a missing or unknown value reads as `"comfortable"`).

- [ ] **Step 1: Write failing tests**
  - uiStore: `setListDensity("compact")` then `readLayout()` from the same storage gives `listDensity: "compact"`; stored `{listDensity: "tiny"}` reads `"comfortable"`.
  - ThreadList: with `listDensity: "compact"` the rendered row has no snippet text (a fixture thread's snippet is absent from the DOM) and the listbox has `data-density="compact"`.
- [ ] **Step 2: Run** `npm run test -- src/store/uiStore.test.ts src/mail/ThreadList.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `listDensity` to `PaneLayout`, `readLayout`, `persistedOf`. `rowHeightEstimate` reads `--row-height-thread-compact` when compact (fallback 56) and `--row-height-comfortable` otherwise, and the virtualizer re-measures when density changes (put density in the `key` or call `virtualizer.measure()`). The settings row is a `SegmentedControl` with Comfortable and Compact: title "List density", description "Compact rows leave out the preview line, so more conversations fit."
- [ ] **Step 4: Run the tests and the frontend gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): list density`.

### Task 2: Hide the reading pane

When the reading pane is off, the shell shows the sidebar and one main column. That column holds the list, or the open conversation in its place, with a Back button. A highlight (`cursor`) moves through the list without opening anything.

**Files:**
- Modify: `src/store/uiStore.ts` (persisted `readingPane: boolean`, session `cursor: ThreadKey | null`)
- Modify: `src/mail/actions.ts:97-105,789-810` (`targets`, `moveSelection`, `openFocused`)
- Modify: `src/keyboard/appCommands.ts:173-178` (`conversation.close` restores the cursor)
- Modify: `src/shell/AppShell.tsx`, `src/shell/shell.css` (single-column layout: `data-reading-pane="off"`), `src/shell/ViewPane.tsx` (Back button when off), `src/mail/ThreadList.tsx` (highlight = `cursor` when off)
- Modify: `src/settings/pages.tsx` (Appearance › Layout › "Show reading pane")
- Test: `src/mail/actions.test.ts`, `src/shell/AppShell.test.tsx`

**Interfaces:**
- Produces: on `UiState`: `readingPane: boolean` (default `true`, persisted in `pheeme.layout`), `setReadingPane(on: boolean): void`, `cursor: ThreadKey | null`, `setCursor(key: ThreadKey | null): void`. `setMailbox` clears `cursor`.

- [ ] **Step 1: Write failing tests** (actions.test.ts, with `readingPane: false`, three fixture threads, nothing open)
  - `moveSelection(1)` sets `cursor` to the first key and leaves `openThread` null; a second call moves `cursor` to the second key.
  - `openFocused()` opens `cursor` (`openThread === cursor`).
  - `targets()` with nothing checked and nothing open returns `[cursor]`.
  - With a thread open, `moveSelection(1)` moves `openThread` to the next thread (j/k inside a conversation, as today).
  - Running `conversation.close` sets `openThread` to null and `cursor` to the thread that was open.
  - With `readingPane: true`, all of the above behaves as today (existing tests stay green).
  - AppShell.test: with `readingPane: false` and nothing open, the "Conversations" region renders and the "Reading pane" region doesn't. With a thread open it's the other way round, and a "Back to list" button calls `conversation.close`.
- [ ] **Step 2: Run** `npm run test -- src/mail/actions.test.ts src/shell/AppShell.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `moveSelection` and `openFocused` use `cursor` only when `!readingPane && openThread === null`. Turning the reading pane off with a thread open keeps it open (shown full-width). The list's Divider and the list width don't apply when the pane is off. The settings row is a `Switch`: title "Show reading pane", description "Off: conversations open in place of the list. Press U or Back to return."
- [ ] **Step 4: Run the tests and the frontend gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): option to hide the reading pane`.

### Task 3: Default reply and confirm before sending

The default reply follows Gmail: it decides which reply button comes first in the toolbar and is the primary (filled) one. The R and A shortcuts don't change *(call)*. "Confirm before sending" asks inside the compose panel, the same way the existing "Save this message as a draft?" prompt does.

**Files:**
- Modify: `src/compose/composeSettings.ts` (`defaultReply`, `confirmSend`)
- Modify: `src/shell/ViewPane.tsx:156-171` (order and variant)
- Modify: `src/compose/composeStore.ts:399` (`send` → `requestSend`, `confirmingSend` state), `src/compose/ComposePanel.tsx:56-60,128-145,327`
- Modify: `src/settings/pages.tsx` (Compose › Replies › "Default reply"; Compose › Sending › "Confirm before sending")
- Test: `src/compose/composeSettings.test.ts` (create), `src/compose/ComposePanel.test.tsx` (or the existing compose test file), `src/shell/ViewPane.test.tsx`

**Interfaces:**
- Produces: `useComposeSettings` adds `defaultReply: "reply" | "replyAll"` (default `"reply"`, key `pheeme.default-reply`), `setDefaultReply`, `confirmSend: boolean` (default `false`, key `pheeme.confirm-send`), `setConfirmSend`. On the compose store: `requestSend(id: number): void` (asks first when `confirmSend` is on, otherwise calls `send`), `cancelSend(id: number): void`, and `ComposeWindow.confirmingSend: boolean`.

- [ ] **Step 1: Write failing tests**
  - Settings round-trip through localStorage. Unknown stored values fall back to the defaults.
  - ViewPane: with `defaultReply: "replyAll"` the first reply button is "Reply all" and it has the primary variant class.
  - ComposePanel: with `confirmSend: true`, clicking Send (and pressing Cmd/Ctrl+Enter) shows an `alertdialog` named "Send this message?" and doesn't call `sendEmail`. Its "Send" button calls `sendEmail` once. "Keep editing" closes the dialog. With `confirmSend: false`, Send calls `sendEmail` straight away.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** The panel's Send button and Cmd/Ctrl+Enter call `requestSend`. Escape while confirming acts like "Keep editing". Settings copy:
  - "Default reply": SegmentedControl with Reply and Reply all. Description: "Which reply button comes first, and stands out, above a conversation."
  - "Confirm before sending": Switch. Description: "Ask before each message leaves, in addition to Undo send."
- [ ] **Step 4: Run the tests and the frontend gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): default reply and confirm before sending`.

### Task 4: Inbox tabs, backend

Each account stores which of Social, Promotions, Updates and Forums are hidden. Primary is always shown. Mail from a hidden tab counts as Primary everywhere Primary is worked out: the list, the unread counts, and new-mail alerts.

**Files:**
- Modify: `src-tauri/src/db/settings.rs` (key `inbox_tabs.<account_id>`, JSON array of hidden label ids)
- Modify: `src-tauri/src/mail.rs:34-41,518-525,734-740` (Primary excludes only the shown categories; counts take per-account exclusions)
- Modify: `src-tauri/src/db/threads.rs:870-915` (`unread_counts` takes the exclusions)
- Modify: `src-tauri/src/sync/events.rs:15-45`, `src-tauri/src/sync/engine.rs:336-342` (`NewMail::from_message` takes the account's hidden tabs)
- Modify: `src-tauri/src/accounts.rs:441-458` (delete the key when an account is removed)
- Create: `src-tauri/src/commands/` handlers `inbox_tabs(account_id) -> Vec<String>` and `set_inbox_tabs(account_id, hidden: Vec<String>) -> Vec<String>` in `commands/threads.rs`, registered in `lib.rs`; `set_inbox_tabs` emits `sync:labels_updated` for the account so counts and lists reload.
- Test: in-module `#[cfg(test)]` tests in the files above.

**Interfaces:**
- Produces (Rust):
  - `db::settings::inbox_tabs(pool, account_id: &str) -> Result<Vec<String>>`: hidden labels, keeping only members of `mail::OTHER_CATEGORIES`.
  - `db::settings::set_inbox_tabs(pool, account_id: &str, hidden: &[String]) -> Result<()>`.
  - `db::settings::delete_inbox_tabs(pool, account_id: &str) -> Result<()>`.
  - `mail::primary_excludes(hidden: &[String]) -> Vec<String>`: `OTHER_CATEGORIES` minus `hidden`.
  - `threads::unread_counts(pool, account_ids: &[String], excludes: &HashMap<String, Vec<String>>)`: the Primary branch's `NOT EXISTS` matches against `excludes[account]`, passed as a JSON array of `[account_id, label_id]` pairs (`?2`) and joined through `json_each`.
  - `NewMail::from_message(message, hidden_tabs: &[String]) -> Option<NewMail>`.
- Produces (TS): `getInboxTabs(accountId: string): Promise<string[]>` and `setInboxTabs(accountId: string, hidden: string[]): Promise<string[]>` in `src/lib/tauri.ts`, plus handlers in `src/preview/install.ts` that keep the value in memory and emit `sync:labels_updated`.

- [ ] **Step 1: Write failing tests**
  - `inbox_tabs_round_trip_and_drop_unknown`: set `["CATEGORY_SOCIAL","CATEGORY_PERSONAL","X"]`, then read `["CATEGORY_SOCIAL"]`. An account with nothing stored reads `[]`.
  - `list_primary_includes_hidden_tab_mail`: seed INBOX threads t1 (no category), t2 (`CATEGORY_SOCIAL`), t3 (`CATEGORY_PROMOTIONS`). With Social hidden, listing Primary gives {t1, t2} and listing Social still gives {t2}.
  - `unread_counts_primary_absorbs_hidden_tabs_per_account`: account a hides Social, account b hides nothing, each has one unread Social thread and one unread uncategorised inbox thread. Counts over [a, b]: `CATEGORY_PERSONAL` = 3, `CATEGORY_SOCIAL` = 2.
  - `new_mail_alerts_for_hidden_tab`: an unread INBOX+`CATEGORY_SOCIAL` message gives `Some` with `hidden_tabs = ["CATEGORY_SOCIAL"]` and `None` with `[]`.
  - `remove_account_forgets_inbox_tabs`: the key is gone after `remove_account`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml inbox_tabs list_primary unread_counts new_mail remove_account`. Expected: FAIL.
- [ ] **Step 3: Implement.** `list_threads` reads the hidden tabs of `account_ids[0]` when `also_label_id == CATEGORY_PERSONAL` (category refs are always for one account). `mailbox_counts` builds `excludes` for every account in `account_ids`. The engine reads the hidden tabs once per incremental sync, before the new-mail loop. Then run `cargo sqlx prepare`.
- [ ] **Step 4: Run the tests and the Rust gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): per-account inbox tabs (backend)`.

### Task 5: Inbox tabs, UI

A new "Inbox tabs" page in the Mail group lists each account with switches for Primary (on and disabled) and the four other tabs. A hidden tab disappears from the sidebar, the go-to commands and preloading.

**Files:**
- Create: `src/store/inboxTabsStore.ts`, `src/settings/InboxTabsSettings.tsx`
- Modify: `src/settings/pages.tsx` (page `inboxTabs`, icon `LayoutList`, group "Mail", after Accounts; keywords categories, tabs, social, promotions, updates, forums, primary), `src/shell/Sidebar.tsx:177-193`, `src/keyboard/appCommands.ts:86` (a hidden tab's go-to command opens Primary), `src/mail/preload.ts:77`
- Test: `src/store/inboxTabsStore.test.ts`, `src/settings/InboxTabsSettings.test.tsx`, `src/shell/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `getInboxTabs`, `setInboxTabs` (Task 4).
- Produces: `useInboxTabs` with `hidden: Record<string, string[]>`, `load(accountIds: string[]): Promise<void>`, `setHidden(accountId: string, label: string, hidden: boolean): Promise<void>`, and selector `visibleCategories(accountId): MailboxRow[]` (`CATEGORIES` minus hidden).

- [ ] **Step 1: Write failing tests**
  - Sidebar: with Social hidden for account a, a's group has no "Social" row and still has "Primary".
  - `hiding the open tab goes to Primary`: mailbox is `{accountId:a, labelId:"INBOX", category:"CATEGORY_SOCIAL"}`. After `setHidden(a, "CATEGORY_SOCIAL", true)` the mailbox is a's Primary.
  - InboxTabsSettings: toggling "Promotions" for an account calls `setInboxTabs(id, ["CATEGORY_PROMOTIONS"])`. The Primary switch is disabled and checked.
  - A failed `setInboxTabs` reverts the switch and shows the error message.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Load on app start for all accounts (next to where `labelStore` loads) and again after an account is added. The store updates optimistically, then confirms with the returned list. Page copy: lead line "Choose which tabs each inbox shows. Mail from a hidden tab shows in Primary, and alerts like Primary mail."
- [ ] **Step 4: Run the tests and the frontend gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): inbox tabs page`.

### Task 6: Notification schedule

One schedule covers every account: Any time, Work hours or Off. Work hours means a start hour, an end hour and "Weekdays only", in local time. Alerts outside the schedule are dropped, not saved for later *(call)*. The per-account switches still work, and Off pauses every account without changing those switches.

**Files:**
- Modify: `src-tauri/src/db/settings.rs` (key `notify_schedule`, JSON)
- Modify: `src-tauri/src/desktop.rs:34-41,79-133,153-161` (`DesktopSettings.schedule`, check before showing)
- Create: `src-tauri/src/desktop/schedule.rs` (type and pure check)
- Modify: `src-tauri/src/commands/settings.rs` (`set_notification_schedule`), `lib.rs`
- Modify: `src/desktop/api.ts`, `src/preview/install.ts`, `src/settings/NotificationsSettings.tsx` (new "Schedule" section above the per-account rows)
- Test: `schedule.rs` unit tests, `src/settings/NotificationsSettings.test.tsx`

**Interfaces:**
- Produces (Rust): `#[serde(rename_all = "camelCase")] pub struct NotifySchedule { pub mode: ScheduleMode, pub start_hour: u8, pub end_hour: u8, pub weekdays_only: bool }` with `ScheduleMode { Always, WorkHours, Off }` serialised `"always" | "workHours" | "off"`. Default: `Always`, 9, 17, `true`. Also `fn allows(&self, at: chrono::NaiveDateTime) -> bool`, `db::settings::notify_schedule(pool) -> Result<NotifySchedule>` (bad JSON reads as the default), `set_notify_schedule(pool, &NotifySchedule)`, and `desktop::set_schedule(app, NotifySchedule) -> Result<DesktopSettings>` (hours must be 0–23; otherwise it fails with "Pick hours between 0 and 23.").
- Produces (TS): `DesktopSettings.schedule: { mode: "always" | "workHours" | "off"; startHour: number; endHour: number; weekdaysOnly: boolean }` and `setNotificationSchedule(schedule): Promise<DesktopSettings>`.

- [ ] **Step 1: Write failing tests** (`schedule.rs`)
  - `schedule_work_hours_weekday`: 9–17 weekdays allows Mon 09:00 and Fri 16:59, and blocks Mon 17:00, Mon 08:59 and Sat 12:00.
  - `schedule_overnight_range_wraps_midnight`: 22–6 allows 23:30 and 05:59 and blocks 12:00.
  - `schedule_equal_hours_is_all_day`: 9–9 allows 03:00.
  - `schedule_off_and_always`: Off blocks everything, Always allows everything.
  - NotificationsSettings.test: choosing "Work hours" calls `setNotificationSchedule` with `mode: "workHours"` and shows the start/end selects and the "Weekdays only" switch. They're hidden for "Any time".
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml schedule_` and `npm run test -- src/settings/NotificationsSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `sync_event`, read the schedule with the account list and check `allows(Local::now().naive_local())`. When it says no, log `tracing::info!(%account_id, alerts, "new mail not alerted: outside the notification schedule")` with counts only. The selects show hours as `09:00`. UI copy:
  - Section "Schedule", row "When to alert" with a SegmentedControl: Any time, Work hours, Off.
  - Description: "Outside these hours new mail arrives quietly. Your system's Focus / Do Not Disturb still applies."
- [ ] **Step 4: Run the tests and both gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): notification schedule`.

### Task 7: Clear downloaded mail

This drops every cached email body and attachment for all accounts. The conversation list, labels and header search stay, and opening an email downloads it again *(call: the issue says "clear local cache"; wiping and re-syncing everything would mean re-downloading hundreds of thousands of messages, while this removes the email contents, which is the privacy point)*. Drafts keep their bodies.

**Files:**
- Modify: `src-tauri/src/db/messages.rs` (new `clear_bodies`)
- Modify: `src-tauri/src/body_retention.rs` (`clear_all(db) -> Result<u64>`, batched like `trim`)
- Modify: `src-tauri/src/attachment_cache.rs` (`clear(&self) -> u64`, which returns the bytes freed, holding the sweep lock so a running sweep or download doesn't race it)
- Create: command `clear_downloaded_mail() -> ClearedDto { messages: u64, bytes: u64 }` in `src-tauri/src/commands/attachments.rs`, registered in `lib.rs`; it emits `sync:messages_updated` for each account so `threadStore` drops what it holds.
- Modify: `src/lib/tauri.ts`, `src/preview/install.ts`, `src/settings/pages.tsx` (Appearance › Reading gets a new section "Privacy", which also takes `reading.preloadImages`)
- Test: Rust tests in `messages.rs`/`body_retention.rs`/`attachment_cache.rs`; `src/settings/ClearDownloadedMail.test.tsx`

**Interfaces:**
- Produces: `messages::clear_bodies(ex, limit: i64) -> Result<u64>` (same `SET` as `trim_old_bodies`, `WHERE body_fetched_at IS NOT NULL` and the message's `label_ids` JSON doesn't contain `DRAFT`); `clearDownloadedMail(): Promise<{ messages: number; bytes: number }>`.

- [ ] **Step 1: Write failing tests**
  - `clear_bodies_drops_every_cached_body`: three fetched messages, one 2 days old and two 400 days old. Afterwards all three have `fully_fetched = 0` and `body_text IS NULL`.
  - `clear_bodies_keeps_drafts`: a fetched message labelled `DRAFT` keeps its body.
  - `clear_attachment_cache_returns_bytes`: write two files (10 and 20 bytes). `clear()` returns 30 and both are gone.
  - UI: the "Clear downloaded mail" button asks first (an `alertdialog` that says lists and labels stay). Confirming calls `clearDownloadedMail` and shows the toast "Cleared 3 emails and 30 bytes of attachments". Cancelling calls nothing.
- [ ] **Step 2: Run** the Rust tests (`cargo test ... clear_`) and the UI test. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `cargo sqlx prepare`. Row copy:
  - Title: "Clear downloaded mail".
  - Description: "Remove the email text and attachments saved on this computer. Your conversation list and labels stay, and an email downloads again when you open it."
  - Button: "Clear…". Format bytes with the existing size formatter if there is one (search `formatBytes`/`formatSize` in `src/`).
- [ ] **Step 4: Run the tests and both gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): clear downloaded mail`.

### Task 8: Setup guide entry

The setup guide is the onboarding flow, and today Add account is the only way back into it. Add a "Help" section to Settings › About with a row "Google Cloud setup guide" and an "Open guide" button, plus a palette command `help.setupGuide` ("Open setup guide"). Both open the onboarding screen the way Add account does *(call: Onboarding has no read-only mode, and its guide steps are the tutorial)*.

**Files:**
- Modify: `src/settings/AboutSettings.tsx` (uses `AddAccountContext`), `src/keyboard/appCommands.ts` (new command, which needs a way to reach `addAccount`: expose `openSetupGuide` through a tiny `src/onboarding/guideStore.ts` that `App.tsx` subscribes to)
- Test: `src/settings/Settings.test.tsx` (or AboutSettings test), `src/keyboard/appCommands` test if present

**Interfaces:**
- Produces: `useSetupGuide` with `requested: number` and `open(): void` (it bumps the counter). `App.tsx` calls `addAccount()` when `requested` changes.

- [ ] **Step 1: Write failing tests.** Clicking "Open guide" in About calls the `AddAccountContext` handler. Running `help.setupGuide` bumps `useSetupGuide.requested`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Row description: "Step-by-step help creating the Google Cloud client Pheeme signs in with. You can connect another account at the end, or close it."
- [ ] **Step 4: Run the tests and the frontend gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): reopen the setup guide`.

### Task 9: Docs and tracking

- [ ] Update `CLAUDE.md`'s current state (Phase 11 built) and its Frontend State section (`inboxTabsStore`). Update `docs/superpowers/specs/...` only if something above contradicts it.
- [ ] Tick #19's checklist, noting the calls above against the matching items. Update epic #21's phase line and status paragraph when the stack merges.
- [ ] Commit `docs: phase 11 settings`.
