# Mailbox download and sync notices in the corner

## Why

On first launch, or after adding an account, Pheeme downloads the whole mailbox in the
background (`backfill_step`, 500 messages a page). Nothing said so: progress was only in
Settings › Accounts. A first-time Windows user then saw a sidebar note cut off at
"Gmail is slowing sync. Another d…", which also wrongly blamed another device: the
download's own bursts trip Gmail's per-second limit, which the per-minute usage check
can't see.

## What

- A card in the bottom-right corner while any account is downloading: "Downloading your
  mailbox", a percentage and bar (combined across accounts; never 100% before the last
  page), "12,340 of 29,100 messages · account" (or "N accounts"), and a note that the app
  can be used meanwhile, or that Gmail is slowing the download. Details opens Settings ›
  Accounts. ✕ hides it until the next launch or until another account starts downloading.
  When it finishes it reads "Mailbox downloaded" for 5 s, in the same lines and height.
- Every sync note leaves the sidebar for the same corner: offline, Gmail slowing sync, each
  account's failed sync, and a sign-out with Sign in again. They no longer push the
  sidebar's content down. The account header keeps its warning triangle.
- One shared component, `CornerCard`, draws every card in the corner, toasts included.

## Decisions

- Polling (`get_sync_progress`, 2 s) runs only while a download does; otherwise progress is
  asked again on `sync:started`, which is how a new account or a resync begins.
- While a slowed account is downloading, nothing blames another device.
- Offline and a sign-out can't be closed (they end by themselves or need the action); a
  failure or slowdown can, until a different one arrives.

## Approaches considered

1. **Corner card fed by the existing progress query (chosen).** No Rust change; reuses
   `get_sync_progress`, which Settings already polls.
2. A new Rust progress event per backfill page. Pushes instead of polls, but adds an event
   and a query per page for what a 2 s poll already covers.
3. A progress line in the sidebar. Moves the sidebar when it appears, and the sidebar is
   where the truncated note was the problem.
