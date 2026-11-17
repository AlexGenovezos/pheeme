# Account colours, order and Ctrl+Tab

## Why

With several accounts connected, Alex wants to tell them apart at a glance: pick each account's colour, put the
accounts in the order he likes, and flip between their inboxes from the keyboard.

## Goals

- **Pick an account's colour.** Clicking the coloured dot before an account's address in the sidebar opens a small
  popover with 12 swatches (6 × 2), the current one ticked. Choosing one recolours everything that shows the account's
  colour: the sidebar dot, the account rail, the All Inboxes stripe on each conversation, the account indicator.
- **12 colours:** today's six (blue, green, orange, purple, red, yellow) plus teal, pink, indigo, lime, brown, grey.
  Each new one gets a light and a dark shade in the built-in themes, passing the same contrast check on the sidebar as
  the six (`contrast.ts`). Imported VS Code themes have only six chart colours: teal, pink and lime come from the
  theme's terminal cyan, magenta and bright green; indigo, brown and grey use the built-in shade for the theme's kind.
  Either way `makeReadable` adjusts them to stay readable.
- **Reorder accounts** by dragging an account's header up or down in the sidebar; the rail follows. *Move up* / *Move
  down* in the header's right-click (and Menu key) menu do the same from the keyboard.
- **Ctrl+Tab / Ctrl+Shift+Tab** step forward / back through the account rail's entries (All Inboxes, then each account
  in order, wrapping), landing where a rail click would (`mailboxInAccount`: the same tab or favorite when the account
  has it, else its first tab). Literal Control on every platform, as in browser tabs. Rebindable like any command;
  shown in Settings › Keyboard and the palette.

## Non-goals

- A free colour wheel or Gmail's 64-colour grid (readability across light and dark).
- Colouring the Inbox tab icons (Primary, Social, …).
- Syncing colour or order between devices (Gmail has no such thing; this is local, like hidden calendars).

## Approach (chosen)

Stored in SQLite on each account, not in browser storage, so every list (sidebar, rail, Settings › Accounts, calendar)
uses the same order and a colour never changes because its account moved.

- Migration adds `accounts.position INTEGER` and `accounts.color INTEGER` (1–12). Backfill: position by `created_at`,
  colour `((rank − 1) % 6) + 1`, so existing accounts keep today's colours.
- `list_accounts` orders by `position, created_at`. A new account takes the next position and the first of the 12
  colours no account uses (cycling when all are taken).
- Commands `set_account_color(accountId, color)` and `reorder_accounts(accountIds)`; `AccountInfo` carries `color`.
  The frontend updates `accountStore` at once and snaps back with a toast if the command fails.
- `accountColorIndex` reads the account's stored colour instead of its position; `--color-account-1…12` tokens.

Rejected: browser storage (sidebar order would disagree with Settings and Rust-side lists, and dragging would recolour
accounts with no chosen colour); a 10–12 set without stored defaults (same reshuffle).

## Known side effect

Calendar mode takes its time zone from the first account with calendar access, so moving another such account to the
top can change the calendar's zone. Left as is.

## Left to the builder

Drag handling (pointer events like the Tasks panel's reorder, or the sidebar's existing drop targets), the popover's
placement (reuse `usePopover`, `popover-surface`, and `ColorGrid`'s keyboard pattern), swatch names for screen readers,
browser-preview fakes for the two commands, and usage counting (`data-command` on the picker and menu items).
