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
