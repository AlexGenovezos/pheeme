// Mail state: the thread list for the active mailbox, kept fresh by sync events.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import { parseThreadKey, type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  type CommandError,
  listThreads,
  getThread,
  searchMessages,
  searchGmail,
  SYNC_EVENTS,
  type ThreadCursor,
  type ThreadQuery,
  type ThreadSummary,
  type SyncMessagesUpdated,
  toCommandError,
} from "../lib/tauri";

/** Search spans the chosen accounts, independently of the mailbox underneath it. */
export interface MailQuery extends ThreadQuery {
  search?: string;
}

interface SearchState {
  local: boolean | null;
  remoteLoading: boolean;
  remoteNext: Record<string, string>;
  /** Failed accounts and the page to retry; null means their first page. */
  failed: Record<string, string | null>;
  remoteError: CommandError | null;
}

interface MailState {
  search: SearchState | null;
  retryGmail(): Promise<void>;
  threads: ThreadSummary[];
  next: ThreadCursor | null;
  /** The query most recently asked for; its first page may still be loading or have failed. */
  query: MailQuery | null;
  /** The query `threads` and `next` belong to. Paging only ever continues this one. */
  loadedQuery: MailQuery | null;
  loading: boolean;
  error: CommandError | null;
  /** Load the first page for `query`, replacing the list. `limit` asks for more than one page. */
  load(query: MailQuery, limit?: number, preserveRead?: boolean): Promise<void>;
  /** Append the next page. Does nothing while a load is in flight or at the end of the list. */
  loadMore(): Promise<void>;
  /** Re-run the current query (after a sync), as deep as the list is loaded so the scroll position survives. */
  reload(preserveRead?: boolean): Promise<void>;
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
   * `rejected` leaves Gmail-only search snapshots unchanged so a reload can restore them.
   */
  settle(op: number, keys?: ThreadKey[], rejected?: boolean): void;
  /** Clear the list without querying (mailboxes with no backing label yet). */
  clear(): void;
  /** Reload on sync events. Resolves to the unsubscribe function. */
  subscribe(signal?: AbortSignal): Promise<() => void>;
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
  query: MailQuery | null;
}
let pending = new Map<ThreadKey, PendingChange[]>();
let ops = 0;
// Rows read during this mailbox visit remain eligible in background queries. The backend
// still checks mailbox membership, so archiving, deleting or relabelling them removes them.
const keptRead = new Set<ThreadKey>();
const readArgs = (query: ThreadQuery) =>
  query.unreadOnly
    ? {
        unreadOnly: true,
        keepRead: [...keptRead].map((key): [string, string] => {
          const { accountId, threadId } = parseThreadKey(key);
          return [accountId, threadId];
        }),
      }
    : {};

/** A fresh id to tag the changes of one action, for `patch`, `remove` and `settle`. */
export const newOp = () => ++ops;

function register(keys: ThreadKey[], change: PendingChange) {
  for (const key of keys) pending.set(key, [...(pending.get(key) ?? []), change]);
}

/** Query results for `query` with the pending changes laid over them. */
function overlay(threads: ThreadSummary[], query: MailQuery): ThreadSummary[] {
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

const sameQuery = (a: MailQuery | null, b: MailQuery | null) =>
  a !== null &&
  b !== null &&
  a.labelId === b.labelId &&
  a.search === b.search &&
  !!a.unreadOnly === !!b.unreadOnly &&
  (a.alsoLabelId ?? null) === (b.alsoLabelId ?? null) &&
  a.accountIds.length === b.accountIds.length &&
  a.accountIds.every((id, i) => id === b.accountIds[i]);

const EMPTY = {
  search: null,
  threads: [],
  next: null,
  loadedQuery: null,
  loading: false,
  error: null,
};

/** Preserve existing row positions as Gmail adds matches; identity always includes the account. */
function appendUnique(existing: ThreadSummary[], incoming: ThreadSummary[]): ThreadSummary[] {
  const have = new Set(existing.map(keyOf));
  return [
    ...existing,
    ...incoming.filter((t) => {
      if (have.has(keyOf(t))) return false;
      have.add(keyOf(t));
      return true;
    }),
  ];
}

export const useMailStore = create<MailState>((set, get) => {
  let localVersion = 0;
  let remoteRows = new Map<ThreadKey, ThreadSummary>();
  let removedFromSearch = new Set<ThreadKey>();
  const remoteUpdates = new Map<ThreadKey, number>();

  const localSearch = async (ticket: number, query: MailQuery, limit?: number, more = false) => {
    const version = ++localVersion;
    const before = more ? get().next : null;
    set({ loading: true });
    try {
      const page = await searchMessages(query.accountIds, query.search!, before, limit);
      if (ticket !== latest || version !== localVersion) return;
      const rows = overlay(page.threads, query);
      for (const row of rows) remoteRows.delete(keyOf(row));
      set((s) => {
        const retained = more
          ? s.threads
          : overlay(
              [...remoteRows.values()].filter((row) => !removedFromSearch.has(keyOf(row))),
              query,
            );
        const matches = new Map(rows.map((t) => [keyOf(t), t]));
        const combined = more ? appendUnique(retained, rows) : appendUnique(rows, retained);
        // Reloads refresh matching rows but keep the order the user is already reading.
        const byKey = new Map(combined.map((t) => [keyOf(t), matches.get(keyOf(t)) ?? t]));
        const stable = more
          ? combined
          : appendUnique(
              s.threads.filter((t) => byKey.has(keyOf(t))).map((t) => byKey.get(keyOf(t))!),
              combined,
            );
        return {
          threads: stable,
          next: page.next,
          loadedQuery: query,
          loading: false,
          error: null,
          search: s.search && { ...s.search, local: page.local },
        };
      });
    } catch (error) {
      if (ticket === latest && version === localVersion)
        set({ loading: false, error: toCommandError(error) });
    }
  };

  const gmailSearch = async (
    ticket: number,
    query: MailQuery,
    accounts: string[],
    tokens?: Record<string, string>,
    localReady?: Promise<void>,
  ) => {
    try {
      // Start the network request immediately, but put cached rows on screen before appending Gmail's.
      const page = await searchGmail(accounts, query.search!, tokens);
      await localReady;
      if (ticket !== latest) return;
      // Only preserve matches local search cannot answer (e.g. HTML-only bodies).
      const localKeys = new Set(get().threads.map(keyOf));
      const fresh = page.threads.filter((row) => !removedFromSearch.has(keyOf(row)));
      for (const row of fresh) if (!localKeys.has(keyOf(row))) remoteRows.set(keyOf(row), row);
      set((s) => {
        if (!s.search) return {};
        const failed = { ...s.search.failed };
        const remoteNext = { ...s.search.remoteNext };
        for (const id of accounts) {
          delete failed[id];
          delete remoteNext[id];
        }
        for (const id of page.failed) failed[id] = tokens?.[id] ?? null;
        return {
          threads: appendUnique(s.threads, overlay(fresh, query)),
          search: {
            ...s.search,
            remoteNext: { ...remoteNext, ...page.next },
            failed,
            remoteError: Object.keys(failed).length
              ? { code: "network", message: "Some accounts couldn't be searched on Gmail." }
              : null,
          },
        };
      });
    } catch (error) {
      await localReady;
      if (ticket !== latest) return;
      set((s) => ({
        search: s.search && {
          ...s.search,
          remoteNext: Object.fromEntries(
            Object.entries(s.search.remoteNext).filter(([id]) => !accounts.includes(id)),
          ),
          failed: {
            ...s.search.failed,
            ...Object.fromEntries(accounts.map((id) => [id, tokens?.[id] ?? null])),
          },
          remoteError: toCommandError(error),
        },
      }));
    }
  };

  const remotePages = async (retry = false) => {
    const { query, search } = get();
    if (!query?.search || !search || search.remoteLoading) return;
    const pages = retry ? search.failed : search.remoteNext;
    const first = Object.keys(pages).filter((id) => pages[id] === null);
    const tokens = Object.fromEntries(
      Object.entries(pages).filter((entry): entry is [string, string] => entry[1] !== null),
    );
    if (!first.length && !Object.keys(tokens).length) return;
    const ticket = latest;
    set({ search: { ...search, remoteLoading: true } });
    await Promise.all([
      ...(first.length ? [gmailSearch(ticket, query, first)] : []),
      ...(Object.keys(tokens).length
        ? [gmailSearch(ticket, query, Object.keys(tokens), tokens)]
        : []),
    ]);
    if (ticket === latest)
      set((s) => ({ search: s.search && { ...s.search, remoteLoading: false } }));
  };

  return {
    ...EMPTY,
    query: null,
    load: async (query, limit, preserveRead = false) => {
      if (!preserveRead || !sameQuery(get().query, query)) keptRead.clear();
      const ticket = ++latest;
      if (query.search) {
        remoteRows = new Map();
        removedFromSearch = new Set();
        remoteUpdates.clear();
        set({
          ...EMPTY,
          query,
          loading: true,
          search: {
            local: null,
            remoteLoading: true,
            remoteNext: {},
            failed: {},
            remoteError: null,
          },
        });
        const local = localSearch(ticket, query, limit);
        await Promise.all([
          local,
          (async () => {
            // Local search starts on every edit; wait for a pause before spending Gmail quota.
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (ticket === latest)
              await gmailSearch(ticket, query, query.accountIds, undefined, local);
          })(),
        ]);
        if (ticket === latest)
          set((s) => ({ search: s.search && { ...s.search, remoteLoading: false } }));
        return;
      }
      remoteRows.clear();
      removedFromSearch.clear();
      remoteUpdates.clear();
      set({ query, loading: true, search: null });
      try {
        const page = await listThreads({
          accountIds: query.accountIds,
          labelId: query.labelId,
          ...readArgs(query),
          ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
          ...(limit ? { limit } : {}),
        });
        if (ticket !== latest) return;
        set({
          threads: overlay(page?.threads ?? [], query),
          next: page?.next ?? null,
          loadedQuery: query,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (ticket !== latest) return;
        // The previous mailbox's rows and cursor mustn't masquerade as this one's; a failed reload of the same query keeps its rows.
        const stale = sameQuery(get().loadedQuery, query)
          ? {}
          : { threads: [], next: null, loadedQuery: null };
        set({ ...stale, loading: false, error: toCommandError(error) });
      }
    },
    loadMore: async () => {
      const { query, loadedQuery, next, loading, search } = get();
      if (query?.search) {
        await Promise.all([
          ...(next && !loading ? [localSearch(latest, query, undefined, true)] : []),
          ...(search && !search.remoteLoading ? [remotePages()] : []),
        ]);
        return;
      }
      if (!query || !next || loading || !sameQuery(loadedQuery, query)) return;
      const ticket = ++latest;
      set({ loading: true });
      try {
        const page = await listThreads({
          accountIds: query.accountIds,
          labelId: query.labelId,
          ...readArgs(query),
          ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
          before: next,
        });
        if (ticket !== latest) return;
        set((s) => {
          const have = new Set(s.threads.map(keyOf));
          const fresh = overlay(
            (page?.threads ?? []).filter((t) => !have.has(keyOf(t))),
            query,
          );
          return {
            threads: [...s.threads, ...fresh],
            next: page?.next ?? null,
            loading: false,
            error: null,
          };
        });
      } catch (error) {
        if (ticket !== latest) return;
        set({ loading: false, error: toCommandError(error) });
      }
    },
    reload: async (preserveRead = false) => {
      const { query, threads } = get();
      if (query?.search) await localSearch(latest, query, reloadDepth(threads.length));
      else if (query) await get().load(query, reloadDepth(threads.length), preserveRead);
    },
    retryGmail: () => remotePages(true),
    patch: (keys, fn, op) => {
      if (op !== undefined) register(keys, { op, fn, query: null });
      const wanted = new Set(keys);
      let newlyKept = false;
      set((s) => ({
        threads: s.threads.map((t) => {
          if (!wanted.has(keyOf(t))) return t;
          const updated = fn(t);
          if (
            s.query?.unreadOnly &&
            sameQuery(s.query, s.loadedQuery) &&
            t.unread &&
            !updated.unread
          ) {
            keptRead.add(keyOf(t));
            newlyKept = true;
          }
          return updated;
        }),
      }));
      // Replace a request issued before the read, which cannot yet include this row.
      if (newlyKept && get().loading) void get().reload(true);
    },
    remove: (keys, op) => {
      // The rows being removed are in the list on screen, which is the loaded query (else the one asked for).
      if (op !== undefined)
        register(keys, { op, fn: null, query: get().loadedQuery ?? get().query });
      keys.forEach((key) => keptRead.delete(key));
      const gone = new Set(keys);
      set((s) => ({ threads: s.threads.filter((t) => !gone.has(keyOf(t))) }));
    },
    settle: (op, keys, rejected = false) => {
      const only = keys ? new Set(keys) : null;
      const next = new Map<ThreadKey, PendingChange[]>();
      for (const [key, changes] of pending) {
        if (!rejected && (!only || only.has(key))) {
          for (const change of changes.filter((c) => c.op === op)) {
            if (change.fn) {
              const row = remoteRows.get(key);
              if (row) remoteRows.set(key, change.fn(row));
            } else if (sameQuery(change.query, get().query)) {
              // IPC success only queues the write. Keep the snapshot until sync can confirm
              // Trash or restore it after Gmail rejects the outbox operation.
              if (get().query?.search) removedFromSearch.add(key);
            }
          }
        }
        const rest = only && !only.has(key) ? changes : changes.filter((c) => c.op !== op);
        if (rest.length > 0) next.set(key, rest);
      }
      pending = next;
    },
    clear: () => {
      latest++;
      keptRead.clear();
      remoteRows.clear();
      removedFromSearch.clear();
      set({ ...EMPTY, query: null });
    },
    subscribe: (signal) => {
      const reload = () => void get().reload(true);
      return subscribeAll(
        [
          () =>
            listen<SyncMessagesUpdated>(SYNC_EVENTS.messagesUpdated, ({ payload }) => {
              if (get().search && payload.removed.length) {
                const gone = new Set(payload.removed.map((id) => threadKey(payload.accountId, id)));
                for (const key of gone) {
                  remoteRows.delete(key);
                  removedFromSearch.add(key);
                }
                set((s) => ({ threads: s.threads.filter((t) => !gone.has(keyOf(t))) }));
              }
              reload();
              // Gmail-only matches aren't in an FTS result. Refresh their flags from the cache on sync,
              // including an outbox rollback, while leaving their result positions alone.
              const ticket = latest;
              for (const id of payload.modified) {
                const key = threadKey(payload.accountId, id);
                if (!remoteRows.has(key)) continue;
                const version = (remoteUpdates.get(key) ?? 0) + 1;
                remoteUpdates.set(key, version);
                void getThread(payload.accountId, id)
                  .then((detail) => {
                    if (
                      ticket !== latest ||
                      remoteUpdates.get(key) !== version ||
                      !remoteRows.has(key)
                    )
                      return;
                    const hidden = removedFromSearch.has(key);
                    if (hidden && detail.messages.every((m) => m.labelIds.includes("TRASH")))
                      return;
                    if (hidden) removedFromSearch.delete(key);
                    remoteRows.set(key, detail.thread);
                    const query = get().query;
                    if (query)
                      set((s) => ({
                        threads: overlay(
                          hidden
                            ? appendUnique(s.threads, [detail.thread])
                            : s.threads.map((row) => (keyOf(row) === key ? detail.thread : row)),
                          query,
                        ),
                      }));
                  })
                  .catch(() => {
                    /* Keep the usable snapshot if the cache cannot be read yet. */
                  });
              }
            }),
          () => listen(SYNC_EVENTS.completed, reload),
        ],
        signal,
      );
    },
  };
});

/** Test helper. */
export function __resetMailStoreForTests() {
  latest++;
  pending = new Map();
  keptRead.clear();
  useMailStore.setState({ ...EMPTY, query: null });
}
