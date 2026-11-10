import { ModSidebar } from "../mods/ModSurfaces";
import {
  ChevronRight,
  EllipsisVertical,
  type LucideIcon,
  Mails,
  PanelLeftClose,
  Plus,
  Settings,
  SquarePen,
  TriangleAlert,
  UserPlus,
  WifiOff,
} from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { Avatar } from "../components/ui/Avatar";
import { IconButton } from "../components/ui/IconButton";
import { ListRow } from "../components/ui/ListRow";
import { openColorPopover } from "../labels/ColorPopover";
import { openDeleteLabel, openLabelDialog } from "../labels/dialogStore";
import { editLabel } from "../labels/edit";
import { chipColors } from "../labels/palette";
import { useRevealStore } from "../labels/reveal";
import {
  buildLabelTree,
  filterSidebarTree,
  hiddenSidebarTree,
  type LabelNode,
  visibleInSidebar,
} from "../labels/tree";
import { type ContextMenuItem, showContextMenu } from "../lib/contextMenu";
import type { AccountInfo, LabelInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
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
import { focusFromKeyboard } from "../keyboard/focus";
import { registry } from "../keyboard/registry";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { useSettingsStore } from "../settings/settingsStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { Button } from "../components/ui/Button";
import { describeShortcut } from "../keyboard/format";

const NO_COUNTS: Record<string, never> = {};

const sameMailbox = (a: MailboxRef, b: MailboxRef) =>
  a.accountId === b.accountId &&
  a.labelId === b.labelId &&
  (a.category ?? null) === (b.category ?? null);

/** A mailbox or label row that opens something (synthetic label parents have no role). */
const MAILBOX_ROW = '.sidebar__row[role="link"]';

const plainKey = (e: KeyboardEvent) => !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/** The first row after `from` (down) or the last one before it (up). */
function nearest(rows: HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | undefined {
  const side = down ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  const beyond = rows.filter((r) => from.compareDocumentPosition(r) & side);
  return down ? beyond[0] : beyond[beyond.length - 1];
}

/**
 * Arrow keys inside the mailbox list: Up/Down step to the next mailbox and open it, Right moves on to the
 * conversation list. Left stops here, so it doesn't bounce back to the list (`list.focus`).
 */
function onMailboxKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!plainKey(e) || !(e.target instanceof HTMLElement)) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    registry.run("list.focus");
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const target = e.target;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(MAILBOX_ROW));
    const down = e.key === "ArrowDown";
    const at = rows.indexOf(target);
    // From a header, ⋮ or fold button: the nearest row in that direction.
    const next = at >= 0 ? rows[at + (down ? 1 : -1)] : nearest(rows, target, down);
    e.preventDefault();
    if (!next) return;
    focusFromKeyboard(next);
    next.click();
  }
}

/** Focus the open mailbox's row (or the first row when it isn't shown). False when there are none. */
function focusOpenMailbox(): boolean {
  const nav = document.querySelector<HTMLElement>(".sidebar__scroll");
  const row =
    nav?.querySelector<HTMLElement>(`${MAILBOX_ROW}[data-selected]`) ??
    nav?.querySelector<HTMLElement>(MAILBOX_ROW);
  focusFromKeyboard(row);
  return Boolean(row);
}

function activateOnKey(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** Below the row, left-aligned: where a menu or popover for it opens. */
const below = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
};

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
  /** The row's right-click (and Menu key) menu, if it has one. */
  menu?: () => ContextMenuItem[];
}

function MailboxRow({
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
    if (menu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
      e.preventDefault();
      void showContextMenu(menu(), below(e.currentTarget));
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
          void showContextMenu(menu(), { x: e.clientX, y: e.clientY });
        })
      }
      {...(droppable && target.accountId
        ? dropTarget(target.accountId, target.category ?? target.labelId)
        : {})}
    />
  );
}

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
          menu={() => [
            {
              id: "mark-read",
              label: "Mark all as read",
              onSelect: () => void markTabRead(accountId, c.labelId),
            },
          ]}
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
  error?: SyncFailure;
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
        aria-description={error ? `Sync failed: ${error.message}` : undefined}
        title={error ? `${account.email}\nSync failed: ${error.message}` : account.email}
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
      {isSignedOut(error) && (
        <div className="sidebar__sync-error" role="status">
          <span>Signed out by Google</span>
          <ReconnectButton accountId={account.id} />
        </div>
      )}
      <div id={rowsId} className="sidebar__group-rows" hidden={collapsed}>
        {!collapsed && <CategoryRows accountId={account.id} />}
      </div>
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

function Section({
  title,
  action,
  children,
  sectionRef,
}: {
  title: string;
  /** A button beside the heading. */
  action?: ReactNode;
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
}) {
  const id = useId();
  const heading = (
    <h2 id={id} className="sidebar__heading">
      {title}
    </h2>
  );
  return (
    <section ref={sectionRef} className="sidebar__section" aria-labelledby={id}>
      {action ? (
        <div className="sidebar__heading-row">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
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
          droppable={f.labelId === "TRASH"}
        />
      ))}
    </Section>
  );
}

const NO_FOLDS: string[] = [];

const LIST_VISIBILITY = [
  { value: "labelShow", text: "Show in label list" },
  { value: "labelShowIfUnread", text: "Show if unread" },
  { value: "labelHide", text: "Hide in label list" },
] as const;

/** A label's ⋮ menu: colour, visibility, edit, add sublabel, delete. `anchor` is the row it belongs to. */
function labelMenu(accountId: string, label: LabelInfo, anchor: HTMLElement): ContextMenuItem[] {
  const list = label.labelListVisibility ?? "labelShow";
  const inMessages = label.messageListVisibility !== "hide";
  const edit = (change: Parameters<typeof editLabel>[2]) =>
    void editLabel(accountId, label.id, change);
  return [
    {
      id: "label-colour",
      label: "Label colour…",
      onSelect: () =>
        openColorPopover({ accountId, labelId: label.id, at: below(anchor), returnFocus: anchor }),
    },
    { type: "separator" },
    ...LIST_VISIBILITY.map(({ value, text }) => ({
      id: `label-list-${value}`,
      label: text,
      checked: list === value,
      onSelect: () => list !== value && edit({ labelListVisibility: value }),
    })),
    {
      id: "label-message-list",
      label: "Show in message list",
      checked: inMessages,
      onSelect: () => edit({ messageListVisibility: inMessages ? "hide" : "show" }),
    },
    { type: "separator" },
    {
      id: "label-edit",
      label: "Edit…",
      onSelect: () =>
        openLabelDialog({ mode: "edit", accountId, labelId: label.id, returnFocus: anchor }),
    },
    {
      id: "label-sublabel",
      label: "Add sublabel…",
      onSelect: () =>
        openLabelDialog({ mode: "create", accountId, parent: label.name, returnFocus: anchor }),
    },
    {
      id: "label-delete",
      label: "Delete label",
      danger: true,
      onSelect: () => openDeleteLabel(accountId, label.id, anchor),
    },
  ];
}

function LabelDot({ label }: { label: LabelInfo | null }) {
  const colors = label && chipColors(label);
  return (
    <span
      className={cx(
        "sidebar__label-dot",
        !label && "sidebar__label-dot--empty",
        label && !colors && "sidebar__label-dot--none",
      )}
      style={colors ? { backgroundColor: colors.background } : undefined}
      aria-hidden="true"
    />
  );
}

interface LabelRowProps {
  accountId: string;
  node: LabelNode;
  folded: boolean;
  unread: number;
}

/** One label (or a synthetic parent: not a link, no menu), with a fold chevron when it has sublabels. */
function LabelRow({ accountId, node, folded, unread }: LabelRowProps) {
  const { label } = node;
  const selected = useUiStore(
    (s) => label !== null && sameMailbox(s.mailbox, { accountId, labelId: label.id }),
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const parent = node.children.length > 0;
  const text = formatCount(unread);
  const fold = () => useUiStore.getState().toggleLabelFold(accountId, node.path);
  const go = () => label && useUiStore.getState().setMailbox({ accountId, labelId: label.id });
  const menu = (anchor: HTMLElement, at = below(anchor)) => {
    if (label) void showContextMenu(labelMenu(accountId, label, anchor), at);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      menu(e.currentTarget);
    } else activateOnKey(e, go);
  };

  return (
    <div
      className={cx("sidebar__label", parent && "sidebar__label--parent")}
      style={{ "--label-depth": node.depth } as CSSProperties}
      onContextMenu={(e) => {
        if (!label || !rowRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        menu(rowRef.current, { x: e.clientX, y: e.clientY });
      }}
    >
      <ListRow
        ref={rowRef}
        role={label ? "link" : "none"}
        tabIndex={label ? 0 : undefined}
        density="compact"
        aria-label={label ? node.path : undefined}
        aria-description={label && text ? `${text} unread` : undefined}
        selected={selected}
        className={cx(
          "sidebar__row",
          "sidebar__label-row",
          !label && "sidebar__label-row--synthetic",
        )}
        style={{ "--row-color": "var(--color-foreground)" } as CSSProperties}
        leading={<LabelDot label={label} />}
        title={<span title={node.path}>{node.leaf}</span>}
        meta={text ? <span aria-hidden="true">{text}</span> : undefined}
        onClick={label ? go : fold}
        onKeyDown={label ? onKeyDown : undefined}
        {...(label ? dropTarget(accountId, label.id) : {})}
      />
      {label && (
        <IconButton
          ref={menuRef}
          size="sm"
          className="sidebar__label-menu"
          label={`Options for ${node.path}`}
          icon={<EllipsisVertical />}
          onClick={() => {
            if (menuRef.current && rowRef.current) menu(rowRef.current, below(menuRef.current));
          }}
        />
      )}
      {parent && (
        <button
          type="button"
          className="sidebar__fold"
          aria-expanded={!folded}
          aria-label={`${node.leaf} sublabels`}
          onClick={fold}
        >
          <ChevronRight className="sidebar__chevron" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function LabelTreeRows({
  accountId,
  nodes,
  folded,
  unreadOf,
}: {
  accountId: string;
  nodes: LabelNode[];
  folded: string[];
  unreadOf: (label: LabelInfo) => number;
}) {
  return nodes.map((node) => {
    const isFolded = folded.includes(node.path);
    return (
      <Fragment key={node.path}>
        <LabelRow
          accountId={accountId}
          node={node}
          folded={isFolded}
          unread={node.label ? unreadOf(node.label) : 0}
        />
        {!isFolded && node.children.length > 0 && (
          <LabelTreeRows
            accountId={accountId}
            nodes={node.children}
            folded={folded}
            unreadOf={unreadOf}
          />
        )}
      </Fragment>
    );
  });
}

/**
 * The shown tree with labels kept only as ancestors of shown sublabels (show-if-unread with nothing unread)
 * turned into context rows, like synthetic parents: their actionable row is under More.
 */
function contextForHidden(nodes: LabelNode[], unreadOf: (label: LabelInfo) => number): LabelNode[] {
  return nodes.map((node) => ({
    ...node,
    label: node.label && visibleInSidebar(node.label, unreadOf(node.label)) ? node.label : null,
    children: contextForHidden(node.children, unreadOf),
  }));
}

/** The account's user labels as a tree: shown ones first, then a More row holding the hidden ones. */
function LabelsSection({ accountId }: { accountId: string }) {
  const labels = useLabelStore((s) => s.userLabels(accountId));
  const counts = useLabelStore((s) => s.counts[accountId] ?? NO_COUNTS);
  const folded = useUiStore((s) => s.foldedLabels[accountId] ?? NO_FOLDS);
  const moreOpen = useUiStore((s) => s.labelsMoreOpen.includes(accountId));
  const pending = useRevealStore((s) => s.pending);
  const sectionRef = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const moreId = useId();

  const { shown, hidden, unreadOf } = useMemo(() => {
    const unreadOf = (l: LabelInfo) => counts[l.id]?.unread ?? 0;
    const tree = buildLabelTree(labels);
    return {
      shown: contextForHidden(filterSidebarTree(tree, unreadOf), unreadOf),
      hidden: hiddenSidebarTree(tree, unreadOf),
      unreadOf,
    };
  }, [labels, counts]);

  // "Manage labels": bring the section into view and focus its first label.
  useEffect(() => {
    if (!pending) return;
    useRevealStore.setState({ pending: 0 });
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    const first = rowsRef.current?.querySelector<HTMLElement>('[role="link"]');
    (first ?? createRef.current)?.focus({ preventScroll: true });
  }, [pending]);

  return (
    <Section
      sectionRef={sectionRef}
      title="Labels"
      action={
        <IconButton
          ref={createRef}
          size="sm"
          label="Create label"
          icon={<Plus />}
          onClick={() =>
            openLabelDialog({ mode: "create", accountId, returnFocus: createRef.current })
          }
        />
      }
    >
      <div ref={rowsRef} className="sidebar__labels">
        <LabelTreeRows accountId={accountId} nodes={shown} folded={folded} unreadOf={unreadOf} />
        {hidden.length > 0 && (
          <>
            <button
              type="button"
              className="sidebar__more"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => useUiStore.getState().toggleLabelsMore(accountId)}
            >
              <span className="sidebar__more-text">More</span>
              <ChevronRight className="sidebar__chevron" aria-hidden="true" />
            </button>
            <div id={moreId} className="sidebar__labels" hidden={!moreOpen}>
              {moreOpen && (
                <LabelTreeRows
                  accountId={accountId}
                  nodes={hidden}
                  folded={folded}
                  unreadOf={unreadOf}
                />
              )}
            </div>
          </>
        )}
      </div>
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

  // Left from the conversation list lands here.
  useCommands([
    {
      id: "sidebar.focus",
      title: "Focus mailboxes",
      group: "Navigation",
      run: focusOpenMailbox,
    },
  ]);

  return (
    <div className="sidebar">
      <div className="toolbar toolbar--sidebar" {...dragRegion}>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="Hide sidebar"
          shortcut={sidebarShortcut}
          icon={<PanelLeftClose />}
          onClick={toggleSidebar}
        />
      </div>

      <div className="sidebar__compose">
        <Button
          variant="primary"
          size="lg"
          icon={<SquarePen aria-hidden="true" />}
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
                  {isSignedOut(errors[single.id]) && <ReconnectButton accountId={single.id} />}
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
                <AccountSection key={a.id} account={a} accounts={accounts} error={errors[a.id]} />
              ))}
            </>
          )}
        </Section>
        {active && <Favorites accountId={active.id} />}
        {active && <LabelsSection accountId={active.id} />}
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
