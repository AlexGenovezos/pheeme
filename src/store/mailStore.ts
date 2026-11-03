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
  query: ThreadQuery | null;
  loading: boolean;
  error: CommandError | null;
  /** Load the first page for `query`, replacing the list. `limit` asks for more than one page. */
  load(query: ThreadQuery, limit?: number): Promise<void>;
  /** Append the next page. Does nothing while a load is in flight or at the end of the list. */
  loadMore(): Promise<void>;
  /** Re-run the current query (after a sync), as deep as the list is loaded so the scroll position survives. */
  reload(): Promise<void>;
  /** Rewrite the rows named by `keys` (optimistic changes). */
  patch(keys: ThreadKey[], fn: (thread: ThreadSummary) => ThreadSummary): void;
  /** Drop the rows named by `keys` (optimistic archive, delete). */
  remove(keys: ThreadKey[]): void;
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

const EMPTY = { threads: [], next: null, loading: false, error: null };

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
      set({ threads: page?.threads ?? [], next: page?.next ?? null, loading: false, error: null });
    } catch (error) {
      if (ticket !== latest) return;
      set({ loading: false, error: toCommandError(error) });
    }
  },
  loadMore: async () => {
    const { query, next, loading } = get();
    if (!query || !next || loading) return;
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
        const fresh = (page?.threads ?? []).filter((t) => !have.has(keyOf(t)));
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
  patch: (keys, fn) => {
    const wanted = new Set(keys);
    set((s) => ({ threads: s.threads.map((t) => (wanted.has(keyOf(t)) ? fn(t) : t)) }));
  },
  remove: (keys) => {
    const gone = new Set(keys);
    set((s) => ({ threads: s.threads.filter((t) => !gone.has(keyOf(t))) }));
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
  useMailStore.setState({ ...EMPTY, query: null });
}
