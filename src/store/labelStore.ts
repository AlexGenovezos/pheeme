// Labels and the counts the sidebar shows, all read from the local cache and refreshed on sync events.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import { type LabelInfo, labelCounts, listLabels, mailboxCounts, SYNC_EVENTS } from "../lib/tauri";

export interface LabelCountEntry {
  unread: number;
  total: number;
}

export interface UnreadCountChange {
  accountId: string;
  delta: number;
  labelIds: string[];
  categoryIds: string[];
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
  /** Update known mailbox counts with the rows, holding cache refreshes until all read commands settle. */
  patchUnread(op: number, changes: UnreadCountChange[]): void;
  settleUnread(op: number): void;
  /**
   * Shows a change to an account's labels before Gmail confirms it: `apply` runs now, and the fields it changed are
   * set again over every reload until `settleLabels`. Returns the change's id.
   */
  patchLabels(accountId: string, apply: (labels: LabelInfo[]) => LabelInfo[]): number;
  /** Ends a `patchLabels` change: with the labels Gmail returned, or null when it refused (the change is undone). */
  settleLabels(change: number, changed: LabelInfo[] | null): void;
  /** Reload on label and message sync events. Resolves to the unsubscribe function. */
  subscribe(signal?: AbortSignal): Promise<() => void>;
  /** An account's own labels, sorted by name. The array is stable until the labels change. */
  userLabels(accountId: string): LabelInfo[];
  /** An account's labels by id, for rows that look labels up. The map is stable until the labels change. */
  labelsById(accountId: string): ReadonlyMap<string, LabelInfo>;
  /** The label's display name, or its id when unknown. */
  labelName(accountId: string, labelId: string): string;
}

// Each load takes a ticket; only the latest may write its result.
let latest = 0;
// The accounts of the last `load`, which sync events refresh.
let knownIds: string[] = [];
let refreshing = false;
let refreshAgain = false;
const pendingReads = new Set<number>();

interface PendingLabelChange {
  accountId: string;
  /** The labels it changed, as they were before it. */
  before: Map<string, LabelInfo>;
  /** Per label, the fields it changed, as it set them: set again over reloads until Gmail answers. */
  after: Map<string, Partial<LabelInfo>>;
}
/** Label changes waiting for Gmail, oldest first. */
const pendingLabels = new Map<number, PendingLabelChange>();
let nextLabelChange = 0;

/** `labels` with every change still waiting for Gmail applied, in order. */
function withPending(accountId: string, labels: LabelInfo[]): LabelInfo[] {
  let out = labels;
  for (const change of pendingLabels.values())
    if (change.accountId === accountId) out = patchById(out, change.after);
  return out;
}

/** `labels` with `patches` (per id, fields to set) applied. */
function patchById(labels: LabelInfo[], patches: ReadonlyMap<string, Partial<LabelInfo>>) {
  return labels.map((l) => (patches.has(l.id) ? { ...l, ...patches.get(l.id) } : l));
}

/** `labels` with `change` undone, except fields a later change has set since. */
function undo(labels: LabelInfo[], { before, after }: PendingLabelChange): LabelInfo[] {
  return labels.map((l) => {
    const set = after.get(l.id);
    const old = before.get(l.id);
    if (!set || !old) return l;
    const back: Record<string, unknown> = {};
    for (const key of Object.keys(set) as (keyof LabelInfo)[])
      if (l[key] === set[key]) back[key] = old[key];
    return { ...l, ...back };
  });
}

const NO_LABELS: LabelInfo[] = [];
const sortedUserLabels = new WeakMap<LabelInfo[], LabelInfo[]>();
const labelMaps = new WeakMap<LabelInfo[], Map<string, LabelInfo>>();
const NO_LABEL_MAP: ReadonlyMap<string, LabelInfo> = new Map();

const byName = (a: LabelInfo, b: LabelInfo) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

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
      counts: Object.fromEntries(
        (counts ?? []).map((c) => [c.labelId, { unread: c.unread, total: c.total }]),
      ),
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
    // A count query can include some pending writes and miss others. Keep the optimistic
    // counts until all writes finish, then query once without risking a double decrement.
    if (pendingReads.size > 0) return;
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
          labels[id] = withPending(id, data.labels);
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
  patchUnread: (op, changes) => {
    if (changes.length === 0) return;
    pendingReads.add(op);
    ++latest; // A refresh started before this read mustn't put the old counts back.
    set((s) => {
      const counts = { ...s.counts };
      const categoryCounts = { ...s.categoryCounts };
      let allInboxUnread = s.allInboxUnread;
      for (const { accountId, delta, labelIds, categoryIds } of changes) {
        const labels = { ...counts[accountId] };
        for (const id of new Set(labelIds)) {
          const entry = labels[id];
          if (entry) labels[id] = { ...entry, unread: Math.max(0, entry.unread + delta) };
        }
        counts[accountId] = labels;
        const categories = { ...categoryCounts[accountId] };
        for (const id of new Set(categoryIds))
          categories[id] = Math.max(0, (categories[id] ?? 0) + delta);
        categoryCounts[accountId] = categories;
        if (categoryIds.includes("INBOX")) allInboxUnread = Math.max(0, allInboxUnread + delta);
      }
      return { counts, categoryCounts, allInboxUnread };
    });
  },
  settleUnread: (op) => {
    if (!pendingReads.delete(op) || pendingReads.size > 0) return;
    // Success, failure and cancelled automatic reads all reconcile against the cache.
    void get().load(knownIds);
  },
  patchLabels: (accountId, apply) => {
    const id = ++nextLabelChange;
    set((s) => {
      const current = s.labels[accountId] ?? NO_LABELS;
      const next = apply(current);
      const was = new Map(current.map((l) => [l.id, l]));
      const before = new Map<string, LabelInfo>();
      const after = new Map<string, Partial<LabelInfo>>();
      for (const l of next) {
        const old = was.get(l.id);
        if (!old || old === l) continue;
        const fields: Record<string, unknown> = {};
        for (const key of Object.keys(l) as (keyof LabelInfo)[])
          if (l[key] !== old[key]) fields[key] = l[key];
        before.set(l.id, old);
        after.set(l.id, fields);
      }
      pendingLabels.set(id, { accountId, before, after });
      return { labels: { ...s.labels, [accountId]: next } };
    });
    return id;
  },
  settleLabels: (change, changed) => {
    const done = pendingLabels.get(change);
    if (!done) return;
    pendingLabels.delete(change);
    const { accountId } = done;
    // Gmail took it: an older change still waiting no longer owns the fields this one set.
    if (changed)
      for (const [older, waiting] of pendingLabels)
        if (older < change && waiting.accountId === accountId)
          for (const [labelId, fields] of done.after)
            for (const key of Object.keys(fields))
              delete waiting.after.get(labelId)?.[key as keyof LabelInfo];
    set((s) => {
      const current = s.labels[accountId] ?? NO_LABELS;
      // Gmail's copy (or, refused, the labels as they were), then later changes still waiting on top.
      const base = changed
        ? patchById(current, new Map(changed.map((l) => [l.id, l])))
        : undo(current, done);
      return { labels: { ...s.labels, [accountId]: withPending(accountId, base) } };
    });
    // A refusal can come after Gmail took part of it (a rename stopped half-way): read back what it holds.
    if (!changed && knownIds.length > 0) void get().load(knownIds);
  },
  subscribe: (signal) => {
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
    return subscribeAll(
      [SYNC_EVENTS.labelsUpdated, SYNC_EVENTS.messagesUpdated, SYNC_EVENTS.completed].map(
        (event) => () => listen(event, () => void refresh()),
      ),
      signal,
    );
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
  labelsById: (accountId) => {
    const labels = get().labels[accountId];
    if (!labels) return NO_LABEL_MAP;
    let map = labelMaps.get(labels);
    if (!map) {
      map = new Map(labels.map((l) => [l.id, l]));
      labelMaps.set(labels, map);
    }
    return map;
  },
  labelName: (accountId, labelId) =>
    get().labels[accountId]?.find((l) => l.id === labelId)?.name ?? labelId,
}));

/** Test helper. */
export function __resetLabelStoreForTests() {
  latest++;
  knownIds = [];
  refreshing = false;
  refreshAgain = false;
  pendingReads.clear();
  pendingLabels.clear();
  useLabelStore.setState({ labels: {}, counts: {}, categoryCounts: {}, allInboxUnread: 0 });
}
