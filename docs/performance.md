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

A nightly failure opens an issue (or comments on the open one). On a failure, the job
uploads `dhat-heap.json`: open it in
[dh_view](https://nnethercote.github.io/dh_view/dh_view.html) to see which allocation sites
hold the memory. The first version of this check found sync keeping every deleted message's
id for good once the backfill had finished.

```bash
cd src-tauri
cargo test --release --features test-support --test soak -- --nocapture
SOAK=long cargo test --release --features test-support --test soak -- --nocapture
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
that one (`threadStore.test.ts` checks the cache keeps 30).
Chromium stands in for the real webviews (WebKitGTK, WKWebView, WebView2): it catches JS
leaks (stores, listeners, detached DOM), not engine-specific ones.

```bash
npx playwright install chromium   # once
npm run test:memory
```

It builds the preview with `vite build` and serves it on port 4173 for the run.

## Real app on Linux (nightly)

The `app` job of the `Nightly performance` workflow builds the release app and fills a
throwaway home directory with a synced-looking 20,000-conversation mailbox
([`src-tauri/examples/seed_mailbox.rs`](../src-tauri/examples/seed_mailbox.rs)). It then
launches the app under `xvfb` through `tauri-driver` (WebDriver) with
[`scripts/perf/app-run.mjs`](../scripts/perf/app-run.mjs), inside its own D-Bus session so
it never touches a real keychain, and records:

| Measure | First CI runs | Budget |
|---------|---------------|--------|
| Start (WebDriver session request to the first list row), median of 5 launches | single starts 0.9 to 2.1 s | 3 s |
| Memory after a minute idle: app plus its WebKit processes, PSS | 236 to 239 MiB | 290 MiB |
| The same after a scripted 10-minute session (mailboxes, scrolling, conversations) | 300 MiB | 360 MiB |

The budgets sit about 20% above those first measurements on an `ubuntu-22.04` runner, which
renders in software under Xvfb. Idle memory is well over the issue's starting target of
150 MiB, and the session adds about 64 MiB: both are worth a look.

Memory is PSS (proportional set size), which splits shared pages between the processes
using them, so the total isn't inflated by WebKit's shared libraries the way summed RSS is.
A run fails when it exceeds a budget, or when a memory measure gets more than 20% worse than
the previous nightly run. Start time is tracked over runs too, but a 20% swing isn't a
failure: one start varies by a factor of two on shared runners. github-action-benchmark keeps that history in the Actions cache, and
the job summary shows the comparison. A PR that changes the harness itself runs it too.

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
