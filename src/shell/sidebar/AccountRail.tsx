import { Mails } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { initialsFor } from "../../components/ui/Avatar";
import type { AccountInfo } from "../../lib/tauri";
import { accountColorIndex, ALL_INBOXES, formatCount } from "../../mail/mailboxes";
import { useAccountStore } from "../../store/accountStore";
import { visibleCategories } from "../../store/inboxTabsStore";
import { useLabelStore } from "../../store/labelStore";
import { useUiStore } from "../../store/uiStore";
import { mailboxInAccount } from "./rail";

function RailButton({
  label,
  colorToken,
  current,
  unread,
  warning,
  onClick,
  children,
}: {
  label: string;
  colorToken: string;
  current: boolean;
  unread: number;
  /** A failed sync, said in the tooltip and marked on the icon. */
  warning?: string;
  onClick(): void;
  children: ReactNode;
}) {
  const count = formatCount(unread);
  const description = [count && `${count} unread`, warning && `Sync failed: ${warning}`]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className="account-rail__item"
      style={{ "--rail-color": `var(${colorToken})` } as CSSProperties}
      aria-label={label}
      aria-description={description || undefined}
      aria-current={current || undefined}
      title={warning ? `${label}\nSync failed: ${warning}` : label}
      onClick={onClick}
    >
      <span className="account-rail__icon" aria-hidden="true">
        {children}
      </span>
      {warning ? (
        <span className="account-rail__badge account-rail__badge--warning" aria-hidden="true">
          !
        </span>
      ) : (
        count && (
          <span className="account-rail__badge" aria-hidden="true">
            {count}
          </span>
        )
      )}
    </button>
  );
}

function AccountButton({ account, accounts }: { account: AccountInfo; accounts: AccountInfo[] }) {
  const current = useUiStore((s) => s.mailbox.accountId === account.id);
  const unread = useLabelStore((s) => s.categoryCounts[account.id]?.INBOX ?? 0);
  const error = useAccountStore((s) => s.syncErrors[account.id]);
  const open = () => {
    const { mailbox, setMailbox } = useUiStore.getState();
    const tabs = visibleCategories(account.id).map((c) => c.labelId);
    setMailbox(mailboxInAccount(mailbox, account.id, tabs));
  };
  return (
    <RailButton
      label={account.email}
      colorToken={`--color-account-${accountColorIndex(account.id, accounts)}`}
      current={current}
      unread={unread}
      warning={error?.message}
      onClick={open}
    >
      {initialsFor(account.displayName || account.email)}
    </RailButton>
  );
}

/**
 * Settings › Appearance › Account rail: All Inboxes and every account as an icon beside the sidebar, each with its
 * unread count, the one you're in ringed. Picking an account shows it alone in the sidebar.
 */
export function AccountRail({ accounts }: { accounts: AccountInfo[] }) {
  const allInboxes = useUiStore((s) => s.mailbox.accountId === null);
  const allUnread = useLabelStore((s) => s.allInboxUnread);
  return (
    <nav className="account-rail" aria-label="Accounts">
      <RailButton
        label="All Inboxes"
        colorToken="--color-accent"
        current={allInboxes}
        unread={allUnread}
        onClick={() => useUiStore.getState().setMailbox(ALL_INBOXES)}
      >
        <Mails />
      </RailButton>
      {accounts.map((a) => (
        <AccountButton key={a.id} account={a} accounts={accounts} />
      ))}
    </nav>
  );
}
