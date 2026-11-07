import { NotificationsSettings } from "./NotificationsSettings";
import { ModsSettings } from "../mods/ModsSettings";
import {
  Bell,
  Info,
  Keyboard,
  LifeBuoy,
  Palette,
  Puzzle,
  RefreshCw,
  SquarePen,
  Users,
} from "lucide-react";
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
import { DiagnosticsSection } from "./DiagnosticsSection";
import { GmailQuotaControl } from "./GmailQuotaControl";
import { commandMatches, KeyboardSettings, ResetAllShortcuts } from "./KeyboardSettings";
import { READING_SIZES, type ReadingSize, useReadingSettings } from "./readingSettings";
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

function PreloadImagesControl() {
  const checked = useReadingSettings((s) => s.preloadImages);
  const onChange = useReadingSettings((s) => s.setPreloadImages);
  return <Switch label="Preload images" checked={checked} onChange={onChange} />;
}

function ReadingSizeControl() {
  const size = useReadingSettings((s) => s.size);
  const setSize = useReadingSettings((s) => s.setSize);
  return (
    <SegmentedControl
      label="Reading text size"
      value={size}
      options={READING_SIZES.map((value) => ({
        value,
        label: value === "large" ? "Large" : "Standard",
      }))}
      onChange={(value) => setSize(value as ReadingSize)}
    />
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
        title: "Reading",
        settings: [
          {
            id: "reading.size",
            title: "Text size",
            description: "For plain-text messages and the messages you write.",
            keywords: ["font", "larger", "accessibility", "compose", "zoom"],
            Control: ReadingSizeControl,
          },
          {
            id: "reading.preloadImages",
            title: "Preload images",
            description:
              "Preloading images lets senders see that an email was opened, along with your IP address and approximate location, even for emails you skip. Turning it off keeps text preloading, and loads images only when you open an email.",
            keywords: ["privacy", "images", "tracking"],
            Control: PreloadImagesControl,
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
      "sync",
      "progress",
      "download",
      "offline",
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
    id: "sync",
    title: "Sync",
    icon: RefreshCw,
    group: "Mail",
    keywords: ["gmail", "api", "quota", "rate limit", "speed", "google cloud"],
    sections: [
      {
        title: "Gmail API",
        settings: [
          {
            id: "sync.gmailQuota",
            title: "Gmail API limit",
            description:
              "Units per minute per user, as shown under Google Cloud Console › Gmail API › Quotas. If you raise it there, enter the new limit here. Pheeme uses up to 80% of it and downloads older mail with at most 40%, so new mail and sending stay quick.",
            keywords: ["throttle", "rate limited", "units per minute", "slow"],
            Control: GmailQuotaControl,
          },
        ],
      },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: Bell,
    group: "App",
    keywords: ["alerts", "primary", "unread", "tray", "background", "sound", "focus"],
    Component: NotificationsSettings,
    matches: accountsMatch,
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
    id: "diagnostics",
    title: "Diagnostics",
    icon: LifeBuoy,
    group: "App",
    keywords: ["logs", "support", "send", "report", "problem", "slow", "bug", "help"],
    Component: DiagnosticsSection,
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
