// The mailbox download (an account's first sync and the backfill after it), for the card in the
// bottom-right corner and the sidebar's slow-sync note. Progress is asked every 2 s while an account
// is downloading; otherwise only when a sync starts, which is how a new account or a resync begins.
import { create } from "zustand";
import { getSyncProgress, listen, SYNC_EVENTS, type SyncProgress } from "../lib/tauri";

/** How often progress is asked while a download runs. */
export const DOWNLOAD_POLL_MS = 2000;
/** How long "Mailbox downloaded" stays after the last download finishes. */
export const DOWNLOAD_DONE_MS = 5000;

export interface DownloadSummary {
  /** Accounts still downloading, in the order Rust answered. */
  accountIds: string[];
  synced: number;
  /** `null` while Gmail's mailbox size isn't known yet for one of them. */
  total: number | null;
  /** 0–99 (only the backfill's last page makes it complete); `null` without a total. */
  percent: number | null;
}

/** What is still downloading, combined across accounts; `null` when nothing is. */
export function summarizeDownload(progress: SyncProgress[]): DownloadSummary | null {
  const downloading = progress.filter((p) => !p.complete);
  if (downloading.length === 0) return null;
  const synced = downloading.reduce((sum, p) => sum + p.syncedMessages, 0);
  const total = downloading.every((p) => p.totalMessages !== null)
    ? downloading.reduce((sum, p) => sum + p.totalMessages!, 0)
    : null;
  return {
    accountIds: downloading.map((p) => p.accountId),
    synced,
    total,
    percent: total ? Math.min(99, Math.floor((synced / total) * 100)) : null,
  };
}

interface DownloadState {
  /** The last answer; `null` until the first. */
  progress: SyncProgress[] | null;
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
  const downloading = next
    ? summarizeDownload(next) !== null
    : summarizeDownload(useDownloadStore.getState().progress ?? []) !== null;
  if (askAgain) void refresh();
  else if (downloading || !next) pollTimer = setTimeout(() => void refresh(), DOWNLOAD_POLL_MS);
}

function record(next: SyncProgress[]) {
  const { progress: before, dismissed } = useDownloadStore.getState();
  const was = before ? summarizeDownload(before) : null;
  const now = summarizeDownload(next);
  if (was && !now) {
    // Only an open card says it's done; one that was closed stays closed.
    const open = was.accountIds.some((id) => !dismissed.includes(id));
    const total = next
      .filter((p) => was.accountIds.includes(p.accountId))
      .reduce((sum, p) => sum + p.syncedMessages, 0);
    clearTimeout(doneTimer);
    if (open) {
      doneTimer = setTimeout(() => useDownloadStore.setState({ finished: null }), DOWNLOAD_DONE_MS);
    }
    useDownloadStore.setState({ progress: next, finished: open ? { total } : null });
    return;
  }
  if (now) {
    clearTimeout(doneTimer);
    useDownloadStore.setState({ progress: next, finished: null });
    return;
  }
  useDownloadStore.setState({ progress: next });
}

export const useDownloadStore = create<DownloadState>((set) => ({
  progress: null,
  dismissed: [],
  finished: null,
  dismiss: () => {
    clearTimeout(doneTimer);
    set((s) => ({
      dismissed: [
        ...new Set([...s.dismissed, ...(summarizeDownload(s.progress ?? [])?.accountIds ?? [])]),
      ],
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
  useDownloadStore.setState({ progress: null, dismissed: [], finished: null });
}
