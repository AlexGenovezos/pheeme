import { ModSidebar } from "../mods/ModSurfaces";
import {
  ChevronRight,
  type LucideIcon,
  Mails,
  PanelLeftClose,
  Settings,
  SquarePen,
  Tag,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId } from "react";
import { Avatar } from "../components/ui/Avatar";
import { IconButton } from "../components/ui/IconButton";
import { ListRow } from "../components/ui/ListRow";
import type { AccountInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
import {
  accountColorIndex,
  ALL_INBOXES,
  CATEGORIES,
  categoryMailbox,
  FAVORITES,
  formatCount,
  homeMailbox,
  mailboxExists,
  type MailboxRef,
  resolveActiveAccount,
} from "../mail/mailboxes";
import { composeNew } from "../mail/actions";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useKeybinding } from "../keyboard/useCommands";
import { useSettingsStore } from "../settings/settingsStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";

const NO_COUNTS: Record<string, never> = {};

const sameMailbox = (a: MailboxRef, b: MailboxRef) =>
  a.accountId === b.accountId &&
  a.labelId === b.labelId &&
  (a.category ?? null) === (b.category ?? null);

function activateOnKey(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

interface MailboxRowProps {
  name: string;
  icon: LucideIcon;
  /** CSS custom property for the icon, selected tint and selected label. */
  colorToken: string;
  count: number;
  /** Screen reader word for the count ("unread", "conversations"). */
  unit: string;
  target: MailboxRef;
  /** A user label: neutral icon, optional Gmail color dot. */
  labelColor?: string | null;
  neutral?: boolean;
}

function MailboxRow({
  name,
  icon: Icon,
  colorToken,
  count,
  unit,
  target,
  labelColor,
  neutral,
}: MailboxRowProps) {
  const selected = useUiStore((s) => sameMailbox(s.mailbox, target));
  const go = () => useUiStore.getState().setMailbox(target);
  const text = formatCount(count);
  return (
    <ListRow
      role="link"
      tabIndex={0}
      density="compact"
      aria-label={name}
      aria-description={text ? `${text} ${unit}` : undefined}
      selected={selected}
      className={cx("sidebar__row", neutral && "sidebar__row--neutral")}
      style={{ "--row-color": `var(${colorToken})` } as CSSProperties}
      leading={
        <>
          <Icon aria-hidden="true" />
          {labelColor && (
            <span
              className="sidebar__label-dot"
              style={{ backgroundColor: labelColor }}
              aria-hidden="true"
            />
          )}
        </>
      }
      title={name}
      meta={text || undefined}
      onClick={go}
      onKeyDown={(e) => activateOnKey(e, go)}
    />
  );
}

function CategoryRows({ accountId }: { accountId: string }) {
  const counts = useLabelStore((s) => s.categoryCounts[accountId] ?? NO_COUNTS);
  return (
    <>
      {CATEGORIES.map((c) => (
        <MailboxRow
          key={c.labelId}
          name={c.name}
          icon={c.icon}
          colorToken={c.colorToken}
          count={counts[c.labelId] ?? 0}
          unit="unread"
          target={categoryMailbox(accountId, c.labelId)}
        />
      ))}
    </>
  );
}

function AccountSection({
  account,
  accounts,
  error,
}: {
  account: AccountInfo;
  accounts: AccountInfo[];
  error?: string;
}) {
  const collapsed = useUiStore((s) => s.collapsedAccounts.includes(account.id));
  const inboxUnread = useLabelStore((s) => s.categoryCounts[account.id]?.INBOX ?? 0);
  const rowsId = useId();
  const color = accountColorIndex(account.id, accounts);
  const collapsedCount = collapsed ? formatCount(inboxUnread) : "";
  return (
    <div className="sidebar__group" role="group" aria-label={account.email}>
      <button
        type="button"
        className="sidebar__account-header"
        aria-expanded={!collapsed}
        aria-controls={rowsId}
        aria-description={error ? `Sync failed: ${error}` : undefined}
        title={error ? `${account.email}\nSync failed: ${error}` : account.email}
        onClick={() => useUiStore.getState().toggleAccountCollapsed(account.id)}
      >
        <span
          className="sidebar__account-dot"
          style={{ background: `var(--color-account-${color})` }}
          aria-hidden="true"
        />
        <span className="sidebar__account-email">{account.email}</span>
        {error && <TriangleAlert className="sidebar__account-warning" aria-hidden="true" />}
        {collapsedCount && <span className="sidebar__account-count">{collapsedCount}</span>}
        <ChevronRight className="sidebar__chevron" aria-hidden="true" />
      </button>
      <div id={rowsId} className="sidebar__group-rows" hidden={collapsed}>
        {!collapsed && <CategoryRows accountId={account.id} />}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sidebar__section" aria-labelledby={id}>
      <h2 id={id} className="sidebar__heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Favorites({ accountId }: { accountId: string }) {
  const counts = useLabelStore((s) => s.counts[accountId] ?? NO_COUNTS);
  return (
    <Section title="Favorites">
      {FAVORITES.map((f) => (
        <MailboxRow
          key={f.labelId}
          name={f.name}
          icon={f.icon}
          colorToken={f.colorToken}
          count={counts[f.labelId]?.[f.count] ?? 0}
          unit={f.count === "total" ? "conversations" : "unread"}
          target={{ accountId, labelId: f.labelId }}
        />
      ))}
    </Section>
  );
}

function GmailLabels({ accountId }: { accountId: string }) {
  const labels = useLabelStore((s) => s.userLabels(accountId));
  const counts = useLabelStore((s) => s.counts[accountId] ?? NO_COUNTS);
  if (labels.length === 0) return null;
  return (
    <Section title="Gmail">
      {labels.map((l) => (
        <MailboxRow
          key={l.id}
          name={l.name}
          icon={Tag}
          colorToken="--color-foreground"
          neutral
          labelColor={l.colorBackground}
          count={counts[l.id]?.unread ?? 0}
          unit="unread"
          target={{ accountId, labelId: l.id }}
        />
      ))}
    </Section>
  );
}

export function Sidebar({ onAddAccount }: { onAddAccount?: () => void }) {
  const accounts = useAccountStore((s) => s.accounts);
  const storedActive = useUiStore((s) => s.activeAccountId);
  const allInboxes = useUiStore((s) => sameMailbox(s.mailbox, ALL_INBOXES));
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const allInboxUnread = useLabelStore((s) => s.allInboxUnread);
  const errors = useAccountStore((s) => s.syncErrors);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const settingsShortcut = useKeybinding("settings.open");
  const sidebarShortcut = useKeybinding("view.toggleSidebar", "mod+b");
  const composeShortcut = useKeybinding("compose.new", "c");

  const activeId = resolveActiveAccount(storedActive, accounts);
  const active = accounts.find((a) => a.id === activeId);
  const single = accounts.length === 1 ? accounts[0] : null;

  // With one account there is no All Inboxes row, so its Primary stands in for it.
  useEffect(() => {
    if (single && allInboxes) useUiStore.getState().setMailbox(homeMailbox([single]));
  }, [single, allInboxes]);

  // The mailbox restored from the last launch may belong to an account or label that is gone since.
  const mailbox = useUiStore((s) => s.mailbox);
  const labels = useLabelStore((s) => s.labels);
  useEffect(() => {
    const home = homeMailbox(accounts);
    if (!mailboxExists(mailbox, accounts, labels) && !sameMailbox(mailbox, home))
      useUiStore.getState().setMailbox(home);
  }, [mailbox, accounts, labels]);

  return (
    <div className="sidebar">
      <div className="toolbar toolbar--sidebar" {...dragRegion}>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="New message"
          shortcut={composeShortcut}
          icon={<SquarePen />}
          onClick={composeNew}
        />
        <IconButton
          label="Hide sidebar"
          shortcut={sidebarShortcut}
          icon={<PanelLeftClose />}
          onClick={toggleSidebar}
        />
      </div>

      <nav className="sidebar__scroll" aria-label="Mailboxes">
        <Section title="Inboxes">
          {single ? (
            <>
              {errors[single.id] && (
                <div
                  className="sidebar__sync-error"
                  role="status"
                  title={errors[single.id].message}
                >
                  <TriangleAlert aria-hidden="true" />
                  <span>Sync failed: {errors[single.id].message}</span>
                </div>
              )}
              <CategoryRows accountId={single.id} />
            </>
          ) : (
            <>
              <MailboxRow
                name="All Inboxes"
                icon={Mails}
                colorToken="--color-accent"
                count={allInboxUnread}
                unit="unread"
                target={ALL_INBOXES}
              />
              {accounts.map((a) => (
                <AccountSection
                  key={a.id}
                  account={a}
                  accounts={accounts}
                  error={errors[a.id]?.message}
                />
              ))}
            </>
          )}
        </Section>
        {active && <Favorites accountId={active.id} />}
        {active && <GmailLabels accountId={active.id} />}
      </nav>

      <ModSidebar />
      <div className="sidebar__footer">
        {active && (
          <Avatar name={active.displayName ?? active.email} email={active.email} size="sm" />
        )}
        <span className="sidebar__account" title={active?.email}>
          {active?.email}
        </span>
        {onAddAccount && (
          <IconButton label="Add account" icon={<UserPlus />} onClick={onAddAccount} />
        )}
        <IconButton
          label="Settings"
          shortcut={settingsShortcut}
          icon={<Settings />}
          onClick={() => openSettings()}
        />
      </div>
    </div>
  );
}
