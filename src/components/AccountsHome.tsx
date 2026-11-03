import { useState } from "react";
import { Button } from "./ui/Button";
import { type AccountInfo, type CommandError, toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import "../onboarding/onboarding.css";

/** Connected accounts, with add and remove actions shared with onboarding. */
export function AccountsHome({ onAdd, onClose }: { onAdd: () => void; onClose?: () => void }) {
  const accounts = useAccountStore((state) => state.accounts);
  return (
    <div className="onboarding onboarding--single">
      <main className="onboarding-main">
        <div className="onboarding-content">
          {onClose && (
            <Button variant="ghost" size="lg" onClick={onClose}>
              Back to inbox
            </Button>
          )}
          <h1>Accounts</h1>
          <p className="guide-lead">Manage the Google accounts connected to Pheeme.</p>
          <ul className="choice-list" aria-label="Connected accounts">
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </ul>
          <div>
            <Button variant="primary" size="lg" onClick={onAdd}>
              Add account
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function AccountRow({ account }: { account: AccountInfo }) {
  const remove = useAccountStore((state) => state.remove);
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
    <li className="choice account-row">
      <div className="account-row__main">
        <div className="account-row__text">
          <strong>{account.displayName ?? account.email}</strong>
          {account.displayName && <span>{account.email}</span>}
        </div>
        {!confirming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>
      {confirming && (
        <div className="account-row__confirm">
          <span>
            Remove {account.email} from Pheeme? This signs it out and deletes its cached mail.
            Nothing changes in Gmail.
          </span>
          <div className="button-row">
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
        <small className="field__error" role="alert">
          {error.message}
        </small>
      )}
    </li>
  );
}
