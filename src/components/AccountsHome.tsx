import { useState } from "react";
import { type AccountInfo, type CommandError, toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import "../onboarding/onboarding.css";

/** Placeholder home until the mail UI lands: connected accounts, add and remove. */
export function AccountsHome({ onAdd }: { onAdd: () => void }) {
  const accounts = useAccountStore((state) => state.accounts);
  return (
    <div className="onboarding onboarding--single">
      <main className="onboarding-main">
        <div className="onboarding-content">
          <h1>Accounts</h1>
          <p className="guide-lead">Your inbox shows up here once mail sync lands in an upcoming update.</p>
          <ul className="choice-list" aria-label="Connected accounts">
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </ul>
          <div>
            <button type="button" className="btn btn--primary" onClick={onAdd}>
              Add account
            </button>
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
          <button type="button" className="btn btn--small btn--quiet" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
      {confirming && (
        <div className="account-row__confirm">
          <span>Remove {account.email} from Pheeme? This signs it out and deletes its cached mail. Nothing changes in Gmail.</span>
          <div className="button-row">
            <button type="button" className="btn btn--small" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button type="button" className="btn btn--small btn--danger" disabled={busy} onClick={() => void confirmRemove()}>
              Remove
            </button>
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
