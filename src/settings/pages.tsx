import { ModsSettings } from "../mods/ModsSettings";
import { Info, Keyboard, Palette, Puzzle, SquarePen, Users } from "lucide-react";
import {
  UNDO_SEND_CHOICES,
  type UndoSendSeconds,
  useComposeSettings,
} from "../compose/composeSettings";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Switch } from "../components/ui/Switch";
import { registry } from "../keyboard/registry";
import { useUiStore } from "../store/uiStore";
import { THEME_MODES, type ThemeMode, useThemeStore } from "../theme/theme";
import { AboutSettings } from "./AboutSettings";
import { AccountsSettings, accountsMatch } from "./AccountsSettings";
import { commandMatches, KeyboardSettings, ResetAllShortcuts } from "./KeyboardSettings";
import type { SettingsPageDef } from "./schema";

const MODE_LABELS: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

function ThemeModeControl() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  return (
    <SegmentedControl
      label="Theme mode"
      value={mode}
      options={THEME_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
      onChange={setMode}
    />
  );
}

function SidebarControl() {
  const shown = useUiStore((s) => !s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  return (
    <Switch label="Show sidebar" checked={shown} onChange={(next) => next !== shown && toggle()} />
  );
}

function UndoSendControl() {
  const seconds = useComposeSettings((s) => s.undoSendSeconds);
  const set = useComposeSettings((s) => s.setUndoSendSeconds);
  return (
    <SegmentedControl
      label="Undo send"
      value={String(seconds)}
      options={UNDO_SEND_CHOICES.map((n) => ({
        value: String(n),
        label: n === 0 ? "Off" : `${n} s`,
      }))}
      onChange={(v) => set(Number(v) as UndoSendSeconds)}
    />
  );
}

/**
 * Every settings page, in sidebar order. To add a setting, add a `SettingDef` to a section here;
 * to add a page, add an entry (rows via `sections`, or its own `Component`).
 */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: "appearance",
    title: "Appearance",
    icon: Palette,
    keywords: ["theme", "colors", "look"],
    sections: [
      {
        title: "Theme",
        settings: [
          {
            id: "theme.mode",
            title: "Mode",
            description: "Follow your system, or always use light or dark.",
            keywords: ["dark mode", "light mode", "appearance"],
            Control: ThemeModeControl,
          },
        ],
      },
      {
        title: "Layout",
        settings: [
          {
            id: "layout.sidebar",
            title: "Show sidebar",
            description: "Mailboxes and labels on the left.",
            keywords: ["panel", "hide"],
            Control: SidebarControl,
          },
        ],
      },
    ],
  },
  {
    id: "keyboard",
    title: "Keyboard shortcuts",
    icon: Keyboard,
    keywords: ["keybindings", "hotkeys", "keys"],
    Component: KeyboardSettings,
    matches: (query) => registry.list().some((c) => commandMatches(c, query)),
    HeaderAction: ResetAllShortcuts,
  },
  {
    id: "accounts",
    title: "Accounts",
    icon: Users,
    group: "Mail",
    keywords: [
      "gmail",
      "google",
      "sign in",
      "sign out",
      "remove",
      "add",
      "transfer",
      "credentials",
      "local network",
    ],
    Component: AccountsSettings,
    matches: accountsMatch,
  },
  {
    id: "compose",
    title: "Compose",
    icon: SquarePen,
    group: "Mail",
    keywords: ["write", "send", "reply", "draft"],
    sections: [
      {
        title: "Sending",
        settings: [
          {
            id: "compose.undoSend",
            title: "Undo send",
            description: "How long a sent message waits, so you can take it back.",
            keywords: ["delay", "cancel", "unsend"],
            Control: UndoSendControl,
          },
        ],
      },
    ],
  },
  {
    id: "mods",
    title: "Mods",
    icon: Puzzle,
    group: "App",
    keywords: ["plugins", "extensions", "install", "custom features"],
    Component: ModsSettings,
  },
  {
    id: "about",
    title: "About",
    icon: Info,
    group: "App",
    keywords: [
      "version",
      "updates",
      "check for updates",
      "what's new",
      "changelog",
      "release notes",
    ],
    Component: AboutSettings,
  },
];
