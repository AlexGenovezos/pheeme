// The cards pinned in the bottom-right corner, under the toasts: sync trouble first, then the
// mailbox download, then the update offer (nearest the corner). Each draws through `CornerCard`.
import { useState } from "react";
import { Gauge, TriangleAlert, WifiOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { MailboxDownloadNotice } from "../components/MailboxDownloadNotice";
import { UpdateBanner } from "../components/UpdateBanner";
import { CornerCard } from "../components/ui/CornerCard";
import { isSignedOut, ReconnectButton } from "../onboarding/Reconnect";
import { type SyncFailure, useAccountStore } from "../store/accountStore";
import { currentDownload, useDownloadStore } from "../store/downloadStore";

export function CornerNotices() {
  const hasAccounts = useAccountStore((s) => s.accounts.length > 0);
  return (
    <>
      {hasAccounts && <SyncNotices />}
      {hasAccounts && <MailboxDownloadNotice />}
      <UpdateBanner />
    </>
  );
}

/**
 * Offline, Gmail slowing sync, and each account's failed sync or sign-out. Closing one hides it until
 * it changes (another failure, a new slowdown); offline and a sign-out stay until they're over.
 */
function SyncNotices() {
  const { accounts, syncErrors, slowSync, offline } = useAccountStore(
    useShallow(({ accounts, syncErrors, slowSync, offline }) => ({
      accounts,
      syncErrors,
      slowSync,
      offline,
    })),
  );
  const downloading = useDownloadStore(
    useShallow((s) => s.progress?.filter((p) => !p.complete).map((p) => p.accountId) ?? []),
  );
  // The download card speaks for a slowed account while it's open.
  const covered = useDownloadStore(
    useShallow((s) => {
      const { summary, open } = currentDownload(s);
      // Only accounts still downloading: one that finished syncs like any other.
      const unfinished = s.progress?.filter((p) => !p.complete).map((p) => p.accountId) ?? [];
      return open ? summary!.accountIds.filter((id) => unfinished.includes(id)) : [];
    }),
  );
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = (key: string) => () => setDismissed((d) => [...d, key]);
  // A closed failure is forgotten once it's over, so the next one shows even if it reads the same.
  // (Adjusted while rendering, as React suggests for state that follows a prop.)
  const failuresNow = JSON.stringify(
    Object.entries(syncErrors).map(([id, e]) => failureKey(id, e)),
  );
  const [failuresSeen, setFailuresSeen] = useState(failuresNow);
  if (failuresSeen !== failuresNow) {
    setFailuresSeen(failuresNow);
    const now = JSON.parse(failuresNow) as string[];
    setDismissed((d) => d.filter((key) => !key.startsWith("failed:") || now.includes(key)));
  }

  const failures = accounts.flatMap((account) => {
    const error = syncErrors[account.id];
    if (!error) return [];
    if (isSignedOut(error)) {
      return [
        <CornerCard
          waits
          key={`signed-out:${account.id}`}
          tone="danger"
          icon={<TriangleAlert aria-hidden="true" />}
          title={`Google signed out ${account.email}`}
          description="Sign in again to keep syncing. Downloaded mail stays."
          action={<ReconnectButton accountId={account.id} className="ui-toast__button" />}
        />,
      ];
    }
    const key = failureKey(account.id, error);
    if (dismissed.includes(key)) return [];
    return [
      <CornerCard
        waits
        key={key}
        tone="danger"
        icon={<TriangleAlert aria-hidden="true" />}
        title={`Couldn't sync ${account.email}`}
        description={error.message}
        onDismiss={dismiss(key)}
      />,
    ];
  });

  const slowIds = Object.keys(slowSync).filter((id) => !covered.includes(id));
  let slow = null;
  if (!offline && slowIds.length > 0) {
    const key = `slow:${Math.min(...slowIds.map((id) => slowSync[id]!.since))}`;
    // A mailbox download sends bursts that trip Gmail's per-second limit, which the per-minute
    // usage can't see: while one runs, its own requests can't be told from another device's.
    const contended = slowIds.some((id) => !downloading.includes(id) && slowSync[id]!.contended);
    const inDownload = slowIds.some((id) => downloading.includes(id));
    if (!dismissed.includes(key)) {
      slow = (
        <CornerCard
          waits
          icon={<Gauge aria-hidden="true" />}
          title="Gmail is slowing sync"
          description={
            contended
              ? "Another device may be syncing this account. Pheeme carries on by itself."
              : inDownload
                ? "The mailbox download is going slower. Pheeme carries on by itself."
                : "Gmail limits how fast an account can sync. Pheeme carries on by itself."
          }
          onDismiss={dismiss(key)}
        />
      );
    }
  }

  return (
    <>
      {offline && (
        <CornerCard
          waits
          icon={<WifiOff aria-hidden="true" />}
          title="You're offline"
          description="Pheeme syncs again when the connection is back. Changes you make wait until then."
        />
      )}
      {failures}
      {slow}
    </>
  );
}

const failureKey = (accountId: string, error: SyncFailure) =>
  `failed:${accountId}:${error.code}:${error.message}`;
