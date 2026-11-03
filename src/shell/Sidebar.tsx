import {
  AlertOctagon,
  Archive,
  File,
  Inbox,
  Monitor,
  Settings,
  Moon,
  PanelLeftClose,
  Send,
  Star,
  Sun,
  Tag,
  Trash2,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Avatar } from "../components/ui/Avatar";
import { Badge } from "../components/ui/Badge";
import { IconButton } from "../components/ui/IconButton";
import { ListRow } from "../components/ui/ListRow";
import { showContextMenu } from "../lib/contextMenu";
import type { MailboxRef } from "../mail/mailboxes";
import { fixtureLabels, fixtureMailboxes, type FixtureMailbox } from "../preview/fixtures";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { useThemeStore, type ThemeMode } from "../theme/theme";
import { dragRegion } from "./chrome";

const ICONS: Record<FixtureMailbox["icon"], typeof Inbox> = {
  inbox: Inbox,
  star: Star,
  send: Send,
  file: File,
  archive: Archive,
  alert: AlertOctagon,
  trash: Trash2,
};

const MODE_ICON: Record<ThemeMode, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const MODE_LABEL: Record<ThemeMode, string> = { system: "Match system", light: "Light", dark: "Dark" };

function activateOnKey(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

export function Sidebar({ onManageAccounts }: { onManageAccounts?: () => void }) {
  const mailbox = useUiStore((s) => s.mailbox);
  const setMailbox = useUiStore((s) => s.setMailbox);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const account = useAccountStore((s) => s.accounts[0]);
  const ModeIcon = MODE_ICON[mode];

  const openThemeMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      (["system", "light", "dark"] as const).map((m) => ({
        id: `theme-${m}`,
        label: MODE_LABEL[m],
        checked: mode === m,
        onSelect: () => setMode(m),
      })),
      { x: r.left, y: r.bottom },
    );
  };

  // Interim rows (the stacked sidebar replaces them): each is one label across every account.
  const row = (id: string, label: string, icon: ReactNode, unread: number) => {
    const ref: MailboxRef = { accountId: null, labelId: id };
    const active = mailbox.accountId === null && !mailbox.category && mailbox.labelId === id;
    return (
      <ListRow
        key={id}
        role="link"
        tabIndex={0}
        density="compact"
        selected={active}
        leading={icon}
        title={label}
        meta={unread > 0 ? <Badge count={unread} tone={active ? "accent" : "neutral"} /> : undefined}
        onClick={() => setMailbox(ref)}
        onKeyDown={(e) => activateOnKey(e, () => setMailbox(ref))}
      />
    );
  };

  return (
    <div className="sidebar">
      <div className="toolbar toolbar--sidebar" {...dragRegion}>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="Hide sidebar" shortcut="mod+b" icon={<PanelLeftClose />} onClick={toggleSidebar} />
      </div>

      <nav className="sidebar__scroll" aria-label="Mailboxes">
        <div className="sidebar__section">
          {fixtureMailboxes.map((m) => {
            const Icon = ICONS[m.icon];
            return row(m.id, m.name, <Icon />, m.unread);
          })}
        </div>
        <div className="sidebar__section">
          <div className="sidebar__heading">Labels</div>
          {fixtureLabels.map((l) => row(l.id, l.name, <Tag />, l.unread))}
        </div>
      </nav>

      <div className="sidebar__footer">
        <Avatar name={account?.displayName ?? account?.email ?? "Account"} email={account?.email} size="sm" />
        <span className="sidebar__account" title={account?.email}>
          {account?.email}
        </span>
        {onManageAccounts && <IconButton label="Manage accounts" icon={<Settings />} onClick={onManageAccounts} />}
        <IconButton label={`Appearance: ${MODE_LABEL[mode]}`} icon={<ModeIcon />} onClick={openThemeMenu} />
      </div>
    </div>
  );
}
