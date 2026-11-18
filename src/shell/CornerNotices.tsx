// The cards pinned in the bottom-right corner, under the toasts: sync trouble first, then the
// mailbox download, then the update offer (nearest the corner). Each draws through `CornerCard`.
import { useState } from "react";
import { Gauge, TriangleAlert, WifiOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { MailboxDownloadNotice } from "../components/MailboxDownloadNotice";
import { UpdateBanner } from "../components/UpdateBanner";
import { CornerCard } from "../components/ui/CornerCard";
import { isSignedOut, ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { useDownloadStore } from "../store/downloadStore";

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
  // The download card speaks for a slowed account while it's open.
  const downloading = useDownloadStore(
    useShallow((s) => s.progress?.filter((p) => !p.complete).map((p) => p.accountId) ?? []),
  );
  const dismissedDownloads = useDownloadStore((s) => s.dismissed);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = (key: string) => () => setDismissed((d) => [...d, key]);

  const failures = accounts.flatMap((account) => {
    const error = syncErrors[account.id];
    if (!error) return [];
    if (isSignedOut(error)) {
      return [
        <CornerCard
          key={`signed-out:${account.id}`}
          tone="danger"
          icon={<TriangleAlert aria-hidden="true" />}
          title={`Google signed out ${account.email}`}
          description="Sign in again to keep syncing. Downloaded mail stays."
          action={<ReconnectButton accountId={account.id} className="ui-toast__button" />}
        />,
      ];
    }
    const key = `failed:${account.id}:${error.code}:${error.message}`;
    if (dismissed.includes(key)) return [];
    return [
      <CornerCard
        key={key}
        tone="danger"
        icon={<TriangleAlert aria-hidden="true" />}
        title={`Couldn't sync ${account.email}`}
        description={error.message}
        onDismiss={dismiss(key)}
      />,
    ];
  });

  const slowIds = Object.keys(slowSync).filter(
    (id) => !(downloading.includes(id) && !dismissedDownloads.includes(id)),
  );
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
