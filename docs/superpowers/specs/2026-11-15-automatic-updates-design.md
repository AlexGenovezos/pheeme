# Automatic updates

## Why

Pheeme only offers an update; nothing installs until the user clicks **Restart to update**. On
2026-11-15 the 4 active installs were on 0.19, 0.21, 0.24 and 0.25, none on the current 0.26.
Closing the window hides Pheeme to the menu bar or tray, so the banner usually sits in a window
nobody looks at and the app is rarely quit. Every release that changes the mail cache leaves
older builds unable to open it, and the release notes already tell users to "keep auto-update
on", a setting that doesn't exist.

Success: an install that is running and online is on the latest release within about an hour
of publishing, and the user never notices the restart.

## Goals

- Check every 30 minutes (today 6 h), plus the existing catch-ups on focus, wake and network
  return.
- Download an update in the background as soon as it's found.
- Install it and restart when Pheeme is idle: the window hidden for 10 minutes, or shown but
  unfocused for 1 hour, and nothing in progress (below).
- Come back as it was: a restart from hidden starts hidden.
- Quitting Pheeme with an update downloaded installs it on the way out.
- The "Pheeme X is ready / Restart to update" banner stays, for restarting right away.

## Non-goals

- OS-wide idle detection (keyboard and mouse anywhere): considered as approach B, not built.
- Staged rollouts, update channels, forced minimum versions.
- Linux `.deb` installs, which the updater can't replace; AppImage is covered.

## Anti-goals

- A restart the user sees or loses work to: a window popping up, an installer window flashing,
  a half-written message or event gone.
- Restarting in a loop when an install fails.

## Approaches

- **A. When Pheeme is unused (chosen).** Pheeme knows whether its own window is hidden or
  unfocused and whether anything is being written; a restart while hidden is invisible.
- B. When the user is away from the computer (OS idle time). More precise, but per-OS native
  code and unreliable on Wayland.
- C. At a quiet hour (e.g. 3 a.m.). Predictable, but laptops are usually asleep then.

Alex picked A.

## Decided

- **Nothing in progress** means: no compose panel open, no calendar event editor or other
  dialog with typed changes open, no update already applying. Compose panels still go to Gmail
  Drafts first, as `apply()` does today; anything else that is open blocks the restart until it
  closes.
- **Starting hidden:** before an automatic restart Pheeme records that it should start hidden
  (in `app_settings`, so it holds whichever process relaunches it: `relaunch()` on macOS and
  Linux, the installer on Windows). The next launch reads and clears it, and neither the
  frontend nor `reveal_window_fallback` shows the window. The record expires (e.g. after
  5 minutes) so a crash mid-update never leaves Pheeme launching invisibly.
- **Windows:** `installMode` becomes `quiet` so no installer progress window appears (per-user
  NSIS install, no elevation prompt; confirm).
- **A failed install** is logged as today (`install_failed`), the banner stays, and automatic
  restarts wait until the next newer release or the next launch.
- A newer release found after downloading replaces the downloaded one, as checks already do.

## Builder's calls

- Where the idle clock lives (frontend `visibilitychange`/`blur` timestamps vs Rust window
  events), and how "a dialog with typed changes" is detected.
- Whether to add a Settings › About switch "Install updates automatically" (on by default) so
  the release-note line is true; recommended, small.
- Splitting `downloadAndInstall()` into `download()` then `install()` with the plugin's API,
  and how install-on-quit hooks the existing exit request that saves drafts.
- Tests: extend `src/lib/updater.test.ts` with fake timers for the idle rules.
