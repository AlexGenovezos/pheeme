import { useState } from "react";
import { Switch } from "../components/ui/Switch";
import { CATEGORIES } from "../mail/mailboxes";
import { toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useInboxTabs } from "../store/inboxTabsStore";
import { SettingsRow, SettingsSection } from "./rows";

const NONE: string[] = [];

export function InboxTabsSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const hidden = useInboxTabs((s) => s.hidden);
  const [error, setError] = useState<string | null>(null);

  async function change(accountId: string, label: string, hide: boolean) {
    setError(null);
    try {
      await useInboxTabs.getState().setHidden(accountId, label, hide);
    } catch (raw) {
      setError(toCommandError(raw).message);
    }
  }

  return (
    <>
      <p>
        Choose which tabs each inbox shows. Mail from a hidden tab shows in Primary, and alerts like
        Primary mail.
      </p>
      {accounts.length === 0 && <SettingsRow title="Connect an account to choose its tabs" />}
      {accounts.map((account) => (
        <SettingsSection key={account.id} title={account.email}>
          {CATEGORIES.map((tab, index) => (
            <SettingsRow
              key={tab.labelId}
              title={tab.name}
              control={
                <Switch
                  label={`${tab.name} for ${account.email}`}
                  checked={index === 0 || !(hidden[account.id] ?? NONE).includes(tab.labelId)}
                  disabled={index === 0}
                  onChange={(shown) => void change(account.id, tab.labelId, !shown)}
                />
              }
            />
          ))}
        </SettingsSection>
      ))}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
