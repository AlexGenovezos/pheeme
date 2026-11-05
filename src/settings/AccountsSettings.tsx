import { UserPlus } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { type AccountInfo, type CommandError, toCommandError } from "../lib/tauri";
import { isSignedOut, ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { SendCredentials } from "../transfer/SendCredentials";
import { SettingsRow, SettingsSection } from "./rows";
import { matchesQuery } from "./schema";

/** How the Accounts page starts adding an account (onboarding lives outside the dialog). */
export const AddAccountContext = createContext<(() => void) | undefined>(undefined);

export const accountsMatch = (query: string) =>
  useAccountStore
    .getState()
    .accounts.some((a) => matchesQuery(`${a.displayName ?? ""} ${a.email}`, query));

export function AccountsSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const onAdd = useContext(AddAccountContext);
  return (
    <>
      <SettingsSection
        title="Connected accounts"
        action={
          onAdd && (
            <Button size="sm" icon={<UserPlus />} onClick={onAdd}>
              Add account
            </Button>
          )
        }
      >
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </SettingsSection>
      <SettingsSection title="Other devices">
        <SendCredentials accounts={accounts} />
      </SettingsSection>
    </>
  );
}

function AccountRow({ account }: { account: AccountInfo }) {
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
