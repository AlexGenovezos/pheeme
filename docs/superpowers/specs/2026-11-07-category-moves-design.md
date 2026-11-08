# Moving mail between inbox categories, and sender rules

Issue: #151. Status: design, agreed with Alex 2026-11-07; calls marked **My call** are the author's, for Alex to check.

## Why

Gmail sorts the inbox into Primary, Social, Promotions, Updates and Forums, and sometimes sorts wrong: a newsletter
lands in Primary, a receipt in Promotions. Alex wants to fix that from Pheeme the way Gmail's web "Move to tab"
does: move the mail, and, when he chooses, have Gmail file future mail from that sender in the new tab too. He also
wants to drag mail onto a tab in the sidebar rather than only use a menu.

Success: a misfiled conversation is one drag (or `v` and a pick) away from the right tab, and choosing "future mail
too" means that sender never lands in the wrong tab again, in Pheeme or any other Gmail client.

## Goals

1. **Move to a category.** One or more conversations move to Primary, Social, Promotions, Updates or Forums from:
   - the existing Move to… picker (`v`), which gains a Categories section above the labels;
   - drag and drop onto a category in the sidebar (see 3).
2. **Choose at the moment of moving.** Every category move (picker or drop) asks, in a small popup at the point of
   the action, between:
   - **Just this:** move the selected conversations only.
   - **This and future mail from <sender>:** move them, and create a Gmail filter so new mail from that sender gets
     the category. The popup also offers, as a checkbox defaulting to on (Builder may change the default after
     trying it), to move that sender's mail already in the inbox.
   Several senders selected: the popup names them ("future mail from these 3 senders") and creates one filter per
   sender.
3. **Drag and drop.** Drag a conversation row, or all checked rows when the dragged row is checked, onto a sidebar
   entry of the same account:
   - a category: the category move above, popup included;
   - a user label: the same as Move to… that label;
   - Trash: delete (same as the existing action). The sidebar has no per-account Inbox entry (only All Inboxes
     and the category tabs), so archived mail goes back to the inbox by dropping it on a category tab, which adds
     `INBOX` with that category.
   - Entries that can't take the drop (another account's entries, All Inboxes, Spam, Sent, Drafts, Starred) don't
     highlight and refuse it. Gmail can't move mail between accounts. **My call:** Spam isn't a target, because
     Pheeme has no report-spam action yet; adding one is out of scope.
   - **My call:** dragged rows from more than one account (possible in All Inboxes) highlight no target and show
     the same message the Move to… picker gives for a mixed selection.
   - **My call:** like Move to… today, nothing can be dragged out of Spam or Trash.
   - While dragging, a small card follows the pointer ("3 conversations") and the target under it highlights.
4. **Sender rules in Settings.** A Settings page (or a section of Accounts; Builder's call) lists each account's
   category rules: sender, category, and a Delete button. Only filters Pheeme can describe as "from X → category" are
   listed; other filters the user made in Gmail are left alone and not shown.
5. **Permission up front.** `https://www.googleapis.com/auth/gmail.settings.basic` joins `SCOPES` in
   `src-tauri/src/gmail/auth.rs`, so every new sign-in asks for it (Alex's decision). It stays optional:
   `REQUIRED_SCOPE` is still only `gmail.modify`.

## Non-goals

- Moving mail between accounts.
- Editing a rule in place (delete and re-create instead), or managing filters that aren't sender → category.
- Syncing filters in the background. They're fetched when the Settings page opens or a rule is about to be created.
- Dragging mail anywhere other than the sidebar (no dropping onto other rows, the reading pane, or outside the app).

## Anti-goals (would make this a failure even if it works)

- A one-off move that waits on the network or fails without the new permission. One-off moves need nothing new.
- Deleting or changing a filter Pheeme didn't create, or creating a duplicate of a rule that already exists.
- Drag and drop that fights selection, text selection in the reading pane, or the list's keyboard focus.

## How it works (decided)

### The move itself

- A category is a system label: Primary is `CATEGORY_PERSONAL`, Social `CATEGORY_SOCIAL`, Promotions
  `CATEGORY_PROMOTIONS`, Updates `CATEGORY_UPDATES`, Forums `CATEGORY_FORUMS` (`CATEGORIES` in the frontend).
- Moving to category C adds C and removes the other four `CATEGORY_*` labels. It goes through `sync::outbox` like
  every other label change (optimistic, rolled back on failure, Undo in the toast restores each conversation's
  previous category). Reuse `moveTo`'s shape in `src/mail/actions.ts` (it already computes the inverse per
  conversation) rather than a new path.
- **My call:** a category move also adds `INBOX`, so dropping an archived conversation on Updates makes it appear in
  the Updates tab, which is what dropping on a tab looks like it does. Moving from inside the inbox is unaffected.
- The conversation leaves the current tab at once and appears in the target tab; category counts update with it.

### Sender rules (Gmail filters)

- New `MailApi` methods (`src-tauri/src/sync/api.rs`), implemented on the real client and the in-memory fake
  (`sync/fake.rs`): `list_filters`, `create_filter`, `delete_filter` (Gmail `users.settings.filters`).
- A rule is a filter with `criteria.from = <address>` (the sender's bare address) and `action.addLabelIds = [C]`;
  for a non-Primary category Pheeme also removes nothing else. **Builder must confirm against a real account** that
  Gmail accepts `CATEGORY_*` in a filter's `addLabelIds` (the web UI's "Categorize as" suggests it does) and how a
  "Primary" rule must be expressed.
- **Which sender (my call):** a conversation's sender is the From address of its latest message not sent by the
  account itself. A conversation with no such message (only your own mail) still moves but adds no rule; the popup
  says how many senders it will make rules for. Addresses are compared lowercased.
- Before creating, list the account's filters. An identical rule already exists: reuse it silently. A rule for the
  same sender with a different category exists: replace it, since the user just said where that sender belongs.
  **My call:** create the new filter first, then delete the old one, so a failure never leaves the sender with no
  rule.
- "Move existing mail too" runs a Gmail search for `from:<address> in:inbox`, following every result page, and
  applies the same category move to the results through the outbox in batches. **My call:** one Undo covers the
  whole move; if a search page fails part way, what moved stays moved and the toast says the rest couldn't be.
- Filter calls are user actions: wrap them in `gmail::user_action`, like the label commands. They go straight to
  Gmail, not the outbox (like labels in `labels.rs`); put them in a small Tauri-free service, with commands in
  `commands/` and wrappers in `src/lib/tauri.ts`.
- If creating the rule fails, the move still stands; the toast says the rule couldn't be saved and why.
- **Undo (my call):** Undo in the toast reverts everything the action did: the mail moves back, a rule it created
  is deleted, and a rule it replaced is restored. Undo is "I didn't mean that", so it shouldn't leave a rule behind.
  A rule that already existed and was reused is left alone.

### Permission

- New sign-ins request `gmail.settings.basic`. Google lets users untick it; that is allowed.
- Pheeme needs to know per account whether the scope is granted. Google returns the granted scopes on every token
  response, including refreshes, so record it when tokens are obtained (in memory with the access token, or
  persisted; Builder's call) rather than guessing.
- **Existing accounts** don't have the scope until they reconnect. When an account lacks it:
  - one-off moves work as usual;
  - the popup's "future mail too" option is shown disabled with "Reconnect <account> to let Pheeme save sender
    rules", and a Reconnect button that uses the existing reconnect flow (`ClientChoice::Reconnect`,
    `src/onboarding/Reconnect.tsx`);
  - the Settings rules section shows the same message instead of a list.
  - A 403 `insufficientPermissions` from a filter call is treated the same way.
- **BYOC:** users must add `gmail.settings.basic` to their own Google Cloud consent screen. Update
  `src/onboarding/steps.ts` and `docs/google-cloud-setup.md` together, and say it in the release notes so existing
  users know to add the scope and reconnect.

### Preview and tests

- Browser preview (`src/preview/`) answers the filter commands from fixtures and mutates them like the app.
- Tests: the outbox change and its undo (Rust and `actions.ts`), filter create/dedupe/replace/delete against the
  fake, the popup's choices, the missing-permission state, the Settings list, and drag and drop onto valid and
  invalid targets.

## Left to the builder

- The popup's exact layout and wording, and the drag card's look (match existing popovers and the label picker).
- Whether drag and drop uses native HTML5 drag events or pointer events; it must work in WKWebView, WebKitGTK and
  WebView2.
- Where the rules list lives in Settings (its own page or under Accounts), declared through `src/settings/pages.tsx`.
- Whether a bindable command exists for "Move to category" beyond the picker; the picker section is enough.
- Splitting the work into stacked PRs (suggested: category move + picker; drag and drop; filters + permission +
  Settings).
