// Conversation details for the reading pane: a small LRU cache, prefetch, and eviction on sync.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { parseThreadKey, type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  type CommandError,
  getThread,
  stopQuietly,
  SYNC_EVENTS,
  type SyncMessagesUpdated,
  type ThreadDetail,
  toCommandError,
} from "../lib/tauri";
import { useUiStore } from "./uiStore";

export const DETAIL_CACHE_SIZE = 30;

interface ThreadState {
  /** Insertion order is recency: the last entry is the most recently used. */
  details: Map<ThreadKey, ThreadDetail>;
  /** The last failure to load each thread. A thread that isn't there any more is `not_found`. */
  errors: Record<ThreadKey, CommandError>;
  /** Make the detail available: cached details are just touched, a request already in flight is joined. */
  load(key: ThreadKey): Promise<void>;
  /** Warm the cache for neighbours of the open thread. Failures are ignored. */
  prefetch(keys: ThreadKey[]): void;
  /** Forget threads of one account (their messages changed), including any response still in flight. */
  evict(accountId: string, threadIds: string[]): void;
  /** Evict on `sync:messages_updated`, and refresh the open thread if it changed. Resolves to the unsubscribe function. */
  subscribe(): Promise<() => void>;
}

// A request is current while it is the entry here; evicting or re-requesting a key supersedes it.
const inflight = new Map<ThreadKey, { ticket: number; promise: Promise<void> }>();
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
          details.set(key, detail);
          while (details.size > DETAIL_CACHE_SIZE) details.delete(details.keys().next().value as ThreadKey);
          const errors = { ...s.errors };
          delete errors[key];
          return { details, errors };
        });
      } catch (error) {
        if (!current() || quiet) return;
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
    inflight.set(key, { ticket, promise });
    return promise;
  };

  return {
    details: new Map(),
    errors: {},
    load: (key) => {
      if (get().details.has(key)) {
        // Touch: move to the most recent position.
        set((s) => {
          const details = new Map(s.details);
          details.delete(key);
          details.set(key, s.details.get(key) as ThreadDetail);
          return { details };
        });
        return Promise.resolve();
      }
      return inflight.get(key)?.promise ?? fetchDetail(key);
    },
    prefetch: (keys) => {
      for (const key of keys) {
        if (!get().details.has(key) && !inflight.has(key)) void fetchDetail(key, true);
      }
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
      return () => stopQuietly(stop);
    },
  };
});

/** Test helper. */
export function __resetThreadStoreForTests() {
  inflight.clear();
  useThreadStore.setState({ details: new Map(), errors: {} });
}
