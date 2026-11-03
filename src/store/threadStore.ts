// Conversation details for the reading pane: a small LRU cache, prefetch, and eviction on sync.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { parseThreadKey, type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  type CommandError,
  getThread,
  stopQuietly,
  SYNC_EVENTS,
  type SyncAccountEvent,
  type SyncMessagesUpdated,
  type ThreadDetail,
  toCommandError,
} from "../lib/tauri";
import { useUiStore } from "./uiStore";

export const DETAIL_CACHE_SIZE = 30;

/** Optimistic detail changes the cache hasn't caught up with, per thread, in the order they were made. */
let pendingDetails = new Map<ThreadKey, Array<{ op: number; fn: (detail: ThreadDetail) => ThreadDetail }>>();
const withPending = (key: ThreadKey, detail: ThreadDetail) =>
  (pendingDetails.get(key) ?? []).reduce((d, change) => change.fn(d), detail);

/** Every message has its body. An incomplete detail (fetched offline) is asked for again rather than served. */
export const isComplete = (detail: ThreadDetail) => detail.messages.every((m) => m.bodyAvailable);

interface ThreadState {
  /** Insertion order is recency: the last entry is the most recently used. */
  details: Map<ThreadKey, ThreadDetail>;
  /** The last failure to load each thread. A thread that isn't there any more is `not_found`. */
  errors: Record<ThreadKey, CommandError>;
  /**
   * Make the detail available: complete cached details are just touched, a request already in flight is joined,
   * and a cached detail missing a body is shown while it is requested again.
   */
  load(key: ThreadKey): Promise<void>;
  /**
   * Waits until the detail is cached, or a request for it has failed. Unlike one `load`, it outlasts a request that
   * ends without caching anything because a refresh superseded it or an eviction dropped it, up to five of them.
   * Resolves to whether the detail is cached.
   */
  waitForDetail(key: ThreadKey): Promise<boolean>;
  /** Warm the cache for neighbours of the open thread. Failures are ignored. */
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
   * open thread if it is missing a body. Resolves to the unsubscribe function.
   */
  subscribe(): Promise<() => void>;
}

// A request is current while it is the entry here; evicting or re-requesting a key supersedes it.
// `quiet` requests (prefetch) swallow failures; a foreground `load` that joins one makes it loud.
const inflight = new Map<ThreadKey, { ticket: number; promise: Promise<void>; quiet: boolean }>();
let tickets = 0;

export const useThreadStore = create<ThreadState>((set, get) => {
  const fetchDetail = (key: ThreadKey, quiet = false): Promise<void> => {
    const ticket = ++tickets;
    const { accountId, threadId } = parseThreadKey(key);
    const current = () => inflight.get(key)?.ticket === ticket;
    const promise = (async () => {
      try {
        const detail = await getThread(accountId, threadId);
        if (!current()) return;
        set((s) => {
          const details = new Map(s.details);
          details.delete(key); // re-insert as the most recent
          details.set(key, withPending(key, detail));
          while (details.size > DETAIL_CACHE_SIZE) details.delete(details.keys().next().value as ThreadKey);
          const errors = { ...s.errors };
          delete errors[key];
          return { details, errors };
        });
      } catch (error) {
        if (!current() || inflight.get(key)?.quiet) return;
        const failure = toCommandError(error);
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
      }
    })();
    inflight.set(key, { ticket, promise, quiet });
    return promise;
  };

  return {
    details: new Map(),
    errors: {},
    load: (key) => {
      const cached = get().details.get(key);
      if (cached && !isComplete(cached)) {
        const joined = inflight.get(key);
        if (!joined) return fetchDetail(key);
        joined.quiet = false;
        return joined.promise;
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
      const joined = inflight.get(key);
      if (!joined) return fetchDetail(key);
      joined.quiet = false;
      return joined.promise;
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
      for (const key of keys) {
        if (!get().details.has(key) && !inflight.has(key)) void fetchDetail(key, true);
      }
    },
    settleDetails: (op, keys) => {
      for (const key of keys) {
        const rest = (pendingDetails.get(key) ?? []).filter((c) => c.op !== op);
        if (rest.length > 0) pendingDetails.set(key, rest);
        else pendingDetails.delete(key);
      }
    },
    patchDetail: (key, fn, op) => {
      if (op !== undefined) pendingDetails.set(key, [...(pendingDetails.get(key) ?? []), { op, fn }]);
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
      keys.forEach((key) => inflight.delete(key));
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
    subscribe: async () => {
      const stop = await listen<SyncMessagesUpdated>(SYNC_EVENTS.messagesUpdated, ({ payload }) => {
        const changed = [...payload.modified, ...payload.removed];
        if (changed.length === 0) return;
        const open = useUiStore.getState().openThread;
        const parsed = open ? parseThreadKey(open) : null;
        const refresh = open && parsed?.accountId === payload.accountId && changed.includes(parsed.threadId) ? open : null;
        // The open thread is refreshed in place so the pane never blanks; the rest are simply forgotten.
        get().evict(payload.accountId, refresh ? changed.filter((id) => id !== parsed?.threadId) : changed);
        if (refresh) void fetchDetail(refresh);
      });
      // A body that couldn't be fetched offline may be reachable now that a sync got through.
      const stopCompleted = await listen<SyncAccountEvent>(SYNC_EVENTS.completed, ({ payload }) => {
        const open = useUiStore.getState().openThread;
        if (!open || parseThreadKey(open).accountId !== payload.accountId) return;
        const cached = get().details.get(open);
        if (cached && !isComplete(cached)) void get().load(open);
      });
      return () => {
        stopQuietly(stop);
        stopQuietly(stopCompleted);
      };
    },
  };
});

/** Test helper. */
export function __resetThreadStoreForTests() {
  inflight.clear();
  pendingDetails = new Map();
  useThreadStore.setState({ details: new Map(), errors: {} });
}
