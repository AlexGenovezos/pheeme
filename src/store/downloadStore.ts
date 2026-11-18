// The mailbox download (an account's first sync and the backfill after it), for the card in the
// bottom-right corner. Progress is asked every 2 s while an account
// is downloading; otherwise only when a sync starts, which is how a new account or a resync begins.
import { create } from "zustand";
import { getSyncProgress, listen, SYNC_EVENTS, type SyncProgress } from "../lib/tauri";

/** How often progress is asked while a download runs. */
export const DOWNLOAD_POLL_MS = 2000;
/** How long "Mailbox downloaded" stays after the last download finishes. */
export const DOWNLOAD_DONE_MS = 5000;

export interface DownloadSummary {
  /** Accounts in this download, in the order Rust answered: those still downloading, and those that
   * finished since it began (so the totals don't drop when one account finishes before another). */
  accountIds: string[];
  synced: number;
  /** `null` while Gmail's mailbox size isn't known yet for one of them. */
  total: number | null;
  /** 0–99 (only the backfill's last page makes it complete); `null` without a total. */
  percent: number | null;
}

/**
 * What is downloading, combined across `progress`' unfinished accounts and the `episode`'s finished
 * ones; `null` when nothing is unfinished.
 */
export function summarizeDownload(
  progress: SyncProgress[],
  episode: string[] = [],
): DownloadSummary | null {
  if (!progress.some((p) => !p.complete)) return null;
  const rows = progress.filter((p) => !p.complete || episode.includes(p.accountId));
  const synced = rows.reduce((sum, p) => sum + p.syncedMessages, 0);
  const total = rows.every((p) => p.totalMessages !== null)
    ? rows.reduce((sum, p) => sum + p.totalMessages!, 0)
    : null;
  return {
    accountIds: rows.map((p) => p.accountId),
    synced,
    total,
    percent: total ? Math.min(99, Math.floor((synced / total) * 100)) : null,
  };
}

/** The download the card shows, and whether the card is open (not closed for all of its accounts). */
export function currentDownload(s: Pick<DownloadState, "progress" | "episode" | "dismissed">) {
  const summary = s.progress ? summarizeDownload(s.progress, s.episode) : null;
  const open = summary?.accountIds.some((id) => !s.dismissed.includes(id)) ?? false;
  return { summary, open };
}

interface DownloadState {
  /** The last answer; `null` until the first. */
  progress: SyncProgress[] | null;
  /** Every account that has downloaded since the current download began; empty between downloads. */
  episode: string[];
  /** Accounts that were downloading when the card was closed; it stays closed until another starts. */
  dismissed: string[];
  /** Every download just finished while the card was open: it says so for a few seconds. */
  finished: { total: number } | null;
  dismiss: () => void;
  /** Ask now and follow sync events. Resolves to the stop function. */
  subscribe: (signal?: AbortSignal) => Promise<() => void>;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
let asking = false;
/** A sync started while asking: the answer may predate it, so ask once more. */
let askAgain = false;
/** Live subscriptions: polling runs while there is one (StrictMode overlaps two for a moment). */
let subscribers = 0;

async function refresh() {
  if (subscribers === 0) return;
  if (asking) {
    askAgain = true;
    return;
  }
  asking = true;
  askAgain = false;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  let next: SyncProgress[] | null = null;
  try {
    next = await getSyncProgress();
  } catch {
    // Keep the last answer; the next poll or sync asks again.
  } finally {
    asking = false;
  }
  if (subscribers === 0) return;
  if (next) record(next);
  // After a failed ask, the last answer decides: a sync starting asks again anyway.
  const downloading = summarizeDownload(useDownloadStore.getState().progress ?? []) !== null;
  if (askAgain) void refresh();
  else if (downloading) pollTimer = setTimeout(() => void refresh(), DOWNLOAD_POLL_MS);
}

function record(next: SyncProgress[]) {
  const state = useDownloadStore.getState();
  const was = currentDownload(state);
  const unfinished = next.filter((p) => !p.complete).map((p) => p.accountId);
  if (unfinished.length === 0) {
    if (!was.summary) {
      // Still nothing downloading (a "Mailbox downloaded" card keeps its few seconds).
      useDownloadStore.setState({ progress: next, episode: [] });
      return;
    }
    clearTimeout(doneTimer);
    // Only an open card says it's done; one that was closed stays closed.
    const ids = was.summary.accountIds;
    const total = next
      .filter((p) => ids.includes(p.accountId))
      .reduce((sum, p) => sum + p.syncedMessages, 0);
    if (was.open) {
      doneTimer = setTimeout(() => useDownloadStore.setState({ finished: null }), DOWNLOAD_DONE_MS);
    }
    useDownloadStore.setState({
      progress: next,
      episode: [],
      finished: was.open ? { total } : null,
    });
    return;
  }
  clearTimeout(doneTimer);
  // An account removed meanwhile leaves the download.
  const present = state.episode.filter((id) => next.some((p) => p.accountId === id));
  useDownloadStore.setState({
    progress: next,
    episode: [...new Set([...present, ...unfinished])],
    finished: null,
  });
}

export const useDownloadStore = create<DownloadState>((set) => ({
  progress: null,
  episode: [],
  dismissed: [],
  finished: null,
  dismiss: () => {
    clearTimeout(doneTimer);
    set((s) => ({
      dismissed: [...new Set([...s.dismissed, ...(currentDownload(s).summary?.accountIds ?? [])])],
      finished: null,
    }));
  },
  subscribe: async () => {
    subscribers++;
    let stop: () => void;
    try {
      stop = await listen(SYNC_EVENTS.started, () => {
        // While polling, the next poll picks it up.
        if (pollTimer === undefined) void refresh();
      });
    } catch (error) {
      subscribers--;
      throw error;
    }
    void refresh();
    let live = true;
    return () => {
      stop();
      if (!live) return;
      live = false;
      if (--subscribers > 0) return;
      clearTimeout(pollTimer);
      clearTimeout(doneTimer);
      pollTimer = undefined;
    };
  },
}));

export function __resetDownloadForTests() {
  subscribers = 0;
  asking = false;
  askAgain = false;
  clearTimeout(pollTimer);
  clearTimeout(doneTimer);
  pollTimer = undefined;
  useDownloadStore.setState({ progress: null, episode: [], dismissed: [], finished: null });
}
