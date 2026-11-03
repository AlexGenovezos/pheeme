// Mail state: the thread list for the active mailbox, kept fresh by sync events.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  type CommandError,
  listThreads,
  stopQuietly,
  SYNC_EVENTS,
  type ThreadCursor,
  type ThreadQuery,
  type ThreadSummary,
  toCommandError,
} from "../lib/tauri";

interface MailState {
  threads: ThreadSummary[];
  next: ThreadCursor | null;
  /** The query most recently asked for; its first page may still be loading or have failed. */
  query: ThreadQuery | null;
  /** The query `threads` and `next` belong to. Paging only ever continues this one. */
  loadedQuery: ThreadQuery | null;
  loading: boolean;
  error: CommandError | null;
  /** Load the first page for `query`, replacing the list. `limit` asks for more than one page. */
  load(query: ThreadQuery, limit?: number): Promise<void>;
  /** Append the next page. Does nothing while a load is in flight or at the end of the list. */
  loadMore(): Promise<void>;
  /** Re-run the current query (after a sync), as deep as the list is loaded so the scroll position survives. */
  reload(): Promise<void>;
  /**
   * Rewrite the rows named by `keys` (optimistic changes). With an `op` (from `newOp`) the change is also pending:
   * every later load, reload and page re-applies it until `settle(op)`, so a reload that was answered before the
   * command reached the cache can't bring the old state back. A removal means "leaves the mailbox shown", so it is
   * held only for results of that same query; other mailboxes still list the conversation.
   */
  patch(keys: ThreadKey[], fn: (thread: ThreadSummary) => ThreadSummary, op?: number): void;
  /** Drop the rows named by `keys` (optimistic archive, delete); pending like `patch` when given an `op`. */
  remove(keys: ThreadKey[], op?: number): void;
  /**
   * The command for `op` has settled: stop re-applying its changes (the cache now says the same, or a reload restores
   * the truth). `keys` limits that to some rows, for an action whose accounts settle one at a time.
   */
  settle(op: number, keys?: ThreadKey[]): void;
  /** Clear the list without querying (mailboxes with no backing label yet). */
  clear(): void;
  /** Reload on sync events. Resolves to the unsubscribe function. */
  subscribe(): Promise<() => void>;
}

// Each load takes a ticket; only the latest ticket may write its result.
let latest = 0;

const PAGE = 50;
const MAX_RELOAD = 500;
/** A reload re-queries what is loaded, within one page and the backend's page cap. */
const reloadDepth = (loaded: number) => Math.min(Math.max(loaded, PAGE), MAX_RELOAD);
const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/**
 * A change not yet in the cache. `fn: null` removes the row, from results of `query` only (`null`: of any query).
 * Entries for a key apply in the order they were made.
 */
interface PendingChange {
  op: number;
  fn: ((thread: ThreadSummary) => ThreadSummary) | null;
  query: ThreadQuery | null;
}
let pending = new Map<ThreadKey, PendingChange[]>();
let ops = 0;

/** A fresh id to tag the changes of one action, for `patch`, `remove` and `settle`. */
export const newOp = () => ++ops;

function register(keys: ThreadKey[], change: PendingChange) {
  for (const key of keys) pending.set(key, [...(pending.get(key) ?? []), change]);
}

/** Query results for `query` with the pending changes laid over them. */
function overlay(threads: ThreadSummary[], query: ThreadQuery): ThreadSummary[] {
  if (pending.size === 0) return threads;
  const out: ThreadSummary[] = [];
  for (const thread of threads) {
    let row: ThreadSummary | null = thread;
    for (const change of pending.get(keyOf(thread)) ?? []) {
      if (!change.fn) {
        if (change.query !== null && !sameQuery(change.query, query)) continue;
        row = null;
        break;
      }
      row = change.fn(row);
    }
    if (row) out.push(row);
  }
  return out;
}

const sameQuery = (a: ThreadQuery | null, b: ThreadQuery | null) =>
  a !== null &&
  b !== null &&
  a.labelId === b.labelId &&
  (a.alsoLabelId ?? null) === (b.alsoLabelId ?? null) &&
  a.accountIds.length === b.accountIds.length &&
  a.accountIds.every((id, i) => id === b.accountIds[i]);

const EMPTY = { threads: [], next: null, loadedQuery: null, loading: false, error: null };

export const useMailStore = create<MailState>((set, get) => ({
  ...EMPTY,
  query: null,
  load: async (query, limit) => {
    const ticket = ++latest;
    set({ query, loading: true });
    try {
      const page = await listThreads({
        accountIds: query.accountIds,
        labelId: query.labelId,
        ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
        ...(limit ? { limit } : {}),
      });
      if (ticket !== latest) return;
      set({ threads: overlay(page?.threads ?? [], query), next: page?.next ?? null, loadedQuery: query, loading: false, error: null });
    } catch (error) {
      if (ticket !== latest) return;
      // The previous mailbox's rows and cursor mustn't masquerade as this one's; a failed reload of the same query keeps its rows.
      const stale = sameQuery(get().loadedQuery, query) ? {} : { threads: [], next: null, loadedQuery: null };
      set({ ...stale, loading: false, error: toCommandError(error) });
    }
  },
  loadMore: async () => {
    const { query, loadedQuery, next, loading } = get();
    if (!query || !next || loading || !sameQuery(loadedQuery, query)) return;
    const ticket = ++latest;
    set({ loading: true });
    try {
      const page = await listThreads({
        accountIds: query.accountIds,
        labelId: query.labelId,
        ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
        before: next,
      });
      if (ticket !== latest) return;
      set((s) => {
        const have = new Set(s.threads.map(keyOf));
        const fresh = overlay((page?.threads ?? []).filter((t) => !have.has(keyOf(t))), query);
        return { threads: [...s.threads, ...fresh], next: page?.next ?? null, loading: false, error: null };
      });
    } catch (error) {
      if (ticket !== latest) return;
      set({ loading: false, error: toCommandError(error) });
    }
  },
  reload: async () => {
    const { query, threads } = get();
    if (query) await get().load(query, reloadDepth(threads.length));
  },
  patch: (keys, fn, op) => {
    if (op !== undefined) register(keys, { op, fn, query: null });
    const wanted = new Set(keys);
    set((s) => ({ threads: s.threads.map((t) => (wanted.has(keyOf(t)) ? fn(t) : t)) }));
  },
  remove: (keys, op) => {
    // The rows being removed are in the list on screen, which is the loaded query (else the one asked for).
    if (op !== undefined) register(keys, { op, fn: null, query: get().loadedQuery ?? get().query });
    const gone = new Set(keys);
    set((s) => ({ threads: s.threads.filter((t) => !gone.has(keyOf(t))) }));
  },
  settle: (op, keys) => {
    const only = keys ? new Set(keys) : null;
    const next = new Map<ThreadKey, PendingChange[]>();
    for (const [key, changes] of pending) {
      const rest = only && !only.has(key) ? changes : changes.filter((c) => c.op !== op);
      if (rest.length > 0) next.set(key, rest);
    }
    pending = next;
  },
  clear: () => {
    latest++;
    set({ ...EMPTY, query: null });
  },
  subscribe: async () => {
    const reload = () => void get().reload();
    const stops = await Promise.all([
      listen(SYNC_EVENTS.messagesUpdated, reload),
      listen(SYNC_EVENTS.completed, reload),
    ]);
    return () => stops.forEach(stopQuietly);
  },
}));

/** Test helper. */
export function __resetMailStoreForTests() {
  latest++;
  pending = new Map();
  useMailStore.setState({ ...EMPTY, query: null });
}
