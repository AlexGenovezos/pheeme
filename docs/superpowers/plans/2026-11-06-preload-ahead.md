# Preload Ahead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make warm inbox navigation display complete bodies and images immediately, while cold arrivals start warming without delaying opening mail.

**Architecture:** Extend the existing thread detail prefetch into a bounded, replaceable queue. A small mail module subscribes to the existing stores to prioritize the displayed list over main-category warmups. Reuse existing Gmail bulk priority and reading settings; choose image warming from a measured WebKit experiment.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Playwright, Tauri 2, Rust, existing Gmail limiter.

**Spec:** `docs/superpowers/specs/2026-11-06-preload-ahead-design.md`

## Global Constraints

- Work ONLY in `/home/alexg/code/pheeme.perf-preload-ahead`, branch `perf/preload-ahead`; preserve the worktree and commit locally, without pushing or opening a PR.
- End every commit with `Co-Authored-By: GPT 6.1 Sol <noreply@openai.com>`.
- Preloading is read-only: never mark read or change mail state; errors are silent.
- The open thread, the list query and the arrow key always come first. Preload work yields to them, and never queues ahead of the user's own `get_thread`.
- Body fetches for preloading count as bulk work under the existing limiter (`BULK_SHARE`). A rate limit stops preloading; it doesn't surface an error.
- Preserve sync eviction, superseded-request protection, `withPending`, `waitForDetail`, and browser preview.
- `FULL_BODY_DAYS` stays. No schema/query changes are planned; run `cargo sqlx prepare` if any query changes.
- `Preload images` is next to `reading.size` in Settings › Appearance › Reading, on by default. Description: "Preloading images lets senders see that an email was opened, along with your IP address and approximate location, even for emails you skip. Turning it off keeps text preloading, and loads images only when you open an email."
- Cold arrivals preload top row first without an artificial wait or preparing state. The instant-navigation guarantee applies once the list is warm.
- Heavy commands use the machine's `heavy` limiter; never bypass it. No Tauri GUI. No installs/checkouts in `/tmp`.

## Review Focus

- A slow speculative request must never make opening that thread wait for bulk quota (Task 1/2).
- A mailbox switch, unread toggle, search or account removal must not finish obsolete queues or restore stale details (Task 2).
- Pending optimistic changes and sync eviction can overlap a preload response (Task 2).
- Image warming must cover the frame's actual resources and obey an immediate opt-out, with bounded memory (Task 3).
- A browser test must observe each frame after arrows, catching an empty pane as well as a spinner (Task 4).

## Chosen starting budgets

Arrival/category prefix: **20** threads. Navigation: **16 ahead, 4 behind**, nearest in travel direction first. Detail cache: **160** entries (six category/Inbox prefixes total at most 120, plus displayed-list and moving-window headroom). Concurrent speculative detail requests: **2**, leaving foreground calls independent. All Inboxes is one combined list; warm categories of the active account. Measure these choices in Task 4 and record results in `docs/performance.md`; adjust only with evidence and document why.

---

### Task 1: Route speculative bodies through existing bulk quota

**Files:** Modify `src-tauri/src/commands/threads.rs`, `src-tauri/src/mail.rs`, `src-tauri/src/sync/engine.rs`, `src-tauri/src/sync/api.rs`, `src-tauri/src/gmail/threads.rs`, `src-tauri/src/sync/fake.rs`, `src/lib/tauri.ts`, `src/preview/install.ts`; test existing Rust test modules and `src/preview/preview.test.ts`.

**Interfaces:** Consume existing `Priority::Background` and bulk limiter. Produce `getThread(accountId: string, threadId: string, opened = false, preload = false): Promise<ThreadDetail>` after integrating upstream diagnostics. Preserve its third `opened` argument; foreground opens pass `true, false`, quiet preloads pass `false, true` through `get_thread` IPC. Extend the existing body-load service/API minimally so preload fetches and externally stored bodies use bulk priority and return rate limits immediately. Preload errors must propagate to the quiet caller so its queue can stop.

- [x] Add Rust tests proving cached preload performs no Gmail request, a missing body uses the bulk path, a bulk rate limit is returned without retry, and no labels/read state change. Add preview coverage for the optional argument.
- [x] Run focused tests to observe the expected RED before implementation (`cargo test --manifest-path src-tauri/Cargo.toml <test filter>`, `heavy npx vitest run src/preview/preview.test.ts`).
- [x] Implement the optional path without changing foreground behavior or duplicating DTO construction. Preserve pending outbox state while storing fetched bodies.
- [x] Run covering tests GREEN and format Rust/modified frontend files. Record command/output in the report.
- [x] Commit the task with the required trailer.

### Task 2: Bounded prefetch and moving list/category windows

**Files:** Modify `src/store/threadStore.ts`, `src/store/threadStore.test.ts`, `src/mail/actions.ts`, `src/mail/actions.test.ts`, `src/App.tsx`; create `src/mail/preload.ts`, `src/mail/preload.test.ts`.

**Interfaces:** Consume Task 1 `getThread(..., opened, preload)`. Preserve `prefetch(keys: ThreadKey[]): void` as the replaceable priority-ordered desired set; an empty list cancels pending speculative work. Produce `startPreloading(): () => void` in `src/mail/preload.ts`, subscribed once in the mail screen with cleanup. Export `prefetchAround(key: ThreadKey, direction?: 1 | -1): void` from that module and call it from the existing actions path. The scheduler may hold category keys after active keys in the same bounded queue. Image integration in Task 3 observes accepted cached details, not raw responses.

- [x] Add failing tests for first 20 displayed rows on load (including search and unread filtered rows), mailbox changes cancelling old work, direction weighting (16 ahead/4 behind, reversed for up), two-request maximum, foreground bypass/promotion of quiet in-flight work, cache bound, rate-limit stop, and zero mail mutations. Preserve/adapt existing eviction/optimistic/waitForDetail tests, adding eviction during a queued/in-flight preload and superseding a slow preload with a foreground request.
- [x] Run `heavy npx vitest run src/store/threadStore.test.ts src/mail/actions.test.ts src/mail/preload.test.ts` and capture RED.
- [x] Implement minimal queue in threadStore and subscriptions in preload. Warm Inbox plus `CATEGORIES` using sequential `listThreads` queries, `limit: 20`, active account and its per-mailbox unread preference. Foreground/list work has priority. Replace stale queues/results by generation on scope change; avoid retries/spinning for failed/incomplete details. Keep the open detail protected from speculative LRU churn.
- [x] Re-run focused tests GREEN; run frontend full suite once before commit (`npm run test -- --run`).
- [x] Commit the task with the required trailer.

### Task 3: Warm images and expose the privacy setting

**Files:** Modify `src/settings/readingSettings.ts`, `src/settings/readingSettings.test.ts`, `src/settings/pages.tsx`, `src/settings/Settings.test.tsx`, `src/mail/preload.ts`, `src/mail/preload.test.ts`, `src/mail/ThreadView.tsx`, `src/mail/ThreadView.test.tsx`, `src/mail/mail.css`, `src/mail/EmailBody.tsx` if needed; create `src/mail/preloadImages.ts` and `src/mail/preloadImages.test.ts` only if image lifecycle needs a focused module. Update `docs/performance.md` with WebKit experiment.

**Interfaces:** Extend `useReadingSettings` with `preloadImages: boolean` and `setPreloadImages(value: boolean): void`, persisted with the existing settings pattern. Image resources follow the accepted detail cache and desired window; release retained warmups on eviction/opt-out/cleanup. Consume the measured method in `.superpowers/image-measurement.md`: retain decoded images for the wider window, plus at most five mounted conversations (current, two ahead and two behind) at the reading-pane width. Keep surviving keyed conversation wrappers in stable insertion order and reveal them in place; moving/recreating frames refetches no-store images. Before selection, pre-render the first two displayed rows. Extract the existing conversation content locally in ThreadView rather than building another rendering system. Invisible conversations must be inert, inaccessible and outside normal layout; their frames must still lay out/load backgrounds. Setting off removes hidden conversations. Only the selected conversation starts a foreground load; pre-rendering reads accepted cached details. Do not broaden CSP or fetch remote URLs through JS connections. Whole-branch review follow-up: both hidden frames and wider warming label signed CID img URLs speculative; serialize uncached inline downloads to one Background/bulk request, including embedded fallback. A rate refusal stops pending/future inline warmups for the service lifetime, with cached hits preserved. Opening bypasses that gate and promotes only unfinished/failed signed images in place, preserving complete iframe documents/images. Hidden body/theme rewrites retain speculative intent.

- [x] Add failing tests for default-on/persisted opt-out, exact setting title/description, opt-out retaining text preloads and never starting image requests, accepted-cache-only warming, resource cleanup/bounds, stable iframe/document identity across selection and direction reversal, no hidden conversation foreground loads or mutations, and resources under the iframe CSP (including inline images and CSS background URLs where applicable).
- [x] Run focused Vitest files and record RED.
- [x] Implement the measured image method using existing sanitization/srcdoc and reading setting patterns. Document WebKit cache/no-store behavior and any real-Mac follow-up honestly. No image preload when disabled; opening keeps today's image behavior.
- [x] Re-run covering tests GREEN; run frontend full suite once before commit and format touched files.
- [x] Commit the task with the required trailer.

### Task 4: Arrow-through evidence and final budgets

**Files:** Create `e2e/preload.spec.ts`; modify `src/preview/install.ts` / `src/preview/fixtures.ts` only as needed for realistic deterministic preview bodies and images, and `docs/performance.md`; modify `e2e/memory.spec.ts` only with measured justification.

**Interfaces:** Consume completed preloading behavior through the preview UI. Tests may instrument preview IPC to measure preload readiness and delayed requests without adding production diagnostics. Preserve existing memory budgets unless measurements justify a change.

- [x] Add an arrow-through test with 20+ unread Updates rows, realistic images with controlled delayed responses, a warm-up readiness condition, and a requestAnimationFrame observer that records blank panes, loading UI, wrong/stale subjects, and incomplete visible images after each arrow. Ensure the assertion fails if preloading is disabled/bypassed, using a local RED demonstration before final implementation/test adjustment.
- [x] Synthetic read state persists through mark-read sync events and list/detail refreshes, including `keepRead`; signed-CID blocked-bulk promotion has browser coverage.
- [x] Run `heavy npx playwright test e2e/preload.spec.ts` RED then GREEN. Include category/unread switches and record per-window warm-up timings and image-request reuse where practical.
- [x] Record chosen budgets, quantitative results and rationale in `docs/performance.md`, along with exact browser limitations and the real-Mac acceptance walkthrough.
- [x] Run `npm run typecheck`, `npm run test -- --run`, `npm run lint`, `npm run format:check`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `heavy npx playwright test` (includes memory and arrow-through); all must pass. Use `heavy` for direct heavy binaries. Fix actual failures within scope and report failures verbatim before subsequent successful reruns.
- [x] Commit the task with the required trailer.
- [x] Controller: dispatch a fresh whole-branch review, fix findings, recheck affected commands, and leave all work committed locally.
