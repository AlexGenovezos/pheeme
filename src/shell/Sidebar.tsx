import { ModSidebar } from "../mods/ModSurfaces";
import { NotificationOffer } from "../desktop/NotificationOffer";
import {
  ChevronRight,
  Gauge,
  type LucideIcon,
  Mails,
  PanelLeftClose,
  SquarePen,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, memo, useEffect, useId } from "react";
import { IconButton } from "../components/ui/IconButton";
import { ListRow } from "../components/ui/ListRow";
import { type ContextMenuItem, isContextMenuKey, showContextMenu } from "../lib/contextMenu";
import type { AccountInfo } from "../lib/tauri";
import {
  accountColorIndex,
  ALL_INBOXES,
  categoryMailbox,
  FAVORITES,
  formatCount,
  homeMailbox,
  mailboxExists,
  type MailboxRef,
  resolveActiveAccount,
} from "../mail/mailboxes";
import { composeNew, markTabRead } from "../mail/actions";
import { dropTarget } from "../mail/dragMail";
import { isSignedOut, ReconnectButton } from "../onboarding/Reconnect";
import { type SyncFailure, useAccountStore } from "../store/accountStore";
import { useInboxTabs, visibleCategories } from "../store/inboxTabsStore";
import { useLabelStore } from "../store/labelStore";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { focusOpenMailbox, onMailboxKeyDown, activateOnKey, below } from "./sidebar/keys";
import { LabelsSection } from "./sidebar/Labels";
import { AccountColorButton } from "./sidebar/AccountColor";
import {
  ACCOUNT_GROUP,
  moveAccount,
  startAccountDrag,
  useAccountDrag,
} from "./sidebar/accountOrder";
import { Section } from "./sidebar/Section";
import { NO_COUNTS, sameMailbox } from "./sidebar/shared";
import { SidebarFooter } from "./SidebarFooter";
import { useAccountIndicators, useRailShown } from "./accountIndicators";
import { AccountRail } from "./sidebar/AccountRail";
import { Button } from "../components/ui/Button";
import { describeShortcut } from "../keyboard/format";

interface MailboxRowProps {
  name: string;
  icon: LucideIcon;
  /** CSS custom property for the icon, selected tint and selected label. */
  colorToken: string;
  count: number;
  /** Screen reader word for the count ("unread", "conversations"). */
  unit: string;
  target: MailboxRef;
  /** Dragged conversations can be dropped here (a category or Trash of `target`'s account). */
  droppable?: boolean;
  /**
   * The row's right-click (and Menu key) menu, if it has one, built for `target`. Keep it a stable function:
   * the row is memoized, and a new one each render would re-render every row.
   */
  menu?: (target: MailboxRef) => ContextMenuItem[];
}

/**
 * Memoized, with `target` compared by value (callers build it inline): the sidebar re-renders on every unread
 * count change and mailbox switch, and without this every row did too.
 */
const MailboxRow = memo(
  MailboxRowView,
  (a, b) =>
    a.name === b.name &&
    a.icon === b.icon &&
    a.colorToken === b.colorToken &&
    a.count === b.count &&
    a.unit === b.unit &&
    sameMailbox(a.target, b.target) &&
    a.droppable === b.droppable &&
    a.menu === b.menu,
);

function MailboxRowView({
  name,
  icon: Icon,
  colorToken,
  count,
  unit,
  target,
  droppable,
  menu,
}: MailboxRowProps) {
  const selected = useUiStore((s) => sameMailbox(s.mailbox, target));
  const go = () => useUiStore.getState().setMailbox(target);
  const text = formatCount(count);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (menu && isContextMenuKey(e)) {
      e.preventDefault();
      void showContextMenu(menu(target), below(e.currentTarget));
    } else activateOnKey(e, go);
  };
  return (
    <ListRow
      role="link"
      tabIndex={0}
      density="compact"
      aria-description={text ? `${text} ${unit}` : undefined}
      selected={selected}
      className="sidebar__row"
      style={{ "--row-color": `var(${colorToken})` } as CSSProperties}
      leading={<Icon aria-hidden="true" />}
      title={name}
      // The name comes from the visible title; aria-description carries the count, so the number is hidden.
      meta={text ? <span aria-hidden="true">{text}</span> : undefined}
      onClick={go}
      onKeyDown={onKeyDown}
      onContextMenu={
        menu &&
        ((e) => {
          e.preventDefault();
          e.stopPropagation();
          void showContextMenu(menu(target), { x: e.clientX, y: e.clientY });
        })
      }
      {...(droppable && target.accountId
        ? dropTarget(target.accountId, target.category ?? target.labelId)
        : {})}
    />
  );
}

/** An Inbox tab's menu. */
const tabMenu = (target: MailboxRef): ContextMenuItem[] => [
  {
    id: "mark-read",
    label: "Mark all as read",
    onSelect: () => {
      if (target.accountId && target.category) void markTabRead(target.accountId, target.category);
    },
  },
];

function CategoryRows({ accountId }: { accountId: string }) {
  const counts = useLabelStore((s) => s.categoryCounts[accountId] ?? NO_COUNTS);
  useInboxTabs((s) => s.hidden[accountId]); // re-render when the tabs change
  const rows = visibleCategories(accountId);
  return (
    <>
      {rows.map((c) => (
        <MailboxRow
          key={c.labelId}
          name={c.name}
          icon={c.icon}
          colorToken={c.colorToken}
          count={counts[c.labelId] ?? 0}
          unit="unread"
          target={categoryMailbox(accountId, c.labelId)}
          droppable
          menu={tabMenu}
        />
      ))}
    </>
  );
}

function AccountSection({
  account,
  accounts,
  error,
  glowing,
}: {
  account: AccountInfo;
  accounts: AccountInfo[];
  error?: SyncFailure;
  /** Settings › Appearance › Glow: this is the account you're in. */
  glowing: boolean;
}) {
  const collapsed = useUiStore((s) => s.collapsedAccounts.includes(account.id));
  const inboxUnread = useLabelStore((s) => s.categoryCounts[account.id]?.INBOX ?? 0);
  const drop = useAccountDrag((s) => dropMark(s.dragging, s.order, accounts, account.id));
  const rowsId = useId();
  const color = accountColorIndex(account.id, accounts);
  const collapsedCount = collapsed ? formatCount(inboxUnread) : "";
  const dotId = useId();
  const index = accounts.findIndex((a) => a.id === account.id);
  const menu = (): ContextMenuItem[] => [
    {
      id: "account-color",
      label: "Change colour…",
      onSelect: () => document.getElementById(dotId)?.click(),
    },
    {
      id: "move-up",
      label: "Move up",
      disabled: index === 0,
      onSelect: () => moveAccount(account.id, -1),
    },
    {
      id: "move-down",
      label: "Move down",
      disabled: index === accounts.length - 1,
      onSelect: () => moveAccount(account.id, 1),
    },
  ];
  return (
    <div
      className="sidebar__group"
      role="group"
      aria-label={account.email}
      data-current={glowing || undefined}
      data-drop={drop}
      {...{ [ACCOUNT_GROUP]: account.id }}
      style={{ "--account-color": `var(--color-account-${color})` } as CSSProperties}
    >
      <div
        className="sidebar__account-header"
        onPointerDown={(e) => startAccountDrag(e, account.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void showContextMenu(menu(), { x: e.clientX, y: e.clientY });
        }}
      >
        <AccountColorButton id={dotId} accountId={account.id} color={color} />
        <button
          type="button"
          className="sidebar__account-toggle"
          aria-expanded={!collapsed}
          aria-controls={rowsId}
          aria-description={error ? `Sync failed: ${error.message}` : undefined}
          title={error ? `${account.email}\nSync failed: ${error.message}` : account.email}
          onClick={() => useUiStore.getState().toggleAccountCollapsed(account.id)}
          onKeyDown={(e) => {
            if (!isContextMenuKey(e)) return;
            e.preventDefault();
            void showContextMenu(menu(), below(e.currentTarget));
          }}
        >
          <span className="sidebar__account-email">{account.email}</span>
          {error && <TriangleAlert className="sidebar__account-warning" aria-hidden="true" />}
          {collapsedCount && <span className="sidebar__account-count">{collapsedCount}</span>}
          <ChevronRight className="sidebar__chevron" aria-hidden="true" />
        </button>
      </div>
      <SyncErrorNote accountId={account.id} error={error} />
      <div id={rowsId} className="sidebar__group-rows" hidden={collapsed}>
        {!collapsed && <CategoryRows accountId={account.id} />}
      </div>
    </div>
  );
}

/**
 * Where a drag of `dragging` would put it, marked on the account groups: "before" on the account it would land above,
 * "after" on the last when it would land at the end, "dragging" on the one being dragged. Nothing while the drop
 * would leave the order as it is.
 */
function dropMark(
  dragging: string | null,
  order: string[] | null,
  accounts: AccountInfo[],
  id: string,
): "before" | "after" | "dragging" | undefined {
  if (!dragging || !order) return undefined;
  if (id === dragging) return "dragging";
  if (order.every((other, i) => other === accounts[i]?.id)) return undefined;
  const at = order.indexOf(dragging);
  const next = order[at + 1];
  if (next !== undefined) return next === id ? "before" : undefined;
  return order[at - 1] === id ? "after" : undefined;
}

/**
 * A failed sync, with the way back in when Google signed the account out. `detailed` (the only account, which has no
 * header to carry the failure) spells out what failed; otherwise the note appears only for a sign-out.
 */
function SyncErrorNote({
  accountId,
  error,
  detailed = false,
}: {
  accountId: string;
  error?: SyncFailure;
  detailed?: boolean;
}) {
  if (!error || (!detailed && !isSignedOut(error))) return null;
  return (
    <div className="sidebar__sync-error" role="status" title={detailed ? error.message : undefined}>
      {detailed && <TriangleAlert aria-hidden="true" />}
      <span>{detailed ? `Sync failed: ${error.message}` : "Signed out by Google"}</span>
      {isSignedOut(error) && <ReconnectButton accountId={accountId} />}
    </div>
  );
}

/** One calm note while Google can't be reached, in place of a failure on every account. */
function OfflineNote() {
  const offline = useAccountStore((s) => s.offline);
  if (!offline) return null;
  return (
    <div
      className="sidebar__sync-error sidebar__offline"
      role="status"
      title="Pheeme syncs again as soon as the connection is back. Changes you make wait until then."
    >
      <WifiOff aria-hidden="true" />
      <span>Offline. Changes will sync later.</span>
    </div>
  );
}

/** One calm note while Gmail is slowing sync, however many accounts it slows. */
function SlowSyncNote() {
  const offline = useAccountStore((s) => s.offline);
  const slowSync = useAccountStore((s) => s.slowSync);
  const slow = Object.values(slowSync);
  if (offline || slow.length === 0) return null;
  const contended = slow.some((s) => s.contended);
  return (
    <div
      className="sidebar__sync-error sidebar__offline"
      role="status"
      title="Gmail limits how fast an account can sync. Pheeme slows down and carries on by itself; nothing to do."
    >
      <Gauge aria-hidden="true" />
      <span>
        {contended
          ? "Gmail is slowing sync. Another device may be syncing this account."
          : "Gmail is slowing sync."}
      </span>
    </div>
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
          droppable={f.labelId === "TRASH"}
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
  const sidebarShortcut = useKeybinding("view.toggleSidebar");
  const glow = useAccountIndicators((s) => s.glow);
  const rail = useRailShown();
  // The account whose mailbox is open; null in All Inboxes, which is every account.
  const current = useUiStore((s) => s.mailbox.accountId);
  const composeShortcut = useKeybinding("compose.new");

  const activeId = resolveActiveAccount(storedActive, accounts);
  const active = accounts.find((a) => a.id === activeId);
  const single = accounts.length === 1 ? accounts[0] : null;
  // With the rail, the sidebar shows the account picked there alone, the way it shows a single account.
  const shown = single ?? (rail ? (accounts.find((a) => a.id === current) ?? null) : null);
  // The account whose Favorites and labels show.
  const folders = rail ? shown : active;

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

  // Left from the conversation list lands here.
  useCommands([
    {
      id: "sidebar.focus",
      title: "Focus mailboxes",
      group: "Navigation",
      run: focusOpenMailbox,
    },
  ]);

  const sidebar = (
    <div className="sidebar">
      <div className="toolbar toolbar--sidebar" {...dragRegion}>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="Hide sidebar"
          data-command="view.toggleSidebar"
          shortcut={sidebarShortcut}
          icon={<PanelLeftClose />}
          onClick={toggleSidebar}
        />
      </div>

      {rail && (
        <div
          className="sidebar__current-account"
          title={shown?.email ?? "All Inboxes"}
          style={
            shown
              ? ({
                  "--account-color": `var(--color-account-${accountColorIndex(shown.id, accounts)})`,
                } as CSSProperties)
              : undefined
          }
        >
          {shown ? (
            <AccountColorButton
              accountId={shown.id}
              color={accountColorIndex(shown.id, accounts)}
            />
          ) : (
            <Mails aria-hidden="true" />
          )}
          <span className="sidebar__account-email">{shown?.email ?? "All Inboxes"}</span>
        </div>
      )}

      <div className="sidebar__compose">
        <Button
          variant="primary"
          size="lg"
          icon={<SquarePen aria-hidden="true" />}
          data-command="compose.new"
          title={
            composeShortcut ? `New message (${describeShortcut(composeShortcut)})` : "New message"
          }
          onClick={composeNew}
        >
          New message
        </Button>
      </div>

      <nav className="sidebar__scroll" aria-label="Mailboxes" onKeyDown={onMailboxKeyDown}>
        <Section title="Inboxes">
          <OfflineNote />
          <SlowSyncNote />
          {shown ? (
            <>
              <SyncErrorNote accountId={shown.id} error={errors[shown.id]} detailed />
              <CategoryRows accountId={shown.id} />
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
                  error={errors[a.id]}
                  glowing={glow && a.id === current}
                />
              ))}
            </>
          )}
        </Section>
        {/* With the rail, the shown account's; none in All Inboxes (pick an account on the rail). */}
        {folders && <Favorites accountId={folders.id} />}
        {folders && <LabelsSection accountId={folders.id} />}
      </nav>

      <ModSidebar />
      <NotificationOffer />
      <SidebarFooter onAddAccount={onAddAccount} />
    </div>
  );
  if (!rail) return sidebar;
  return (
    <div className="sidebar-frame">
      <AccountRail accounts={accounts} />
      {sidebar}
    </div>
  );
}
