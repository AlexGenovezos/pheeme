# Performance checks

CI checks that Pheeme stays fast as features land (issue #47). Each check catches a
regression in the PR that causes it.

## Rust benchmarks (every PR)

[`src-tauri/benches/hot_paths.rs`](../src-tauri/benches/hot_paths.rs) measures the paths that
grow with the mailbox, against a seeded 50,000-thread SQLite cache and the in-memory Gmail
(`sync::fake`):

| Benchmark | What it runs |
|-----------|--------------|
| `list_threads::first_page` / `deep_page` | One Inbox page at the top, and 90% of the way down |
| `list_unread_threads::first_page` | The first Inbox page with Unread only on |
| `list_unread_tab::few_unread` | A tab's first page with Unread only on, when the tab has fewer unread threads than a page |
| `unread_counts::inbox_and_tabs` / `label_counts::every_label` | The sidebar and tray counts, rerun on every sync event |
| `search_threads::first_letter` / `rare_word` | A local search page for one typed letter (matches every message), and for a word in only the oldest message |
| `recompute_threads::batch` | Rebuilding 200 threads after their labels changed |
| `initial_sync::inbox` | First sync of an account (100 Inbox threads) |
| `incremental_sync::new_mail` | `history.list` sync of 500 new messages and 1,000 label changes |
| `get_thread::long_conversation` | Opening a 200-message thread |

They count CPU instructions under Valgrind ([gungraun](https://github.com/gungraun/gungraun))
instead of timing them: shared CI runners are too noisy for timings, while instruction
counts repeat to well under 1%. The `Performance` workflow benchmarks the PR's base commit,
then the PR, and fails when a benchmark gets more than 10% worse. The comparison is in the
job summary.

Run them locally (Linux only):

```bash
sudo apt-get install valgrind libclang-dev
cargo install gungraun-runner --version 0.20.0   # must match the gungraun crate
cd src-tauri
cargo bench --features bench --bench hot_paths -- --save-baseline=before
# ...make a change...
cargo bench --features bench --bench hot_paths -- --baseline=before
```

A benchmark's state is built with Valgrind's instrumentation switched off, so only the
measured call is counted, on every thread (SQLite runs on sqlx's worker thread). The
Callgrind profiles land in `src-tauri/target/gungraun/`; open them with
`callgrind_annotate` or KCachegrind to see where the instructions went.

## Rust heap soak (every PR, short; nightly, long)

[`src-tauri/tests/soak.rs`](../src-tauri/tests/soak.rs) runs a long session against the
in-memory Gmail with [dhat](https://docs.rs/dhat) counting every allocation. It backfills a
mailbox, then runs sync cycles the way the app does: new mail, deletions and label changes
from other devices, the user's own changes through the outbox, and list and thread reads.
Each cycle leaves the mailbox the same size, so the live heap should level off once caches
are warm. Like the benchmarks it uses a one-connection pool: the app's pool opens more
connections at unpredictable moments, each with its own caches, which reads as a jump in the
heap. The test fails when:

- the live heap keeps growing (a least-squares slope over the last three quarters of the
  cycles above 256 bytes per cycle; a healthy run is around 40), or
- the peak heap passes its budget, set about 20% above the measured peak.

| Size | Where | Mailbox | Cycles | Peak budget |
|------|-------|---------|--------|-------------|
| short | `Performance` workflow, every PR | 5,000 messages | 200 | 4 MiB |
| long | `Nightly performance` workflow | 20,000 messages | 1,000 | 15 MiB |

A nightly heap failure opens an issue (or comments on the open one). On a failure, the job
uploads `dhat-heap.json`: open it in
[dh_view](https://nnethercote.github.io/dh_view/dh_view.html) to see which allocation sites
hold the memory. The first version of this check found sync keeping every deleted message's
id for good once the backfill had finished.

```bash
cd src-tauri
cargo test --profile soak --features test-support --test soak -- --nocapture
SOAK=long cargo test --profile soak --features test-support --test soak -- --nocapture
```

If a change legitimately needs more memory, measure the new peak and raise the budget in
`soak.rs` to about 20% above it.

## Frontend memory (every PR)

[`e2e/memory.spec.ts`](../e2e/memory.spec.ts) drives the preview build (mocked IPC and
fixtures, `?threads=10000` for ten thousand more Inbox conversations) in Chromium with
Playwright. After a warm-up round it runs four rounds of a heavy session: scroll the list
end to end, open the next 50 conversations with `j` (200 different ones in all), switch
mailboxes, cycle the three themes, go to Manage accounts and back, and fire `sync:*` events. It forces garbage
collection through the DevTools protocol, then compares the JS heap, DOM nodes and event
listeners with where they started:

| Measure | Healthy run | Fails above |
|---------|-------------|-------------|
| JS heap growth | about +0.8 MiB (V8's optimized code, Chrome's performance timeline) | 2 MiB |
| DOM nodes | +0 | 100 |
| Event listeners | +0 | 20 |

Keeping a copy of every loaded thread list, for example, adds over 100 MiB and fails it.
Small leaks stay below its noise: the generated conversations are tiny, so even a detail
cache that never evicts adds only about 0.1 MiB over the run. Unit tests cover bounds like
that one (`threadStore.test.ts` checks the cache keeps 160).
Chromium stands in for the real webviews (WebKitGTK, WKWebView, WebView2): it catches JS
leaks (stores, listeners, detached DOM), not engine-specific ones.

```bash
npx playwright install chromium   # once
npm run test:memory
```

It builds the preview with `vite build` and serves it on port 4173 for the run.

## Real app on Linux (PRs that change the app; nightly)

[`app-perf.yml`](../.github/workflows/app-perf.yml) builds the release app and fills a
throwaway home directory with a synced-looking 20,000-conversation mailbox
([`src-tauri/examples/seed_mailbox.rs`](../src-tauri/examples/seed_mailbox.rs)). It then
launches the app under `xvfb` through `tauri-driver` (WebDriver) with
[`scripts/perf/app-run.mjs`](../scripts/perf/app-run.mjs), inside its own D-Bus session so
it never touches a real keychain, and records:

| Measure | First CI runs | Budget |
|---------|---------------|--------|
| Start (WebDriver session request to the first list row), median of 5 launches | single starts 0.9 to 2.1 s | 3 s |
| Memory after a minute idle: app plus its WebKit processes, PSS | 236 to 239 MiB | 330 MiB |
| The same after a scripted 10-minute session (mailboxes, scrolling, conversations) | 300 MiB | 460 MiB |
| The app's own (Rust) process after the session, PSS | 134 to 138 MiB | 165 MiB |
| WebKit's web process: the lowest reading in the last third of the session minus the lowest in passes 20 to 40 | 17 to 26 MiB | 45 MiB |

The budgets sit about 20% above the measurements on an `ubuntu-22.04` runner, which renders
in software under Xvfb. The idle and session budgets were first set at 290 and 360 MiB. Preloading ahead of the
reader (below) keeps 160 conversations cached instead of 30 and 5 rendered instead of 1,
for about 25 MiB more both idle and after the session (269 to 281 and 355 to 365 MiB on
2026-11-08), so they were raised to 330 and 400 MiB. Idle memory is well over the issue's
starting target of 150 MiB, and the session adds about 85 MiB: both are worth a look.

The session total depends on when WebKit collects garbage, not only on the app (#274). The
log prints each process's memory every 10 passes. On 2026-11-10, six runs on three commits
(including two the same) ended at 375 to 434 MiB. In about half the runs, WebKit's web process let the
session's garbage pile up for 40 to 70 passes (to 650 MiB once) before a full collection,
then kept 25 to 60 MiB of that peak, which put the total over 400 MiB at random. The Rust
process stayed at 134 to 138 MiB and Chromium's JS heap levelled off, so this was WebKit's
timing, not a leak. So the session total only has a ceiling (460 MiB), and two figures
that don't depend on that timing catch leaks: the Rust process, and the web process's growth
measured from its lowest readings, which a leak keeps raising and a late collection doesn't.
A pile-up early in the session raises the early floor and can hide growth for that run;
the next night's run usually doesn't pile up.

Less garbage means fewer pile-ups. The same investigation cut what a pass allocates (measured in
the browser preview with Chromium's sampling heap profiler) by about a quarter, mostly by not
re-rendering what didn't change on every `j`: memoized conversations and sidebar rows,
stable row callbacks, unchanged thread rows kept across list reloads, and cached label chip colours.
The nightly build points the updater at an unreachable address, so no update banner
appears in some runs and not others.

The seeded mailbox is a returning user's: the one-time "Turn on notifications?" prompt is
already answered, and usage pings are off. Left up for the whole run, that prompt's toast
alone added 40 to 90 MiB and made the session figure swing by as much.

Memory is PSS (proportional set size), which splits shared pages between the processes
using them, so the total isn't inflated by WebKit's shared libraries the way summed RSS is.
A run fails when it exceeds a budget, or when a memory measure (idle, session, Rust process)
gets more than 20% worse than the previous nightly run. Start time is tracked over runs too, but a 20% swing isn't a
failure: one start varies by a factor of two on shared runners. github-action-benchmark keeps that history in the Actions cache, and
the job summary shows the comparison.

It runs in two places:

- **Every PR that changes the app** (the `Real app` job of the `Performance` workflow, about
  20 to 25 minutes beside CI), so a slowdown fails the PR that causes it rather than the next
  night. A PR changes the app when it touches `src/`, `src-tauri/`, `public/`, the npm or
  Cargo manifests and lockfiles, the Vite or TypeScript config, the toolchain, or this harness;
  tests, benchmarks, docs and the website don't count. A PR fails on the budgets only: its
  summary compares it with the previous night, but doesn't fail on that comparison, because a
  PR's base may be a day of other changes past it.
- **Every night on main** (`Nightly performance`), where it also fails on the 20% comparison and
  adds the run to the history.

Seeding the mailbox takes about 4 minutes, so it is cached: the key changes with the seed, the
database code (`src-tauri/src/db/`) and the month, and only main saves it. A PR that changes
the database code seeds its own.

A nightly run opens an issue (or comments on the open one) only when it measured something:
a budget or the comparison missed, or the heap soak failed. A failure before that (installing
packages, building, seeding, launching) fails the run without an issue: rerun it.

Run it on a Linux machine without a virtual GPU. On a VM with a QXL display, WebKit's DRM
probe hangs in the kernel.

```bash
sudo apt-get install webkit2gtk-driver xvfb
cargo install tauri-driver --locked
npx tauri build --no-bundle
home=$(mktemp -d)
(cd src-tauri && cargo run --release --example seed_mailbox -- "$home/.local/share/app.pheeme.desktop")
xvfb-run -a dbus-run-session -- node scripts/perf/app-run.mjs \
  --app src-tauri/target/release/pheeme --home "$home" --session-minutes 2
```

## Release profile

Shipping builds use thin LTO, one codegen unit and stripped symbols (`[profile.release]` in
`src-tauri/Cargo.toml`). Measured on 2026-11-08 on the 4-core Linux devbox, clean
`cargo build --release --features tauri/custom-protocol`, with the harness above for start
time and memory:

| Profile | Binary | Clean build | Start to first list paint | Idle PSS |
| --- | --- | --- | --- | --- |
| cargo defaults | 47.9 MB (34.3 MB stripped) | 403 s | 533-570 ms | 326 MiB |
| thin LTO, 1 codegen unit, stripped | 28.1 MB | 381 s | 516-622 ms | 323 MiB |
| fat LTO, 1 codegen unit, stripped | 26.9 MB | 436 s | not measured | not measured |

Start time and memory don't change; the binary is 41% smaller. Fat LTO saves 1.2 MB more for
a 15% longer build, so thin is the default. Stripping drops symbol names, so a crash backtrace
from a release build shows addresses only.

The benchmarks and the heap soak keep cargo's release defaults (`[profile.bench]`, and
`[profile.soak]` for `cargo test --profile soak`): they build on every PR, the benchmarks
compare a PR with its base, and dhat's heap profile needs symbol names.

## Preloading ahead of the reader

`src/mail/preload.ts` keeps the conversations the user is about to read loaded, so
arrowing through a list never lands on a blank or half-loaded email (design:
`docs/superpowers/specs/2026-11-06-preload-ahead-design.md`).

| Limit | Why |
| --- | --- |
| First 20 rows on arrival, and of Inbox and each category | Alex's figure; switching lists is instant without warming whole mailboxes |
| 16 ahead / 4 behind the open row, flipped when moving up | 3.2 s of runway at five arrows a second, plus a small window for reversing |
| 2 body preloads at once, on bulk Gmail quota | Bodies are usually local; when not, sync, sends and opens keep their quota |
| 160 cached details | Six 20-row category windows plus the moving window and the open thread |
| 256 image URLs, 4 downloads at once | Warms the HTTP cache for ~20 newsletters; leaves connections for the open email |
| 5 rendered conversations (open ± 2) | Hidden iframes keep `no-store` images and layout, which the HTTP cache can't |

The image warmer fetches `http(s)` `img`/`srcset`/`background` URLs only. Inline
`cid:` images load when a conversation is rendered, including the hidden neighbours.
With **Preload images** off, neither the warmer nor the hidden neighbours run.

`e2e/preload.spec.ts` serves 32 Updates receipts (80 ms bodies, 90 ms cacheable and
`no-store` images from a real HTTP server, since Playwright routing disables the
cache), then holds Down through 22 rows at five a second. A `requestAnimationFrame`
observer fails on any frame where the shown email is blank, loading, stale or has an
unfinished image. CI runs it in Chromium; the real check is on the Mac (WKWebView).
