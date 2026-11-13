# Sidebar footer and the Stats window

## Why

The sidebar's bottom-left should work like T3 Code's: a row of quiet icon buttons instead of the active account's avatar and email. Mail stats deserves its own window, not a page buried in Settings, again modelled on T3's Usage window.

## Goals

- One shared footer in both the Mail and Calendar sidebars:
  `[Mail|Calendar switch] [Settings] [Stats] [Add account] ……… [Check for updates]`.
- The Mail | Calendar switch moves from the top toolbar into the footer; the top toolbar keeps only Hide sidebar.
- The active account's avatar and email leave the footer.
- Stats opens as a large modal (nearly the full window), not a Settings page.

## Non-goals

- No new statistics. The window shows what Mail stats shows today.
- No change to how updates are checked or installed, only a new place to trigger them.

## Anti-goals

- The footer must not wrap or overflow at the narrowest sidebar (200px).
- No layout shift while stats load (the existing skeletons stay).

## Approaches

- **A. A dedicated Stats window (picked).** A new modal shaped like T3's Usage: a breadcrumb header, view tabs, refresh and close. It reuses today's Mail stats parts.
- **B. Settings opened straight on Mail stats.** Cheap, but it still looks and feels like Settings, which is what Alex wants to get away from.

## Design

### Footer (`src/shell/SidebarFooter.tsx`)

One component that both `Sidebar.tsx` and `CalendarSidebar.tsx` render in place of their current `.sidebar__footer`.

- **Left:** `ModeSwitch` (unchanged, moved), then IconButtons for Settings (`settings.open` keybinding), Stats (a new `stats.open` command) and Add account. Add account shows only where `onAddAccount` is passed, as today; the Calendar sidebar gets it too.
- **Right:** a Check for updates IconButton. It is idle until clicked, then runs `checkForUpdatesNow()`, with the existing `UpdateBanner` toast showing the result. While a check runs the icon spins. When `useUpdateStore.available` is set, the button takes the accent colour, its label becomes "Restart to update to vX.Y", and clicking it calls `apply()`. In browser preview (not desktop) it explains that updates are checked by the desktop app, as About does.
- The `ModeSwitch` doc comment and arrow-key focus hand-off still work, since both sidebars render the switch in the same place.

### Stats window (`src/stats/`)

- `StatsDialog.tsx`, opened by `useStatsStore` (`open`, `tab`), the same pattern as `settingsStore`.
- **Header:** `Stats / <Account ▾> / <Range ▾>` breadcrumb. The account picker shows only with more than one account. Range is 7/30/90/365 days, as today. On the right: segmented tabs **Overview | Where it lands | Senders**, a refresh button (re-asks `getMailStats`), and close. Esc closes.
- **Body,** centred and at most about 1000px wide:
  - Overview: the note line, tiles and daily chart.
  - Where it lands: inbox tabs and labels.
  - Senders: top senders with unsubscribe.
- The pieces (`Tiles`, `DailyChart`, `Places`, `Senders`, the fetch logic and helpers) move out of `src/settings/MailStats.tsx` into `src/stats/`. Their tests move with them.
- The Mail stats page leaves Settings. Its search keywords stay on a small Settings row ("Mail stats: Open") so searching for "stats" in Settings still finds it.
- A palette command, `stats.open` ("Mail stats", group View), with no default key. The footer button and the palette both open the window.

### Video

`site/video/scenes.mjs` records the live demo app. It reaches Calendar with ⌘2, so moving the switch doesn't break any step. The next `npm run video:site` films the new footer.

## Left to the builder

- Exact icons. Proposed: `BarChart3` for Stats, `UserPlus` for Add account, `CircleArrowUp` for updates.
- Dialog sizing and CSS details, following T3's proportions and the existing design tokens.
- Test updates for the moved footer and the moved switch (Sidebar, CalendarSidebar, palette, sidebarFit).

## Revision (after the first build)

Alex found the one-row footer cluttered and missed the detail of the Settings page, so:

- The footer is two rows: the Mail | Calendar switch across the top, labelled and full width; below it Settings (far left), Stats and Add account, with Check for updates at the far right.
- The Stats window has no view tabs. Like the old Settings page, it shows everything on one scrolling page: the note, tiles, the daily chart, where mail lands, and top senders. The time range is a visible segmented control (7 days, 30 days, 90 days, 1 year) in the header; the account picker stays in the `Stats / …` breadcrumb.
