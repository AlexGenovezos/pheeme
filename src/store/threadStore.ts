// Conversation details for the reading pane: a small LRU cache, prefetch, and eviction on sync.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import { parseThreadKey, type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  type CommandError,
  getThread,
  SYNC_EVENTS,
  type SyncAccountEvent,
  type SyncMessagesUpdated,
  THREAD_LOADING_EVENT,
  type ThreadDetail,
  type ThreadLoading,
  toCommandError,
} from "../lib/tauri";
import { useUiStore } from "./uiStore";
import { useMailStore } from "./mailStore";

// 20 active rows + six 20-row Inbox/category windows, with room for the open detail and recent rows.
export const DETAIL_CACHE_SIZE = 160;

/** Optimistic detail changes the cache hasn't caught up with, per thread, in the order they were made. */
let pendingDetails = new Map<
  ThreadKey,
  Array<{ op: number; fn: (detail: ThreadDetail) => ThreadDetail }>
>();
const withPending = (key: ThreadKey, detail: ThreadDetail) =>
  (pendingDetails.get(key) ?? []).reduce((d, change) => change.fn(d), detail);

/** Every message has its body. An incomplete detail (fetched offline) is asked for again rather than served. */
export const isComplete = (detail: ThreadDetail) => detail.messages.every((m) => m.bodyAvailable);

interface ThreadState {
  /** Insertion order is recency: the last entry is the most recently used. */
  details: Map<ThreadKey, ThreadDetail>;
  /** The last failure to load each thread. A thread that isn't there any more is `not_found`. */
  errors: Record<ThreadKey, CommandError>;
  /** What an open still fetching from Gmail is waiting on (`mail:thread_loading`), until the fetch settles. */
  loading: Record<ThreadKey, ThreadLoading>;
  /**
   * Make the detail available: complete cached details are touched, foreground requests in flight are joined,
   * and a cached detail missing a body is shown while it is requested again.
   */
  load(key: ThreadKey): Promise<void>;
  /**
   * Waits until the detail is cached, or a request for it has failed. Unlike one `load`, it outlasts a request that
   * ends without caching anything because a refresh superseded it or an eviction dropped it, up to five of them.
   * Resolves to whether the detail is cached.
   */
  waitForDetail(key: ThreadKey): Promise<boolean>;
  /** Replace the bounded, priority-ordered speculative window. Empty cancels it; failures are silent. */
  prefetch(keys: ThreadKey[]): void;
  /**
   * Rewrite a cached detail in place (optimistic label changes). With an `op` (from `newOp`) the change is also
   * pending: every fetch of this thread re-applies it until `settleDetails`, so a refresh that was answered before
   * the cache changed can't bring the old chips back.
   */
  patchDetail(key: ThreadKey, fn: (detail: ThreadDetail) => ThreadDetail, op?: number): void;
  /** The command for `op` has settled for these threads: stop re-applying its changes. */
  settleDetails(op: number, keys: ThreadKey[]): void;
  /** Forget threads of one account (their messages changed), including any response still in flight. */
  evict(accountId: string, threadIds: string[]): void;
  /**
   * Evict on `sync:messages_updated` and refresh the open thread if it changed; on `sync:completed` re-request the
   * open thread if it is missing a body; track `mail:thread_loading`. Resolves to the unsubscribe function.
   */
  subscribe(signal?: AbortSignal): Promise<() => void>;
}

// A request is current while it is the entry here; evicting or re-requesting a key supersedes it.
// Foreground requests supersede quiet work: bulk may be waiting for quota.
const inflight = new Map<ThreadKey, { ticket: number; promise: Promise<void>; quiet: boolean }>();
let tickets = 0;
/** The list window plus six 20-row category windows; below the cache size, so preloads don't evict each other. */
const PREFETCH_LIMIT = 140;
const PREFETCHES_AT_ONCE = 2;
/** After Gmail refuses a preload for quota, the rest wait out the rate window. */
const RATE_LIMIT_PAUSE_MS = 60_000;
let wanted: ThreadKey[] = [];
/** Wanted keys already requested once, so a failure isn't retried in a loop. */
let tried = new Set<ThreadKey>();
let rateLimited = false;
/** Preloads still running, including ones that left the window: their answers are ignored, but they still cost. */
let preloading = 0;

export const useThreadStore = create<ThreadState>((set, get) => {
  const clearLoading = (key: ThreadKey) =>
    set((s) => {
      if (!(key in s.loading)) return {};
      const loading = { ...s.loading };
      delete loading[key];
      return { loading };
    });

  /** Start wanted preloads, two at a time, while nothing the user is waiting for (an open, the list) is loading. */
  const pump = () => {
    if (
      rateLimited ||
      useMailStore.getState().loading ||
      [...inflight.values()].some((r) => !r.quiet)
    )
      return;
    for (const key of wanted) {
      if (preloading >= PREFETCHES_AT_ONCE) return;
      if (tried.has(key) || inflight.has(key) || get().details.has(key)) continue;
      tried.add(key);
      preloading++;
      void fetchDetail(key, true).finally(() => {
        preloading = Math.max(0, preloading - 1);
        pump();
      });
    }
  };
  const fetchDetail = (key: ThreadKey, quiet = false): Promise<void> => {
    const ticket = ++tickets;
    const { accountId, threadId } = parseThreadKey(key);
    const current = () => inflight.get(key)?.ticket === ticket;
    const promise = (async () => {
      try {
        const detail = await getThread(accountId, threadId, !quiet, quiet);
        if (!current()) return;
        set((s) => {
          const details = new Map(s.details);
          details.delete(key); // re-insert as the most recent
          details.set(key, withPending(key, detail));
          // Evict the least recent detail that is neither open nor preloaded on purpose. The preload window is
          // smaller than the cache, so there is always one, and preloads never push each other out.
          const keep = new Set([...wanted, useUiStore.getState().openThread]);
          while (details.size > DETAIL_CACHE_SIZE) {
            const oldest = [...details.keys()].find((k) => !keep.has(k));
            if (oldest === undefined) break;
            details.delete(oldest);
          }
          const errors = { ...s.errors };
          delete errors[key];
          return { details, errors };
        });
      } catch (error) {
        const failure = toCommandError(error);
        if (current() && quiet && failure.code === "rate_limit" && !rateLimited) {
          rateLimited = true;
          setTimeout(() => {
            rateLimited = false;
            pump();
          }, RATE_LIMIT_PAUSE_MS);
        }
        if (!current() || quiet) return;
        set((s) => {
          const errors = { ...s.errors, [key]: failure };
          // Gone is gone; any other failure keeps what we already show.
          if (failure.code !== "not_found" || !s.details.has(key)) return { errors };
          const details = new Map(s.details);
          details.delete(key);
          return { details, errors };
        });
      } finally {
        if (current()) inflight.delete(key);
        // A newer request for the key reports its own progress.
        if (!inflight.has(key)) clearLoading(key);
        if (!quiet) queueMicrotask(pump);
      }
    })();
    inflight.set(key, { ticket, promise, quiet });
    return promise;
  };

  // A prefetch asked Gmail as background work; the user's open asks again so it isn't queued
  // behind sync (the new request supersedes the prefetch).
  const joinOrFetch = (key: ThreadKey): Promise<void> => {
    const joined = inflight.get(key);
    if (!joined || joined.quiet) return fetchDetail(key);
    return joined.promise;
  };

  return {
    details: new Map(),
    errors: {},
    loading: {},
    load: (key) => {
      const cached = get().details.get(key);
      if (cached && !isComplete(cached)) {
        return joinOrFetch(key);
      }
      if (cached) {
        // Touch: move to the most recent position.
        set((s) => {
          const details = new Map(s.details);
          details.delete(key);
          details.set(key, cached);
          return { details };
        });
        return Promise.resolve();
      }
      return joinOrFetch(key);
    },
    waitForDetail: async (key) => {
      // Each round joins the request in flight (a refresh that superseded ours) or starts one. Bounded, so a
      // conversation that keeps changing can't hold its caller forever.
      for (let round = 0; round < 5 && !get().details.has(key); round++) {
        const before = get().errors[key];
        await get().load(key);
        const after = get().errors[key];
        if (after !== undefined && after !== before) break;
      }
      return get().details.has(key);
    },
    prefetch: (keys) => {
      wanted = [...new Set(keys)].slice(0, PREFETCH_LIMIT);
      const keep = new Set(wanted);
      // Preloads that left the window are dropped; their answers are ignored.
      for (const [key, request] of inflight)
        if (request.quiet && !keep.has(key)) inflight.delete(key);
      tried = new Set([...tried].filter((key) => keep.has(key)));
      pump();
    },
    settleDetails: (op, keys) => {
      for (const key of keys) {
        const rest = (pendingDetails.get(key) ?? []).filter((c) => c.op !== op);
        if (rest.length > 0) pendingDetails.set(key, rest);
        else pendingDetails.delete(key);
      }
    },
    patchDetail: (key, fn, op) => {
      if (op !== undefined)
        pendingDetails.set(key, [...(pendingDetails.get(key) ?? []), { op, fn }]);
      set((s) => {
        const current = s.details.get(key);
        if (!current) return {};
        const details = new Map(s.details);
        details.set(key, fn(current)); // an existing key keeps its place in the LRU order
        return { details };
      });
    },
    evict: (accountId, threadIds) => {
      const keys = threadIds.map((id) => threadKey(accountId, id));
      keys.forEach((key) => {
        inflight.delete(key);
        tried.delete(key);
      });
      set((s) => {
        const hit = keys.filter((k) => s.details.has(k) || k in s.errors);
        if (hit.length === 0) return {};
        const details = new Map(s.details);
        const errors = { ...s.errors };
        for (const key of hit) {
          details.delete(key);
          delete errors[key];
        }
        return { details, errors };
      });
    },
    subscribe: (signal) =>
      subscribeAll(
        [
          () =>
            listen<SyncMessagesUpdated>(SYNC_EVENTS.messagesUpdated, ({ payload }) => {
              const changed = [...payload.modified, ...payload.removed];
              if (changed.length === 0) return;
              const open = useUiStore.getState().openThread;
              const parsed = open ? parseThreadKey(open) : null;
              const refresh =
                open && parsed?.accountId === payload.accountId && changed.includes(parsed.threadId)
                  ? open
                  : null;
              // The open thread is refreshed in place so the pane never blanks; the rest are simply forgotten.
              get().evict(
                payload.accountId,
                refresh ? changed.filter((id) => id !== parsed?.threadId) : changed,
              );
              if (refresh) void fetchDetail(refresh);
            }),
          // A body that couldn't be fetched offline may be reachable now that a sync got through.
          () =>
            listen<SyncAccountEvent>(SYNC_EVENTS.completed, ({ payload }) => {
              const open = useUiStore.getState().openThread;
              if (!open || parseThreadKey(open).accountId !== payload.accountId) return;
              const cached = get().details.get(open);
              if (cached && !isComplete(cached)) void get().load(open);
            }),
          () =>
            listen<ThreadLoading>(THREAD_LOADING_EVENT, ({ payload }) => {
              const key = threadKey(payload.accountId, payload.threadId);
              // Events travel apart from the reply: one that lands after the fetch settled is stale.
              if (payload.stage === "done" || !inflight.has(key)) clearLoading(key);
              else set((s) => ({ loading: { ...s.loading, [key]: payload } }));
            }),
        ],
        signal,
      ),
  };
});

/** Test helper. */
export function __resetThreadStoreForTests() {
  wanted = [];
  tried.clear();
  rateLimited = false;
  preloading = 0;
  inflight.clear();
  pendingDetails = new Map();
  useThreadStore.setState({ details: new Map(), errors: {}, loading: {} });
}
