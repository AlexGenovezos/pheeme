# Category moves and sender rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move conversations between inbox categories from the Move to… picker or by dragging onto the sidebar, choosing at the move between "just this" and "this and future mail from the sender" (a Gmail filter), with the sender rules listed in Settings.

**Architecture:** Mail moves are label changes through the existing outbox (`modifyThreads`); a new Tauri-free `SenderRuleService` (`src-tauri/src/sender_rules.rs`) talks to Gmail's filters API straight (like `LabelService`) and reads senders from the cache. The frontend adds a category move (`src/mail/categoryMove.ts`), the choice popup (`src/mail/CategoryMoveDialog.tsx`), pointer-event drag and drop (`src/mail/dragMail.ts`), and a Settings page.

**Tech Stack:** Rust (Tauri 2, SQLx, reqwest, wiremock), React 18 + Zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-category-moves-design.md`

## Global Constraints

- Categories: Primary `CATEGORY_PERSONAL`, Social `CATEGORY_SOCIAL`, Promotions `CATEGORY_PROMOTIONS`, Updates `CATEGORY_UPDATES`, Forums `CATEGORY_FORUMS`.
- New scope `https://www.googleapis.com/auth/gmail.settings.basic` in `SCOPES`; `REQUIRED_SCOPE` stays `gmail.modify`.
- One-off moves need nothing new and never wait on the network.
- Never change or delete a filter Pheeme can't describe as "from X → one category".
- Filter calls run inside `gmail::user_action`; they don't go through the outbox.
- Change `src/onboarding/steps.ts` and `docs/google-cloud-setup.md` together.

## Review Focus

- An account without the new scope (every existing account): one-off moves work, the "future mail" choice is disabled with Reconnect. Test in Task 4.
- A conversation whose latest message is from the account itself: it moves, no rule is made for it; all-self selections disable the rule choice. Test in Task 2.
- A sender who already has a rule for the same category: reused, nothing created, Undo leaves it. Test in Task 2.
- Undo after a partial rule failure (rule save rejected): mail Undo still works and no rule calls are made. Test in Task 4.
- Dragging rows from two accounts: no target accepts the drop. Test in Task 5.

---

### Task 1: Gmail filters API, fake, and the missing-scope error

**Files:**
- Create: `src-tauri/src/gmail/filters.rs` (+ `mod filters;` in `gmail/mod.rs`)
- Modify: `src-tauri/src/gmail/types.rs`, `src-tauri/src/gmail/error.rs`, `src-tauri/src/sync/api.rs`, `src-tauri/src/sync/fake.rs`

**Interfaces:**
- Produces: `types::Filter { id: Option<String>, criteria: FilterCriteria, action: FilterAction }`, `FilterCriteria { from: Option<String>, #[serde(flatten)] other: serde_json::Map }`, `FilterAction { add_label_ids: Vec<String>, remove_label_ids: Vec<String>, forward: Option<String>, #[serde(flatten)] other }` (camelCase, defaults, `other` keeps anything else so a filter Pheeme didn't make is recognisable).
- `MailApi::list_filters() -> Result<Vec<Filter>>`, `create_filter(&Filter) -> Result<Filter>` (non-idempotent), `delete_filter(id) -> Result<()>`.
- `GmailError::is_missing_scope()`: 403 with reason `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, or a message containing "insufficient authentication scopes"; `code()` returns `"missing_scope"` for it.
- Fake: `filters: BTreeMap<String, Filter>`; create rejects an identical criteria+action with 400 `failedPrecondition` "Filter already exists"; `delete_filter` of an unknown id is 404; `pub fn filters(&self) -> Vec<Filter>` and `pub fn seed_filter(Filter) -> String` for tests.

- [ ] Wiremock tests in `filters.rs`: list parses `{"filter":[…]}` (and an empty `{}`), create POSTs `/settings/filters` with `{"criteria":{"from":"a@x.com"},"action":{"addLabelIds":["CATEGORY_UPDATES"]}}` and is not retried after a 503, delete sends DELETE `/settings/filters/f1`.
- [ ] Error test: `api(403, Some("insufficientPermissions"), …).code() == "missing_scope"`.
- [ ] Implement; `cargo test --lib gmail::` passes.
- [ ] Commit.

### Task 2: SenderRuleService, commands, scope

**Files:**
- Create: `src-tauri/src/sender_rules.rs`, `src-tauri/src/commands/sender_rules.rs`; a query in `src-tauri/src/db/threads.rs` (+ `.sqlx` via `cargo sqlx prepare`)
- Modify: `src-tauri/src/lib.rs` (AppState `sender_rules`, register commands), `src-tauri/src/gmail/auth.rs` (`SCOPES`), `src/onboarding/steps.ts`, `docs/google-cloud-setup.md`

**Interfaces (camelCase DTOs):**
- `SenderRuleDto { id, sender, category }`; `SavedRulesDto { created: Vec<String> /* filter ids */, replaced: Vec<SenderRuleDto> }`; `InboxThreadDto { threadId, categories: Vec<String> /* its CATEGORY_* labels */ }`.
- `list_rules(account) -> Vec<SenderRuleDto>`: only filters whose criteria is exactly `from` and whose action is exactly one `CATEGORY_*` add.
- `rule_senders(account, thread_ids) -> Vec<String>`: per thread, the From of its latest message (by date) whose address isn't the account's own; lowercased, unique, in thread order. Local only.
- `save_rules(account, senders, category) -> SavedRulesDto`: list once; identical rule → reuse; else create, then delete that sender's other category rules (recorded in `replaced`). A create answered "already exists" counts as reuse.
- `undo_rules(account, saved)`: delete `created` (404 ok), recreate `replaced`.
- `delete_rule(account, id)`: 404 ok.
- `inbox_threads_from(account, senders, category) -> Vec<InboxThreadDto>`: cached threads in INBOX with any message from one of `senders`, minus those already in `category` (for Primary: none of the other four).
- Tauri commands of the same names, wrapping Gmail-calling ones in `user_action`.

- [ ] Tests against `FakeGmail` + `TestDb`: list skips a filter with `criteria.subject` or a forward; save creates one per sender, reuses an identical one (no create call), replaces a different category (old one gone, listed in `replaced`); undo restores; delete twice is ok; missing scope surfaces `code() == "missing_scope"`; `rule_senders` skips the account's own messages and returns nothing for an all-self thread; `inbox_threads_from` excludes archived threads and ones already in the category.
- [ ] Implement, `cargo sqlx prepare`, `cargo test --lib sender_rules` and `cargo clippy` pass.
- [ ] Commit.

### Task 3: Frontend wrappers and preview fixtures

**Files:** `src/lib/tauri.ts`; `src/preview/senderRules.ts` (spread into `install.ts`); test in `src/preview/preview.test.ts`.

- Wrappers: `listSenderRules`, `ruleSenders`, `saveSenderRules`, `undoSenderRules`, `deleteSenderRule`, `inboxThreadsFrom` with the DTO types above.
- Preview: in-memory rules per account, same reuse/replace rules; `?senderRules=missing` answers `{code:"missing_scope"}` to test the disabled state.
- [ ] Preview test: save then list shows the rule; save again creates nothing; undo removes it. Commit.

### Task 4: Category move, the choice popup, picker section, Settings page

**Files:**
- Create: `src/mail/categoryMove.ts`, `src/mail/CategoryMoveDialog.tsx` (+ store), `src/settings/SenderRulesSettings.tsx`; tests beside each.
- Modify: `src/mail/actions.ts` (export what `categoryMove.ts` needs: `applyChange`-based helper), `src/labels/LabelPicker.tsx` (Categories section in move mode, above labels, hiding the category being shown), `src/settings/pages.tsx` (page "Sender rules", group Mail), the app root (mount the dialog host next to `LabelPickerHost`).

**Interfaces:**
- `moveToCategory(accountId, keys, category, { extra?: InboxThreadDto[]; rules?: Promise<SavedRulesDto | null> }): Promise<void>`: add `[category, "INBOX"]`, remove the other four categories (all five minus target); rows leave the list when a different category tab is shown; patch `systemLabelIds`; toast `Moved to "<name>"` with Undo restoring each conversation's prior categories and inbox state (from its row's `systemLabelIds`, or `extra[].categories`), then `undoSenderRules` when `rules` resolved to a result.
- `openCategoryMove({ accountId, keys, category, at })`: opens the popup; it loads `ruleSenders` and `listSenderRules` (only to detect `missing_scope`). Choices: "Just this" (default) / "This and future mail from <sender>" ("from these N senders"), with checkbox "Also move their other mail in the inbox" (default on). Missing scope or no senders: second choice disabled, with Reconnect (`ReconnectButton`) for missing scope. Enter moves, Escape cancels.
- Settings page: per account, rules list ("<sender> → <Category>", Delete), empty state, missing-scope message with Reconnect.

- [ ] Tests: moveToCategory sends add/remove as above and Undo sends each prior state; popup disables the rule choice on `missing_scope`; choosing future mail calls `saveSenderRules` and moves `inboxThreadsFrom` results; picker in move mode lists categories and hides the current tab; Settings lists and deletes.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` pass. Commit.

### Task 5: Drag and drop onto the sidebar

**Files:** Create `src/mail/dragMail.ts` (+ `DragCard` host); modify `src/mail/ThreadRow.tsx` (pointerdown starts a drag candidate), `src/shell/Sidebar.tsx` (`data-drop-account` / `data-drop-label` on category rows, Trash, and user label rows); CSS in `src/mail/mail.css`.

- Pointer events, not HTML5 DnD (Tauri's drag-drop handler and WebView2 interfere with it). Starts after 5 px of movement with the primary button; dragging a checked row drags all checked rows, else just that row. A card follows the pointer ("3 conversations"); the target under it (`document.elementFromPoint` → `[data-drop-label]`) gets `data-drop-active` when its account matches every dragged row. Escape or a non-target cancels. The click after a drag is swallowed.
- Drop: category → `openCategoryMove` at the pointer; user label → `moveTo`; Trash → `trash`.
- [ ] Unit test the target rules (account mismatch refused, Spam/Sent not targets); Playwright e2e in `e2e/category-move.spec.ts`: drag a row onto Updates, choose Just this, row leaves Primary and shows under Updates; Escape mid-drag does nothing.
- [ ] All checks pass. Commit.
