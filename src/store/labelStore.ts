// Labels and the counts the sidebar shows, all read from the local cache and refreshed on sync events.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { type LabelInfo, labelCounts, listLabels, mailboxCounts, stopQuietly, SYNC_EVENTS } from "../lib/tauri";

export interface LabelCountEntry {
  unread: number;
  total: number;
}

interface LabelState {
  labels: Record<string, LabelInfo[]>;
  /** Per account, per label: conversations unread and in total (`label_counts`). */
  counts: Record<string, Record<string, LabelCountEntry>>;
  /** Per account: unread for INBOX and each category (`mailbox_counts`, so Primary excludes the other four). */
  categoryCounts: Record<string, Record<string, number>>;
  /** Unread inbox conversations across every account. */
  allInboxUnread: number;
  /** Fetch everything for `accountIds`; accounts not listed are dropped. */
  load(accountIds: string[]): Promise<void>;
  /** Reload on label and message sync events. Resolves to the unsubscribe function. */
  subscribe(): Promise<() => void>;
  /** An account's own labels, sorted by name. The array is stable until the labels change. */
  userLabels(accountId: string): LabelInfo[];
  /** The label's display name, or its id when unknown. */
  labelName(accountId: string, labelId: string): string;
}

// Each load takes a ticket; only the latest may write its result.
let latest = 0;
// The accounts of the last `load`, which sync events refresh.
let knownIds: string[] = [];
let refreshing = false;
let refreshAgain = false;

const NO_LABELS: LabelInfo[] = [];
const sortedUserLabels = new WeakMap<LabelInfo[], LabelInfo[]>();

const byName = (a: LabelInfo, b: LabelInfo) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

interface AccountData {
  labels: LabelInfo[];
  counts: Record<string, LabelCountEntry>;
  categories: Record<string, number>;
}

async function fetchAccount(accountId: string): Promise<AccountData | null> {
  try {
    const [labels, counts, categories] = await Promise.all([
      listLabels(accountId),
      labelCounts(accountId),
      mailboxCounts([accountId]),
    ]);
    return {
      labels: labels ?? [],
      counts: Object.fromEntries((counts ?? []).map((c) => [c.labelId, { unread: c.unread, total: c.total }])),
      categories: Object.fromEntries((categories ?? []).map((c) => [c.labelId, c.unread])),
    };
  } catch (error) {
    console.warn(`couldn't load labels for ${accountId}`, error);
    return null;
  }
}

async function fetchInboxUnread(accountIds: string[]): Promise<number | null> {
  if (accountIds.length === 0) return 0;
  try {
    const counts = await mailboxCounts(accountIds);
    return (counts ?? []).find((c) => c.labelId === "INBOX")?.unread ?? 0;
  } catch (error) {
    console.warn("couldn't load the All Inboxes count", error);
    return null;
  }
}

export const useLabelStore = create<LabelState>((set, get) => ({
  labels: {},
  counts: {},
  categoryCounts: {},
  allInboxUnread: 0,
  load: async (accountIds) => {
    const ticket = ++latest;
    knownIds = accountIds;
    const [accounts, inbox] = await Promise.all([
      Promise.all(accountIds.map(fetchAccount)),
      fetchInboxUnread(accountIds),
    ]);
    if (ticket !== latest) return;
    // A failed account keeps whatever it had before.
    set((s) => {
      const labels: LabelState["labels"] = {};
      const counts: LabelState["counts"] = {};
      const categoryCounts: LabelState["categoryCounts"] = {};
      accountIds.forEach((id, i) => {
        const data = accounts[i];
        if (data) {
          labels[id] = data.labels;
          counts[id] = data.counts;
          categoryCounts[id] = data.categories;
        } else {
          if (s.labels[id]) labels[id] = s.labels[id];
          if (s.counts[id]) counts[id] = s.counts[id];
          if (s.categoryCounts[id]) categoryCounts[id] = s.categoryCounts[id];
        }
      });
      return { labels, counts, categoryCounts, allInboxUnread: inbox ?? s.allInboxUnread };
    });
  },
  subscribe: async () => {
    // Sync bursts (initial sync, backfill) emit often; refresh once more at most while one is running.
    const refresh = async () => {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          await get().load(knownIds);
        } while (refreshAgain);
      } finally {
        refreshing = false;
      }
    };
    const stops = await Promise.all(
      [SYNC_EVENTS.labelsUpdated, SYNC_EVENTS.messagesUpdated, SYNC_EVENTS.completed].map((event) =>
        listen(event, () => void refresh()),
      ),
    );
    return () => stops.forEach(stopQuietly);
  },
  userLabels: (accountId) => {
    const labels = get().labels[accountId];
    if (!labels) return NO_LABELS;
    let sorted = sortedUserLabels.get(labels);
    if (!sorted) {
      sorted = labels.filter((l) => l.type === "user").sort(byName);
      sortedUserLabels.set(labels, sorted);
    }
    return sorted;
  },
  labelName: (accountId, labelId) => get().labels[accountId]?.find((l) => l.id === labelId)?.name ?? labelId,
}));

/** Test helper. */
export function __resetLabelStoreForTests() {
  latest++;
  knownIds = [];
  refreshing = false;
  refreshAgain = false;
  useLabelStore.setState({ labels: {}, counts: {}, categoryCounts: {}, allInboxUnread: 0 });
}
