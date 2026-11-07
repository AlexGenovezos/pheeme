# Phase 9: Labels — design

**Issue:** #17 (epic #21). **Parent design:** `2026-10-31-mail-calendar-client-design.md` (§4 item 8, §6 UI bar, §12 step 9). **Plan:** `Gmail client project plan.md`, Phase 9.

## 1. Intent

Alex doesn't use labels himself, but Pheeme's users will. The brief is **match what Gmail does natively**: someone who organises mail with labels in Gmail on the web should find the same model, the same operations and the same colours in Pheeme, and a change made in either place shows up in the other.

Approved direction: the four mockups shown on 2026-11-06 (sidebar with nested labels and a ⋮ menu, upgraded "Label as…", create/edit/delete dialogs, coloured chips). Alex: "go that way, you got it."

## 2. What exists today

- **Sync.** Every sync (initial, incremental, expiry) re-lists labels (`SyncEngine::sync_labels` → `labels::replace_labels`), so labels created, renamed or deleted in Gmail already reach Pheeme. Labels deleted remotely are removed from `labels`; their ids may linger in `messages.label_ids` until the messages change.
- **Colours may not sync.** Google's docs say `labels.list` returns only `id`, `name`, both visibilities and `type`; `sync_labels` calls `labels.get` only for Inbox and the categories. If that's true in practice, user-label colours are written as empty on every sync. **Verify against a real account first** (log one `labels.list` response). If colours are missing, see builder's call 9.
- **Storage.** `labels` already has `name`, `type`, `message_list_visibility`, `label_list_visibility`, `color_background`, `color_text`. No migration is expected for label metadata.
- **Gmail client.** `gmail/labels.rs` already has `create_label`, `update_label`, `delete_label`. The `MailApi` trait (`sync/api.rs`) and the fake (`sync/fake.rs`) only have `list_labels`/`get_label`.
- **Apply/remove.** "Label as…" (`l`, the ⋮ menu in the view pane, the command palette) toggles user labels on the selected conversations of the *first* selected row's account (others are silently skipped) through `modify_threads` → the outbox, optimistically, with rollback. It's a flat context menu: no search, no create, ticked only when *all* selected rows have the label.
- **Sidebar.** A flat "Gmail" section lists the active account's user labels with a colour dot and unread count.
- **Chips.** The conversation view shows user-label chips with a remove ×. List rows show no chips; `ThreadSummary` carries no label ids.
- **Move to… (`v`)** is a "not yet" placeholder.

## 3. Goals

1. **Create** a label: name, optional "Nest label under" parent. From the sidebar **+**, a label's ⋮ › **Add sublabel…**, and **Create "…"** in Label as… / Move to… (prefilled with the typed text; applies the new label to the selection once created).
2. **Edit** a label: rename and change its parent (re-nesting). Renaming or re-nesting a parent also renames every sublabel's path, as Gmail does.
3. **Delete** a label with a confirmation that names it, says how many conversations lose it (Gmail's `threadsTotal` for that label from `labels.get`, fetched when the dialog opens; omitted if that call fails, never blocks the delete), and says the mail itself is not deleted. Deleting a parent **also deletes its sublabels** (Gmail's behaviour per most sources; Google's help is silent) and the dialog says so with the count ("and its 3 sublabels").
4. **Colour**: Gmail's label palette (the background/text pairs the Gmail API accepts, which are what Gmail on the web offers), plus **Remove colour**. A colour picked in Pheeme looks the same in Gmail.
5. **Visibility**, as Gmail: *In label list* — Show / Show if unread / Hide (`labelShow` / `labelShowIfUnread` / `labelHide`); *In message list* — Show / Hide (`show` / `hide`).
6. **Sidebar**: the section becomes **Labels** with a **+**. Labels nest by `/` in the name (`Clients/Globex` shows as Globex under Clients), parents fold/unfold, hidden labels are left out, show-if-unread labels appear only with unread mail. Hidden labels sit behind a **More** row at the end of the section, as in Gmail, so they can still be opened and un-hidden. Hovering a row shows **⋮** (also reachable by right-click and keyboard) with: Label colour ›, In label list ›, In message list ›, Edit…, Add sublabel…, Delete label.
7. **Label as… (`l`)**: a popover with a search field (filters as you type, matching full paths), tri-state ticks (✓ all selected have it, – some do, empty none), **Create "…"** and **Manage labels**. Ticking applies immediately through the outbox, as today.
8. **Move to… (`v`)**: same list without ticks (plus Inbox, Spam, Trash, as Gmail offers). Choosing a label applies it and takes the conversation out of where it is, as Gmail does: viewing Inbox or a category → remove `INBOX`; a user label → remove that label; Spam or Trash → remove `SPAM`/`TRASH`; anywhere else (All Mail, Starred, Sent, search results, All Inboxes) → remove `INBOX` if present, nothing else. Moving to Inbox adds `INBOX` (and removes the current user label / Spam / Trash per the same rule); Spam and Trash reuse the existing report-spam and trash actions.
9. **Chips** with the label's colours:
   - **List rows**: user labels whose *In message list* is Show, shown before the subject (full path, e.g. `Clients/Globex`). Not shown for the label you're currently viewing, matching Gmail.
   - **Conversation view**: as today, plus an **Inbox** chip whose × archives.
10. **Keyboard and palette**: `l` and `v` open the menus; palette commands "Label as…", "Move to…", "Create label…". Menus and dialogs are fully keyboard-operable.
11. **Two-way sync**: labels created/edited/deleted in Pheeme appear in Gmail and vice versa (the latter already works; keep it working).

## 4. Non-goals

- Drag-and-drop of conversations onto sidebar labels, or of chips onto conversations.
- Gmail's Settings › Labels table (system-label visibility, IMAP visibility). **Manage labels** opens the sidebar (expanding it if collapsed) and focuses the Labels section; there is no separate management screen.
- Showing/hiding system labels and categories (Phase 11 Settings).
- Filters / auto-labelling rules.
- Labels shared across accounts. Labels are per account; the sidebar shows the active account's labels, as today. Label as… / Move to… on a selection spanning accounts doesn't open the list; it shows "Select conversations from one account to label them" (replaces today's silent skip).

## 5. Anti-goals

- A label action that leaves Pheeme and Gmail disagreeing without telling the user (e.g. a sublabel left behind after a parent rename failed half-way, silently).
- A deleted label coming back: a rollback of a queued apply/remove must never re-add a label that has since been deleted.
- Slowing the message list. List pages are benchmarked on a 206k-thread cache (#112); adding chips must not regress them.
- Colours Gmail can't store, or chips that fail the theme contrast checks (#110).

## 6. Constraints and decisions

### Decided in conversation
- Behaviour follows Gmail on the web; the four mockups are the approved shape.

### Builder's calls (made while writing this; Alex can override)
1. **Create/edit/delete/colour/visibility go straight to the Gmail labels API, not the outbox.** They aren't idempotent replays (a create retried after an ambiguous failure makes a duplicate) and there's nothing sensible to undo offline. Offline or failed: the dialog stays open and shows the error; nothing is changed locally. On success the result is written to `labels` immediately (don't wait for the next sync) and the label store refreshes. Apply/remove/move stay on the outbox, as today.
2. **Delete updates the cache in the same write transaction as the label row**: strip the label (and deleted sublabels) from `messages.label_ids`, then `recompute_threads` for the affected threads, so counts and lists update at once. The same cleanup should run in `replace_labels` when sync finds a label gone, so a remote delete also clears chips.
3. **Outbox ops that reference a deleted label**: Gmail rejects them (400 invalid label). Such a rejection must not roll back to a state containing the deleted label; drop the deleted label from the op's add/remove and its rollback data (or treat the op as done if nothing is left).
4. **Parent rename/re-nest** sends one `labels.update` per affected label, parent first. If one fails, stop, re-sync labels, and show a toast naming what wasn't renamed. Nest-under can't target the label itself or its own descendants; a name that already exists is rejected before calling Gmail (Gmail rejects duplicates too).
5. **Fold state** of parent labels is a local UI preference per account, persisted like other UI state.
6. **List-row chips** come from one batched lookup of `thread_labels` for the page's rows (user labels only), not a per-row query; extend `ThreadSummary` with `labelIds` (user labels only). Run the existing list benchmarks before/after.
7. **Gmail palette**: hard-code the API's allowed background/text pairs in one shared module (Rust validates, frontend renders the grid). Gmail on the web arranges them in a grid with a "custom colour" option that still picks from the allowed set; one grid of all allowed backgrounds, each with Gmail's paired text colour, is enough.
8. **Chip contrast**: the background is Gmail's colour as given (it's the label's identity). The text uses Gmail's paired text colour when it reaches 4.5:1 on that background; otherwise whichever of the theme's near-black / near-white does (some of Gmail's own pairs, e.g. white on `#16a766` at ~3.1:1, fail). Add a subtle border where the background is too close to the pane. Colours stored in Gmail are never rewritten for contrast.
9. **Colour sync fallback** (only if the check in §2 shows `labels.list` omits colours): fetch user labels with `labels.get` on initial sync, after any Pheeme label write, and when the set of label ids/names changes; otherwise at most once every 15 minutes, so remote recolours arrive without spending a request per label on every sync.

## 7. Backend shape (guidance, not prescription)

- `MailApi`: add `create_label`, `update_label` (name, colour, visibilities), `delete_label`; implement in the fake with Gmail's semantics (duplicate names rejected, unknown colours rejected).
- A Tauri-free label service (alongside `mail.rs`) with `create_label`, `update_label`, `delete_label`; commands in `commands/labels.rs`; wrappers in `src/lib/tauri.ts`. The issue's `apply_label_to_thread` / `remove_label_from_thread` are already covered by `modify_threads`; don't add duplicates.
- Emit the existing label/count change events after writes so every window and store refreshes.

## 8. Tests

- DB: label upsert/delete; delete strips `label_ids` and recomputes `thread_labels` and counts; `replace_labels` cleanup on remote delete.
- Service with the fake API: create (incl. nested, duplicate rejected), rename cascade to sublabels incl. partial failure, delete cascade, colour/visibility updates, offline errors leave the cache untouched.
- Outbox: apply/remove with rollback (exists), plus the deleted-label rejection case.
- Frontend: sidebar nesting/fold/visibility rules; Label as… search, tri-state, create-and-apply; Move to… removes from the current mailbox; list chips honour *In message list* and skip the current label; dialogs and menus by keyboard.
- Perf: list-page benchmarks don't regress.

## 9. Done when

- Tests pass; labels created/edited/deleted/recoloured in Pheeme appear in Gmail on the web and vice versa (checked on a real account).
- UI review gate (design §6) passed, in the browser preview (`src/preview/` fixtures need label CRUD) and on Alex's Mac.

## 10. Left to the builder

Exact component structure, menu/popover implementation (reuse the existing context-menu and dialog primitives where they fit), copy wording beyond what's specified, sidebar animation, and how the browser-preview fixtures implement label CRUD.
