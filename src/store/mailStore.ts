// Mail state: the thread list for the active mailbox, kept fresh by sync events.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
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
  /** Load the first page for `query`, replacing the list. */
  load(query: ThreadQuery): Promise<void>;
  /** Re-run the current query (after a sync). */
  reload(): Promise<void>;
  /** Clear the list without querying (mailboxes with no backing label yet). */
  clear(): void;
  /** Reload on sync events. Resolves to the unsubscribe function. */
  subscribe(): Promise<() => void>;
}

// Each load takes a ticket; only the latest ticket may write its result.
let latest = 0;

const EMPTY = { threads: [], next: null, loading: false, error: null };

export const useMailStore = create<MailState>((set, get) => ({
  ...EMPTY,
  query: null,
  load: async (query) => {
    const ticket = ++latest;
    set({ query, loading: true });
    try {
      const page = await listThreads({
        accountIds: query.accountIds,
        labelId: query.labelId,
        ...(query.alsoLabelId ? { alsoLabelId: query.alsoLabelId } : {}),
      });
      if (ticket !== latest) return;
      set({ threads: page?.threads ?? [], next: page?.next ?? null, loading: false, error: null });
    } catch (error) {
      if (ticket !== latest) return;
      set({ loading: false, error: toCommandError(error) });
    }
  },
  reload: async () => {
    const { query } = get();
    if (query) await get().load(query);
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
