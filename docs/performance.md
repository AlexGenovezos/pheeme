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
are warm. The test fails when:

- the live heap keeps growing (a least-squares slope over the last three quarters of the
  cycles above 256 bytes per cycle; a healthy run is around 40), or
- the peak heap passes its budget, set about 20% above the measured peak.

| Size | Where | Mailbox | Cycles | Peak budget |
|------|-------|---------|--------|-------------|
| short | `Performance` workflow, every PR | 5,000 messages | 200 | 4 MiB |
| long | `Nightly performance` workflow | 20,000 messages | 1,000 | 14 MiB |

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
