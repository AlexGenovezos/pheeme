import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { Palette } from "lucide-react";
import { useAccountIndicators, type AccountIndicators } from "../../shell/accountIndicators";
import { type ListDensity, type UnreadOnlyScope, useUiStore } from "../../store/uiStore";
import {
  SIDEBAR_STYLES,
  type SidebarStyle,
  THEME_MODES,
  type ThemeMode,
  useThemeStore,
} from "../../theme/theme";
import type { SettingsPageDef } from "../schema";
import {
  CreateThemeControl,
  ImportThemeControl,
  ThemeChoiceControl,
  ThemeFolderControl,
} from "../ThemeSettings";

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

const SIDEBAR_STYLE_LABELS: Record<SidebarStyle, string> = {
  light: "Light",
  tinted: "Tinted",
  ink: "Ink",
  dark: "Dark",
};

function SidebarStyleControl() {
  const style = useThemeStore((s) => s.sidebarStyle);
  const setStyle = useThemeStore((s) => s.setSidebarStyle);
  return (
    <SegmentedControl
      label="Sidebar color"
      value={style}
      options={SIDEBAR_STYLES.map((s) => ({ value: s, label: SIDEBAR_STYLE_LABELS[s] }))}
      onChange={setStyle}
    />
  );
}

const LightThemeControl = () => <ThemeChoiceControl kind="light" />;
const DarkThemeControl = () => <ThemeChoiceControl kind="dark" />;

function SidebarControl() {
  // The preference, not whether it's on screen now: with no room it hides either way.
  const shown = useUiStore((s) => !s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  return <Switch label="Show sidebar" checked={shown} onChange={(next) => setCollapsed(!next)} />;
}

function AccountIndicatorControl({
  setting,
  label,
}: {
  setting: keyof AccountIndicators;
  label: string;
}) {
  const on = useAccountIndicators((s) => s[setting]);
  const set = useAccountIndicators((s) => s.set);
  return <Switch label={label} checked={on} onChange={(next) => set(setting, next)} />;
}
const GlowControl = () => (
  <AccountIndicatorControl setting="glow" label="Glow around the account you're in" />
);
const WindowColorControl = () => (
  <AccountIndicatorControl setting="windowColor" label="Account color across the window" />
);

function ReadingPaneControl() {
  const shown = useUiStore((s) => s.readingPane);
  const setShown = useUiStore((s) => s.setReadingPane);
  return <Switch label="Show reading pane" checked={shown} onChange={setShown} />;
}

function ListDensityControl() {
  const density = useUiStore((s) => s.listDensity);
  const setDensity = useUiStore((s) => s.setListDensity);
  return (
    <SegmentedControl
      label="List density"
      value={density}
      options={[
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ]}
      onChange={(value) => setDensity(value as ListDensity)}
    />
  );
}

function UnreadOnlyScopeControl() {
  const scope = useUiStore((s) => s.unreadOnlyScope);
  const setScope = useUiStore((s) => s.setUnreadOnlyScope);
  return (
    <SegmentedControl
      label="Unread only applies to"
      value={scope}
      options={[
        { value: "every", label: "Every mailbox" },
        { value: "each", label: "Each mailbox" },
      ]}
      onChange={(value) => setScope(value as UnreadOnlyScope)}
    />
  );
}

export const APPEARANCE_PAGE: SettingsPageDef = {
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
        {
          id: "theme.light",
          title: "Light theme",
          description:
            "Used in Light mode, and in System mode when your system is light. Any theme fits, even a dark one.",
          keywords: ["color scheme", "custom theme", "edit theme", "customize"],
          Control: LightThemeControl,
        },
        {
          id: "theme.dark",
          title: "Dark theme",
          description:
            "Used in Dark mode, and in System mode when your system is dark. Any theme fits, even a light one.",
          keywords: ["color scheme", "custom theme", "edit theme", "customize"],
          Control: DarkThemeControl,
        },
        {
          id: "theme.sidebar",
          title: "Sidebar color",
          description:
            "With Pheeme Light: pale grey, a pale blue wash, deep ink blue or dark. Other themes bring their own sidebar.",
          keywords: ["sidebar", "dark sidebar", "left bar", "background", "ink", "tinted"],
          Control: SidebarStyleControl,
        },
        {
          id: "theme.create",
          title: "Create a theme",
          description:
            "Pick a background and an accent and Pheeme builds the rest, or set every color yourself. Changes show live as you edit.",
          keywords: ["theme editor", "color picker", "customize", "custom theme", "colors"],
          Control: CreateThemeControl,
        },
        {
          id: "theme.import",
          title: "Import a theme",
          description:
            "Add a VS Code color theme, a T3 Code theme or a Pheeme theme file (.json). Pheeme adjusts imported colors so text stays readable.",
          keywords: [
            "vs code",
            "vscode",
            "t3",
            "t3 code",
            "custom theme",
            "color scheme",
            "install",
          ],
          Control: ImportThemeControl,
        },
        {
          id: "theme.folder",
          title: "Themes folder",
          description:
            "Theme files in this folder can be chosen above, and stay in step with the files. Copy in the themes from T3 Code's ~/.t3/userdata/themes to use them here.",
          keywords: ["t3", "t3 code", "folder", "directory", "custom theme"],
          Control: ThemeFolderControl,
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
        {
          id: "layout.readingPane",
          title: "Show reading pane",
          description: "Off: conversations open in place of the list. Press U or Back to return.",
          keywords: ["preview pane", "split", "hide", "single column", "full width"],
          Control: ReadingPaneControl,
        },
        {
          id: "layout.listDensity",
          title: "List density",
          description: "Compact rows leave out the preview line, so more conversations fit.",
          keywords: ["compact", "comfortable", "rows", "snippet", "preview", "spacing"],
          Control: ListDensityControl,
        },
        {
          id: "layout.unreadOnlyScope",
          title: "Unread only applies to",
          description:
            "Each mailbox: every mailbox and Inbox tab remembers its own Unread only, so Primary can show everything while Promotions shows only unread.",
          keywords: [
            "unread",
            "filter",
            "per tab",
            "per mailbox",
            "global",
            "primary",
            "promotions",
            "updates",
            "categories",
          ],
          Control: UnreadOnlyScopeControl,
        },
      ],
    },
    {
      title: "Current account",
      settings: [
        {
          id: "account.glow",
          title: "Glow around the account you're in",
          description:
            "With more than one account, the account whose mail is open glows in its color in the sidebar.",
          keywords: ["accounts", "multiple accounts", "highlight", "which account", "sidebar"],
          Control: GlowControl,
        },
        {
          id: "account.windowColor",
          title: "Account color across the window",
          description:
            "A stripe of the account's color along the top of the window, and a tint behind the list's title.",
          keywords: ["accounts", "multiple accounts", "color", "stripe", "which account", "tint"],
          Control: WindowColorControl,
        },
      ],
    },
  ],
};
