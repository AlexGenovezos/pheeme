import { UserPlus } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { syncLine } from "../calendar/AccessControls";
import { useCalendarStore } from "../calendar/calendarStore";
import {
  type AccountInfo,
  type CommandError,
  type QuotaUsage,
  type SyncProgress,
  toCommandError,
} from "../lib/tauri";
import { isSignedOut, ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { SendCredentials } from "../transfer/SendCredentials";
import { SettingsRow, SettingsSection } from "./rows";
import { matchesQuery } from "./schema";
import { MailSyncProgress, useSyncProgress } from "./MailSyncProgress";
import { type ClientGroup, clientLabel, groupByClient } from "./clientGroups";
import { QuotaUsageChart, summarizeQuota, useQuotaUsages } from "./QuotaUsage";

/** How the Accounts page starts adding an account (onboarding lives outside the dialog). */
export const AddAccountContext = createContext<(() => void) | undefined>(undefined);

export const accountsMatch = (query: string) =>
  useAccountStore
    .getState()
    .accounts.some((a) => matchesQuery(`${a.displayName ?? ""} ${a.email}`, query));

/** How the account's calendar sync is going, beside its mail sync (always one line, so nothing shifts). */
function CalendarSyncLine({ accountId }: { accountId: string }) {
  const calendar = useCalendarStore((s) => s.accounts?.find((a) => a.accountId === accountId));
  return (
    <div className="settings-sync">
      <span className="settings-sync__detail">
        Calendar:{" "}
        {calendar ? (
          syncLine(calendar)
        ) : (
          <Skeleton className="settings-sync__pending" width="16ch" />
        )}
      </span>
    </div>
  );
}

export function AccountsSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  useEffect(() => {
    void useCalendarStore.getState().loadAccounts();
  }, []);
  const onAdd = useContext(AddAccountContext);
  const { progress, unavailable } = useSyncProgress();
  return (
    <>
      <SettingsSection
        title="Connected accounts"
        card={false}
        action={
          onAdd && (
            <Button size="sm" icon={<UserPlus />} onClick={onAdd}>
              Add account
            </Button>
          )
        }
      >
        <div className="settings-client-groups">
          {groupByClient(accounts).map((group) => (
            <ClientGroupCard
              key={group.clientId}
              group={group}
              showClient={accounts.length > 1}
              progress={progress}
              progressUnavailable={unavailable}
            />
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title="Other devices">
        <SendCredentials accounts={accounts} />
      </SettingsSection>
    </>
  );
}

/**
 * One card per Google Cloud OAuth client, so accounts that sign in through the same one sit
 * together. With more than one account the card opens with the client and, when it's shared, the
 * quota its accounts used together; each account still has its own chart, since Gmail's limit is
 * per account, not per client.
 */
function ClientGroupCard({
  group,
  showClient,
  progress,
  progressUnavailable,
}: {
  group: ClientGroup;
  showClient: boolean;
  progress: SyncProgress[] | null;
  progressUnavailable: boolean;
}) {
  const usages = useQuotaUsages(group.accounts.map((a) => a.id));
  return (
    <div className="settings-card">
      {showClient && <ClientRow group={group} usages={usages} />}
      {group.accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          progress={progress?.find((p) => p.accountId === account.id)}
          progressUnavailable={progressUnavailable}
          usage={usages[account.id] ?? null}
        />
      ))}
    </div>
  );
}

function ClientRow({ group, usages }: { group: ClientGroup; usages: Record<string, QuotaUsage> }) {
  const { accounts } = group;
  const shared = accounts.length > 1;
  const loaded = accounts.every((a) => usages[a.id]);
  const together = loaded
    ? accounts.reduce((sum, a) => sum + summarizeQuota(usages[a.id]!).total, 0)
    : null;
  return (
    <SettingsRow
      className="settings-client"
      title="Google Cloud app"
      description={
        <>
          <span>{clientLabel(group.clientId)}</span>
          {shared ? (
            <span>
              Shared by {accounts.length} accounts, which used{" "}
              {together === null ? (
                <Skeleton className="settings-client__pending" width="6ch" />
              ) : (
                together.toLocaleString()
              )}{" "}
              Gmail quota units together in the last hour. Each account has its own limit, so they
              don&apos;t slow each other down.
            </span>
          ) : (
            <span>Only {accounts[0]!.email} signs in through it.</span>
          )}
        </>
      }
    />
  );
}

function AccountRow({
  account,
  progress,
  progressUnavailable,
  usage,
}: {
  account: AccountInfo;
  progress?: SyncProgress;
  progressUnavailable: boolean;
  usage: QuotaUsage | null;
}) {
  const remove = useAccountStore((s) => s.remove);
  const syncError = useAccountStore((s) => s.syncErrors[account.id]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);

  async function confirmRemove() {
    setBusy(true);
    setError(null);
    try {
      await remove(account.id);
    } catch (raw) {
      setError(toCommandError(raw));
      setBusy(false);
    }
  }

  return (
    <div className="settings-account">
      <SettingsRow
        title={
          <span className="settings-account__name">
            <Avatar name={account.displayName ?? account.email} email={account.email} size="sm" />
            {account.displayName ?? account.email}
          </span>
        }
        description={
          <>
            {account.displayName && <span>{account.email}</span>}
            {syncError && (
              <span className="settings-account__error">Sync failed: {syncError.message}</span>
            )}
          </>
        }
        control={
          !confirming && (
            <div className="settings-account__buttons">
              {isSignedOut(syncError) && <ReconnectButton accountId={account.id} />}
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            </div>
          )
        }
      />
      <MailSyncProgress
        email={account.email}
        progress={progress}
        unavailable={progressUnavailable}
      />
      <CalendarSyncLine accountId={account.id} />
      <QuotaUsageChart email={account.email} usage={usage} />
      {confirming && (
        <div className="settings-account__confirm">
          <span>
            Remove {account.email} from Pheeme? This signs it out and deletes its cached mail.
            Nothing changes in Gmail.
          </span>
          <div className="settings-account__buttons">
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="settings-account__error settings-account__failure" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
}
