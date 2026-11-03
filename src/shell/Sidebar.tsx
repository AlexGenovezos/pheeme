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
  const active = useUiStore((s) => s.activeMailbox);
  const setActive = useUiStore((s) => s.setActiveMailbox);
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

  const row = (id: string, label: string, icon: ReactNode, unread: number) => (
    <ListRow
      key={id}
      role="link"
      tabIndex={0}
      density="compact"
      selected={active === id}
      leading={icon}
      title={label}
      meta={unread > 0 ? <Badge count={unread} tone={active === id ? "accent" : "neutral"} /> : undefined}
      onClick={() => setActive(id)}
      onKeyDown={(e) => activateOnKey(e, () => setActive(id))}
    />
  );

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
