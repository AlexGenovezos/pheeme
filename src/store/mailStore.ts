// Mail state: the thread list for the active mailbox, kept fresh by sync events.
import { coalesce, type Coalesced } from "../lib/coalesce";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import { parseThreadKey, type ThreadKey, threadKey } from "../mail/mailboxes";
import {
  listen,
  type CommandError,
  listThreads,
  getThread,
  searchMessages,
  searchGmail,
  SYNC_EVENTS,
  type ThreadCursor,
  type ThreadQuery,
  type ThreadSummary,
  toCommandError,
} from "../lib/tauri";
import { PendingChanges } from "./pendingChanges";
import { useUiStore } from "./uiStore";

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
  /** Which call `error` came from, so Try again repeats that one: a failed page retries the page, anything else reloads. */
  errorSource: "load" | "more";
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
// The store's coalesced `reload` (made with the store), so tests can reset it.
let reloadOnce: Coalesced<[boolean]> | null = null;

const PAGE = 50;
const MAX_RELOAD = 500;
/** A reload re-queries what is loaded, within one page and the backend's page cap. */
const reloadDepth = (loaded: number) => Math.min(Math.max(loaded, PAGE), MAX_RELOAD);
const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/** The backend's list order (newest first, then account and thread id, descending): `t` comes after `cursor`. */
export const sortsAfter = (t: ThreadSummary, c: ThreadCursor) =>
  t.date !== c.lastMessageDate
    ? t.date < c.lastMessageDate
    : t.accountId !== c.accountId
      ? t.accountId < c.accountId
      : t.id < c.threadId;

/**
 * A reload re-reads at most `MAX_RELOAD` rows, so it stops at `cursor` in a list scrolled deeper than that. The
 * rows already loaded below that point stay (as last read) rather than snapping the list back to its first rows and
 * losing the open one; `fresh` wins for any row it has, and a row that sorts above `cursor` but isn't in `fresh` is
 * gone. Paging then continues from the old cursor, below all of them.
 */
function keptBelow(
  previous: ThreadSummary[],
  fresh: ThreadSummary[],
  cursor: ThreadCursor | null,
): ThreadSummary[] {
  if (!cursor || previous.length === 0) return [];
  const have = new Set(fresh.map(keyOf));
  return previous.filter((t) => !have.has(keyOf(t)) && sortsAfter(t, cursor));
}

/** A change not yet in the cache. `fn: null` removes the row, from results of `query` only (`null`: of any query). */
interface PendingChange {
  fn: ((thread: ThreadSummary) => ThreadSummary) | null;
  query: MailQuery | null;
}
const pending = new PendingChanges<ThreadKey, PendingChange>();
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

/** Query results for `query` with the pending changes laid over them. */
function overlay(threads: ThreadSummary[], query: MailQuery): ThreadSummary[] {
  if (pending.isEmpty) return threads;
  const out: ThreadSummary[] = [];
  for (const thread of threads) {
    // Once removed, a row stays removed: the changes after the removal don't bring it back.
    const row = pending.apply<ThreadSummary | null>(keyOf(thread), thread, (row, change) =>
      row === null
        ? null
        : change.fn
          ? change.fn(row)
          : change.query !== null && !sameQuery(change.query, query)
            ? row
            : null,
    );
    if (row) out.push(row);
  }
  return out;
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Every field of the two summaries is the same. */
const sameSummary = (a: ThreadSummary, b: ThreadSummary) =>
  a.id === b.id &&
  a.accountId === b.accountId &&
  a.subject === b.subject &&
  a.snippet === b.snippet &&
  a.fromName === b.fromName &&
  a.fromAddress === b.fromAddress &&
  a.date === b.date &&
  a.unread === b.unread &&
  a.starred === b.starred &&
  a.hasAttachment === b.hasAttachment &&
  a.messageCount === b.messageCount &&
  sameIds(a.labelIds, b.labelIds) &&
  sameIds(a.systemLabelIds, b.systemLabelIds);

/**
 * `fresh` with each row that hasn't changed replaced by the object already in the list. Sync events reload the
 * list, and new objects for unchanged rows re-rendered every (memoized) row each time.
 */
export function reuseUnchanged(previous: ThreadSummary[], fresh: ThreadSummary[]): ThreadSummary[] {
  if (previous.length === 0) return fresh;
  const byKey = new Map(previous.map((t) => [keyOf(t), t]));
  const out = fresh.map((t) => {
    const old = byKey.get(keyOf(t));
    return old && sameSummary(old, t) ? old : t;
  });
  // The same rows in the same order: keep the array too, so nothing downstream sees a change.
  return out.length === previous.length && out.every((t, i) => t === previous[i]) ? previous : out;
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
  errorSource: "load" as const,
};

/** The unfiltered list as it was when Unread only went on, shown again at once when it goes off. */
let unfiltered: {
  query: MailQuery;
  threads: ThreadSummary[];
  next: ThreadCursor | null;
  /** Rows removed from the unread list since (archived, deleted, moved). */
  gone: Set<ThreadKey>;
} | null = null;

/**
 * The rows to show the moment Unread only is switched, before the query answers. Rows are paged by
 * keyset, so the unread rows of a list loaded down to cursor C are exactly the unread list down to C:
 * switching on shows them at once, and the query then adds the rest below. Switching off restores
 * the list from before, with the rows shown now in their current state, minus rows removed in the
 * meantime and not since restored (Undo). `null` when the mailbox changes or nothing is loaded.
 */
function instantRows(
  shown: ThreadSummary[],
  next: ThreadCursor | null,
  from: MailQuery | null,
  to: MailQuery,
): { threads: ThreadSummary[]; next: ThreadCursor | null } | null {
  if (!from || from.search || to.search || !sameQuery(from, { ...to, unreadOnly: from.unreadOnly }))
    return null;
  if (to.unreadOnly && !from.unreadOnly) {
    unfiltered = {
      query: from,
      threads: shown,
      next,
      gone: new Set(),
    };
    return { threads: shown.filter((t) => t.unread), next };
  }
  if (!to.unreadOnly && from.unreadOnly && unfiltered && sameQuery(unfiltered.query, to)) {
    const { gone } = unfiltered;
    const current = new Map(shown.map((t) => [keyOf(t), t]));
    return {
      threads: unfiltered.threads.flatMap(
        (t) => current.get(keyOf(t)) ?? (gone.has(keyOf(t)) ? [] : t),
      ),
      next: unfiltered.next,
    };
  }
  return null;
}

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
        // A reload capped below what is loaded keeps the local matches beyond its last row (see `keptBelow`).
        const below =
          more || !limit || !sameQuery(s.loadedQuery, query)
            ? []
            : keptBelow(
                s.threads.filter((t) => !removedFromSearch.has(keyOf(t))),
                combined,
                page.next,
              );
        const kept = new Set(below.map(keyOf));
        const stable = more
          ? combined
          : appendUnique(
              s.threads
                .filter((t) => byKey.has(keyOf(t)) || kept.has(keyOf(t)))
                .map((t) => byKey.get(keyOf(t)) ?? t),
              combined,
            );
        return {
          threads: stable,
          next: below.length ? s.next : page.next,
          loadedQuery: query,
          loading: false,
          error: null,
          search: s.search && { ...s.search, local: page.local },
        };
      });
    } catch (error) {
      if (ticket === latest && version === localVersion)
        set({
          ...(get().loadedQuery && !sameQuery(get().loadedQuery, query)
            ? { threads: [], next: null, loadedQuery: null }
            : {}),
          loading: false,
          error: toCommandError(error),
          errorSource: more ? "more" : "load",
        });
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

  // Sync events, outbox changes and reads each ask for a reload; one runs at a time, plus one after it.
  const reloader = coalesce(async (preserveRead: boolean) => {
    const { query, threads } = get();
    if (query?.search) await localSearch(latest, query, reloadDepth(threads.length));
    else if (query) await get().load(query, reloadDepth(threads.length), preserveRead);
  });
  reloadOnce = reloader;

  return {
    ...EMPTY,
    query: null,
    load: async (query, limit, preserveRead = false) => {
      if (!preserveRead || !sameQuery(get().query, query)) keptRead.clear();
      const ticket = ++latest;
      if (query.search) {
        const before = get();
        const keepRows =
          before.loadedQuery?.search &&
          sameQuery(before.loadedQuery, { ...query, search: before.loadedQuery.search });
        remoteRows = new Map();
        removedFromSearch = new Set();
        remoteUpdates.clear();
        set({
          ...EMPTY,
          // Keep the last search visible while typing, but never carry rows across account scopes.
          ...(keepRows ? { threads: before.threads, loadedQuery: before.loadedQuery } : {}),
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
      const before = get();
      // A failed query keeps rows only if they were already this query's, not the instant ones.
      const hadRows = sameQuery(before.loadedQuery, query);
      const instant = instantRows(before.threads, before.next, before.loadedQuery, query);
      if (!instant && !hadRows) unfiltered = null;
      set({
        query,
        loading: true,
        search: null,
        // Rows on screen already carry the pending changes.
        ...(instant ? { ...instant, loadedQuery: query } : {}),
      });
      try {
        const page = await listThreads({
          accountIds: query.accountIds,
          labelId: query.labelId,
          ...readArgs(query),
          ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
          ...(limit ? { limit } : {}),
        });
        if (ticket !== latest) return;
        set((s) => {
          const fresh = overlay(page?.threads ?? [], query);
          // A reload capped below what is loaded keeps the rows beyond its last one (see `keptBelow`).
          const below =
            limit && sameQuery(s.loadedQuery, query)
              ? keptBelow(s.threads, fresh, page?.next ?? null)
              : [];
          return {
            threads: reuseUnchanged(s.threads, below.length ? [...fresh, ...below] : fresh),
            next: below.length ? s.next : (page?.next ?? null),
            loadedQuery: query,
            loading: false,
            error: null,
          };
        });
      } catch (error) {
        if (ticket !== latest) return;
        // The previous mailbox's rows and cursor mustn't masquerade as this one's; a failed reload of the same query keeps its rows.
        const stale = hadRows ? {} : { threads: [], next: null, loadedQuery: null };
        set({
          ...stale,
          loading: false,
          error: toCommandError(error),
          errorSource: "load",
        });
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
        set({ loading: false, error: toCommandError(error), errorSource: "more" });
      }
    },
    reload: (preserveRead = false) => reloader(preserveRead),
    retryGmail: () => remotePages(true),
    patch: (keys, fn, op) => {
      if (op !== undefined) pending.add(keys, op, { fn, query: null });
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
      // Replace a request issued before the read, which cannot yet include this row: its answer is dropped
      // (a reload already running would otherwise land first and drop the row), and the reload reads again.
      if (newlyKept && get().loading) {
        if (!get().query?.search) latest++;
        void get().reload(true);
      }
    },
    remove: (keys, op) => {
      // The rows being removed are in the list on screen, which is the loaded query (else the one asked for).
      if (op !== undefined)
        pending.add(keys, op, { fn: null, query: get().loadedQuery ?? get().query });
      keys.forEach((key) => {
        keptRead.delete(key);
        unfiltered?.gone.add(key);
      });
      const gone = new Set(keys);
      set((s) => ({ threads: s.threads.filter((t) => !gone.has(keyOf(t))) }));
    },
    settle: (op, keys, rejected = false) => {
      const released = pending.settle(op, keys);
      if (rejected) return;
      for (const [key, change] of released) {
        if (change.fn) {
          const row = remoteRows.get(key);
          if (row) remoteRows.set(key, change.fn(row));
        } else if (sameQuery(change.query, get().query)) {
          // IPC success only queues the write. Keep the snapshot until sync can confirm
          // Trash or restore it after Gmail rejects the outbox operation.
          if (get().query?.search) removedFromSearch.add(key);
        }
      }
    },
    clear: () => {
      latest++;
      keptRead.clear();
      unfiltered = null;
      remoteRows.clear();
      removedFromSearch.clear();
      set({ ...EMPTY, query: null });
    },
    subscribe: (signal) => {
      const reload = () => void get().reload(true);
      return subscribeAll(
        [
          () =>
            listen(SYNC_EVENTS.messagesUpdated, ({ payload }) => {
              if (payload.removed.length) {
                // Gone from the cache: drop them now, including rows kept below a capped reload (`keptBelow`).
                const gone = new Set(payload.removed.map((id) => threadKey(payload.accountId, id)));
                if (get().search)
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

/**
 * A checked conversation that is no longer in the list is unchecked, so "3 selected" counts what is there and the
 * actions don't keep aiming at a row that left (archived on another device, say). The rule is the same whether it
 * left the mailbox or just isn't loaded any more: a reload keeps every row it loaded (see `keptBelow`), so for the
 * query on screen only rows that left drop out. Switching mailbox, search or Unread only clears the selection anyway.
 */
useMailStore.subscribe((s, prev) => {
  if (s.threads === prev.threads || s.loadedQuery === null) return;
  const { checked, uncheck } = useUiStore.getState();
  if (checked.length === 0) return;
  const shown = new Set(s.threads.map(keyOf));
  const gone = checked.filter((key) => !shown.has(key));
  if (gone.length) uncheck(gone);
});

/** Test helper. */
export function __resetMailStoreForTests() {
  latest++;
  reloadOnce?.reset();
  pending.clear();
  keptRead.clear();
  unfiltered = null;
  useMailStore.setState({ ...EMPTY, query: null });
}
