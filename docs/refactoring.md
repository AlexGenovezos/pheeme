# Refactoring register

Last audited: 2026-11-04, against `0cf0d27` and the reconciled local work.
This register tracks open maintenance work and completed refactors.

The current service boundaries are useful: mail actions share one frontend entry
point, commands delegate to Rust services, and sync shares message conversion and
thread recomputation. Small extractions around repeated behavior are the useful maintenance work here.
A broad rewrite is not warranted by this audit.

## Completed in this checkout (2026-11-03)

- [x] **R1: Share HTML entity decoding in Rust.**

  [text.rs](../src-tauri/src/text.rs) now owns the decoder used by Gmail snippet
  parsing and compose text conversion. The two private copies were removed.
  Named/numeric references, malformed input, invalid code points, Unicode, and
  single-pass decoding are covered; caller tests still exercise snippets and
  outgoing text. Layout and escaping remain with their respective callers.

- [x] **R2: Share asynchronous subscription ownership and cleanup.**

  [subscriptions.ts](../src/lib/subscriptions.ts) owns registration and disposal
  for app/session events, compose events, file drops, update-menu events, and the
  account/mail/label/thread stores. It reuses `stopQuietly`, releases listeners
  that arrive after disposal, and cleans up partial group registration failures.
  An abort signal carries the owner's lifetime into pending store groups, so an
  already active listener is released on unmount even while another is pending.
  Independent subscriptions and screen/session lifetimes stay distinct.

  Regression tests cover these paths, repeated disposal, synchronous setup errors,
  throwing/rejecting cleanup, and each grouped store's failure and cancellation
  paths. The mail store retains the newer local/Gmail search event handling.

## Onboarding follow-up

- [x] **R3: Extract onboarding's sign-in lifecycle from its view coordinator.**

  [useSignIn.ts](../src/onboarding/useSignIn.ts) now owns OAuth, credential-transfer
  attempts, cancellation, and stale-response protection through explicit phases and
  start/cancel operations. [Onboarding.tsx](../src/onboarding/Onboarding.tsx) keeps
  guide navigation, credential inputs, progress persistence, and screen selection.
  Existing retry/back destinations, late-flow cleanup, and secret/invitation
  handling are preserved.

  [PR #89](https://github.com/AlexGenovezos/pheeme/pull/89) merged as
  `9609f9e96c0e6dd7e4ab663e0b19f46b54cdbd3e`. All seven required checks
  passed; Sol approved in one round with no findings. The clean branch passed 534 tests,
  type checking, lint, formatting, the production build, and four Chromium smoke
  flows using the production browser preview. The existing onboarding/transfer
  integration tests and three superseded-attempt tests pass in this workspace too.

## Small cleanup when touched

- [ ] **R4: Use one foreground request path in the thread-detail cache.**

  Evidence: `load` in [threadStore.ts](../src/store/threadStore.ts) repeats the
  in-flight lookup, starting a fetch, promoting a quiet request, and returning its
  promise for incomplete cached details and missing details. Return early for a
  complete cached detail, then let both remaining cases share that existing block.
  No new abstraction is needed. Completion preserves LRU touching, showing partial
  bodies during a refresh, foreground error reporting, and request deduplication.

## Deliberate repetition to preserve

- [db/threads.rs](../src-tauri/src/db/threads.rs) has distinct first/cursor-page and
  single/multiple-account SQL queries to preserve index seeks and avoid sorting.
  Do not replace them with one optional-filter query just to reduce repeated SQL.
  Any future consolidation must preserve SQLx compile-time checking, query-plan
  assertions, and pagination/count parity tests.
- Rust DTOs and TypeScript IPC interfaces describe opposite sides of a process
  boundary. Watch for drift as new domains land; consider generation if maintaining
  the contracts becomes a recurring problem. Thin command adapters and the
  `MailApi` trait implementations are useful boundaries, not duplicate services.
- Browser-preview handlers and Rust's fake Gmail intentionally provide independent
  backends. Keep their observable contracts aligned; do not share production
  mutation internals with a fake just to remove repetition.
- Incoming-email sanitization and outgoing-quote sanitization have different URL
  and content policies. A common sanitizer would need to preserve those differences.
- Several large Rust files contain substantial inline test modules. File length
  alone is not a reason to split their production services.

## Keeping this current

Before adding a helper, search the relevant domain and shared modules for existing
behavior, including differently named implementations. Extract when callers share
the same rules and should change together; keep domain differences explicit.

Revisit this register when adding a workflow or domain and when a fix has to be
copied to multiple places. Add a concrete pair of call sites, the maintenance risk,
and completion criteria for new items. Close an item with its implementing PR;
keep unrelated cleanup in separate PRs, as the contribution guide requires.

## Reconciliation with main

The original checkout was based on `86ccf86`. Comparing its local changes with
`0cf0d27` confirmed that credential transfer, desktop diagnostics, Apple Silicon
release builds, branding, onboarding extraction, unread filtering, prompt send
dispatch, fixed-width email fitting, and compose access with a collapsed sidebar
had already landed. Main's newer search, mod support, image-loading behavior,
and persistent Gmail rejection messages were retained. The brand archives had
identical extracted contents; only archive metadata differed.

The shared text decoder and subscription ownership changes above were still
missing. The email-layout fix belongs to a separate active thread and is excluded
from this reconciliation. Original local implementations were preserved in a
backup branch before reconciliation.
