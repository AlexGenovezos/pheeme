import { useEffect, useState } from "react";
import { getSyncProgress, type SyncProgress } from "../lib/tauri";

/** Poll only while Accounts settings is mounted; never overlap IPC requests. */
export function useSyncProgress() {
  const [progress, setProgress] = useState<SyncProgress[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let stopped = false;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    async function refresh() {
      try {
        const value = await getSyncProgress();
        if (!stopped) {
          setProgress(value);
          setUnavailable(false);
        }
      } catch {
        if (!stopped) setUnavailable(true);
      } finally {
        if (!stopped) timer.id = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer.id);
    };
  }, []);
  return { progress, unavailable };
}

export function MailSyncProgress({
  email,
  progress,
  unavailable,
}: {
  email: string;
  progress?: SyncProgress;
  unavailable: boolean;
}) {
  // Gmail's size is a snapshot: new mail may arrive during the backfill. Only
  // the final page can establish completion, even if every known id is cached.
  const percent = progress?.complete
    ? 100
    : progress?.totalMessages
      ? Math.min(99, Math.floor((progress.syncedMessages / progress.totalMessages) * 100))
      : undefined;
  const count = progress
    ? progress.totalMessages !== null
      ? `${progress.syncedMessages.toLocaleString()} of ${progress.totalMessages.toLocaleString()} messages synced`
      : `${progress.syncedMessages.toLocaleString()} messages synced · Counting mail…`
    : "Preparing mail sync…";
  return (
    <div className="settings-sync">
      <div className="settings-sync__heading">
        <span>{progress?.complete ? "Mailbox synced" : "Mail sync"}</span>
        {percent !== undefined && <span>{percent}%</span>}
      </div>
      <progress
        className="settings-sync__bar"
        aria-label={`Mail sync for ${email}`}
        aria-valuetext={unavailable ? "Sync progress unavailable" : count}
        max={100}
        value={percent}
      />
      <span className="settings-sync__detail">
        {unavailable ? "Sync progress unavailable. Retrying…" : count}
      </span>
      {progress && (
        <span className="settings-sync__detail">
          {progress.downloadedMessages.toLocaleString()} message bodies available offline. Bodies
          from the last 180 days download automatically; older bodies and attachments download when
          opened.
        </span>
      )}
    </div>
  );
}
