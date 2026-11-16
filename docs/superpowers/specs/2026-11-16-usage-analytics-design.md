# Usage analytics: screens and shortcuts (design)

## Why

Alex wants to know which screens people use, which keyboard shortcuts they press, and how
they reach each command (shortcut, palette or button), so improvements go where people
actually spend their time. Today the app sends only a daily anonymous ping that counts
installs (`telemetry.rs`).

## Decided

- **Approach A** (picked over a hosted product like PostHog and an event stream to
  Cloudflare Analytics Engine): the app counts usage locally per day and sends yesterday's
  totals once a day. Nothing records the order things happened in, so no session can be
  reconstructed.
- Anonymous, under the existing "Share anonymous usage stats" switch (on by default).
  Turning it off stops recording and deletes the counts that haven't been sent yet. Debug
  builds don't record unless `PHEEME_TELEMETRY_URL` is set (the same rule as the ping).
- The privacy policy, the switch's description and the welcome screen text say what is
  sent.

## What is counted, per local day

- **Screens**: how many times each was opened and the time it was on screen. Time counts
  only while the window is focused and visible and the user did something in the last 2
  minutes. Names are fixed strings the app defines and never carry user content:
  `mail.inbox`, `mail.starred`, `mail.sent`, `mail.drafts`, `mail.all`, `mail.spam`,
  `mail.trash`, `mail.label` (any user label, never its name), `mail.search`,
  `mail.conversation`, `calendar.day|week|month`, `calendar.event`, `calendar.editor`,
  `calendar.pinned`, `settings.<page>` (a mod's page is `settings.mod`), `stats`, `palette`,
  `compose`, `preview`, `person`, `speedread`, `tasks`, `theme-editor`. Screens are worked
  out from the stores (`src/usage/screens.ts`), so components don't change.
- **Commands**: each command id from the registry and how it ran: `key` (a shortcut,
  counted in `registry.handleKeyDown`), `palette`, or `button` (a click on an element with
  `data-command`, added to the buttons that already show a shortcut through
  `useKeybinding`). Mod commands count as `mod`, never their own ids.
- **Rebound shortcuts**: the user's overrides (`command id → key`, or removed).
- With each day: version, OS, chip and the number of connected accounts.

## How it flows

1. Frontend (`src/usage/`) keeps counts in memory and flushes them every 5 minutes and when
   the window is hidden, through `record_usage`.
2. Rust adds them to the `usage_counts` table (day, kind, name, count, ms) when telemetry is
   on, and keeps the latest rebound shortcuts in `app_settings`.
3. `telemetry::tick` (hourly) sends each finished day to `POST /v1/usage` after the ping and
   deletes it once accepted. Days older than 14 days that never went out are dropped.
4. The diagnostics Worker validates the body (fixed name pattern, size and count caps),
   accepts only install IDs it already knows from `/v1/ping`, and stores
   `usage/<day>/<installId>.json`. The bucket's existing 30-day rule deletes it.
5. `node scripts/usage.mjs` reads `usage/` and prints which screens and commands are used,
   by how many installs, how, and which shortcuts people rebind.

## Constraints

- The ping's endpoint and format don't change, so install counts keep working whether or
  not the Worker has been deployed. Until `/v1/usage` exists, the app keeps the days and
  retries on later ticks; anything older than 14 days is dropped.
- No timer runs while the app is idle beyond the 5-minute flush; time on screen is settled
  on transitions and input, not by polling.

## Left to the builder

The exact report layout and the Worker's caps.
