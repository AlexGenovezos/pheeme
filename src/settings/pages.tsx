import { NotificationsSettings } from "./NotificationsSettings";
import { ModsSettings } from "../mods/ModsSettings";
import {
  Bell,
  BookOpen,
  Bot,
  CalendarDays,
  Contact,
  Info,
  Keyboard,
  LayoutList,
  Palette,
  Puzzle,
  SquarePen,
  Users,
} from "lucide-react";
import {
  type DefaultReply,
  UNDO_SEND_CHOICES,
  type UndoSendSeconds,
  useComposeSettings,
} from "../compose/composeSettings";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Switch } from "../components/ui/Switch";
import { registry } from "../keyboard/registry";
import { type ListDensity, type UnreadOnlyScope, useUiStore } from "../store/uiStore";
import {
  SIDEBAR_STYLES,
  type SidebarStyle,
  THEME_MODES,
  type ThemeMode,
  useThemeStore,
} from "../theme/theme";
import { type AccountIndicators, useAccountIndicators } from "../shell/accountIndicators";
import { AboutSettings, WhatsNew } from "./AboutSettings";
import { AccountsSettings, accountsMatch } from "./AccountsSettings";
import { AssistantSettings } from "./AssistantSettings";
import { ClearDownloadedMail } from "./ClearDownloadedMail";
import { ContactsSettings } from "./ContactsSettings";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { InboxTabsSettings } from "./InboxTabsSettings";
import { MailStatsLink } from "./MailStatsLink";
import { GmailQuotaControl } from "./GmailQuotaControl";
import { commandMatches, KeyboardSettings, ResetAllShortcuts } from "./KeyboardSettings";
import { SenderRulesSettings } from "./SenderRulesSettings";
import { SignatureSettings } from "./SignatureSettings";
import {
  CreateThemeControl,
  ImportThemeControl,
  ThemeChoiceControl,
  ThemeFolderControl,
} from "./ThemeSettings";
import { READING_SIZES, type ReadingSize, useReadingSettings } from "./readingSettings";
import {
  OfferControl,
  PausesControl,
  SpeedControl,
  WordSizeControl,
} from "../speedread/SpeedReader";
import type { SettingsPageDef } from "./schema";
import {
  AnimateWeatherControl,
  HomeLocationControl,
  ShowWeatherControl,
  TemperatureUnitControl,
} from "../weather/WeatherControls";
import { OtherZonesControl } from "../calendar/OtherZonesControl";

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
const RailControl = () => <AccountIndicatorControl setting="rail" label="Account rail" />;

function ReadingPaneControl() {
  const shown = useUiStore((s) => s.readingPane);
  const setShown = useUiStore((s) => s.setReadingPane);
  return <Switch label="Show reading pane" checked={shown} onChange={setShown} />;
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

function DefaultReplyControl() {
  const reply = useComposeSettings((s) => s.defaultReply);
  const set = useComposeSettings((s) => s.setDefaultReply);
  return (
    <SegmentedControl
      label="Default reply"
      value={reply}
      options={[
        { value: "reply", label: "Reply" },
        { value: "replyAll", label: "Reply all" },
      ]}
      onChange={(v) => set(v as DefaultReply)}
    />
  );
}

function ConfirmSendControl() {
  const confirm = useComposeSettings((s) => s.confirmSend);
  const set = useComposeSettings((s) => s.setConfirmSend);
  return <Switch label="Confirm before sending" checked={confirm} onChange={set} />;
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
          {
            id: "account.rail",
            title: "Account rail",
            description:
              "Your accounts as icons beside the sidebar, each with its unread count. The sidebar shows the account you pick there.",
            keywords: [
              "accounts",
              "multiple accounts",
              "switcher",
              "switch account",
              "icons",
              "which account",
              "sidebar",
            ],
            Control: RailControl,
          },
        ],
      },
    ],
  },
  {
    id: "reading",
    title: "Reading",
    icon: BookOpen,
    keywords: ["text", "font", "images"],
    sections: [
      {
        title: "Messages",
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
        title: "Speed reader",
        settings: [
          {
            id: "speedReader.offer",
            title: "Offer speed reading",
            description:
              "Show a Speed read button on emails that are mostly plain text, to read them one word at a time.",
            keywords: ["rsvp", "fast", "reader", "words"],
            Control: OfferControl,
          },
          {
            id: "speedReader.wpm",
            title: "Speed",
            description: "Words per minute. You can also change it while reading.",
            keywords: ["wpm", "words per minute", "fast", "slow", "speed reader"],
            Control: SpeedControl,
          },
          {
            id: "speedReader.pauses",
            title: "Pause at punctuation",
            description: "Linger a moment at commas, the ends of sentences and new paragraphs.",
            keywords: ["speed reader", "commas", "sentences"],
            Control: PausesControl,
          },
          {
            id: "speedReader.size",
            title: "Word size",
            description: "How big each word shows in the speed reader.",
            keywords: ["speed reader", "font", "larger"],
            Control: WordSizeControl,
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
      "quota",
      "rate limit",
      "usage",
    ],
    sections: [
      { id: "accounts", Component: AccountsSettings, matches: accountsMatch },
      {
        title: "Sync",
        settings: [
          {
            id: "sync.gmailQuota",
            title: "Gmail API limit",
            description:
              "Units per minute per user, as shown under Google Cloud Console › Gmail API › Quotas. If you raise it there, enter the new limit here. Pheeme uses up to 80% of it and downloads older mail with at most 40%, so new mail and sending stay quick.",
            keywords: ["throttle", "rate limited", "units per minute", "slow"],
            Control: GmailQuotaControl,
          },
          {
            id: "privacy.clearDownloaded",
            title: "Clear downloaded mail",
            description:
              "Remove the email text and attachments saved on this computer. Your conversation list and labels stay, and an email downloads again when you open it.",
            keywords: ["privacy", "cache", "local", "delete", "storage", "disk", "attachments"],
            Control: ClearDownloadedMail,
          },
        ],
      },
    ],
  },
  {
    id: "inbox",
    title: "Inbox",
    icon: LayoutList,
    group: "Mail",
    keywords: ["categories", "tabs", "primary", "social", "promotions", "updates", "forums"],
    sections: [
      { id: "inboxTabs", Component: InboxTabsSettings, matches: accountsMatch },
      {
        id: "senderRules",
        Component: SenderRulesSettings,
        keywords: ["sender rules", "filters", "future mail", "sender"],
        matches: accountsMatch,
      },
      {
        id: "mailStats",
        Component: MailStatsLink,
        keywords: [
          "mail stats",
          "statistics",
          "insights",
          "how much mail",
          "per day",
          "received",
          "opened",
          "replied",
          "starred",
          "engagement",
          "senders",
          "unsubscribe",
          "newsletters",
          "labels",
        ],
      },
    ],
  },
  {
    id: "compose",
    title: "Compose",
    icon: SquarePen,
    group: "Mail",
    keywords: ["write", "send", "reply", "draft"],
    sections: [
      {
        title: "Replies",
        settings: [
          {
            id: "compose.defaultReply",
            title: "Default reply",
            description: "Which reply button comes first, and stands out, above a conversation.",
            keywords: ["reply all", "button", "toolbar"],
            Control: DefaultReplyControl,
          },
        ],
      },
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
          {
            id: "compose.confirmSend",
            title: "Confirm before sending",
            description: "Ask before each message leaves, in addition to Undo send.",
            keywords: ["prompt", "ask", "send", "accidental"],
            Control: ConfirmSendControl,
          },
        ],
      },
      {
        id: "signatures",
        Component: SignatureSettings,
        keywords: ["signatures", "sign off", "footer", "forward", "new message"],
        matches: accountsMatch,
      },
    ],
  },
  {
    id: "contacts",
    title: "Contacts",
    icon: Contact,
    group: "Mail",
    keywords: [
      "autocomplete",
      "suggestions",
      "recipients",
      "to",
      "google contacts",
      "people api",
      "address book",
    ],
    Component: ContactsSettings,
  },
  {
    id: "calendar",
    title: "Calendar",
    icon: CalendarDays,
    group: "Calendar",
    keywords: ["weather", "forecast", "temperature", "time zones"],
    sections: [
      {
        title: "Time zones",
        settings: [
          {
            id: "calendar.otherZones",
            title: "Other time zones",
            description:
              "Up to two. Day and Week show their hours beside your calendar's, and an event's popover shows its time in each. A short label replaces the zone's name over its hours. To convert a time, type it in the command palette, like “3pm PT in Athens”.",
            keywords: [
              "timezone",
              "world clock",
              "second",
              "travel",
              "convert",
              "converter",
              "city",
            ],
            Control: OtherZonesControl,
          },
        ],
      },
      {
        title: "Weather",
        settings: [
          {
            id: "weather.show",
            title: "Show weather",
            description:
              "The forecast at the top of each day, and for an event's place when you open it. To get it, Pheeme sends your home location and those places to Open-Meteo (open-meteo.com), and nothing else. Weather data by Open-Meteo.com, CC BY 4.0.",
            keywords: ["forecast", "open-meteo", "privacy", "location"],
            Control: ShowWeatherControl,
          },
          {
            id: "weather.home",
            title: "Home location",
            description:
              "The town whose forecast the days show. Type it, or find it from your calendar's time zone.",
            keywords: ["weather", "city", "town", "location", "detect"],
            Control: HomeLocationControl,
          },
          {
            id: "weather.unit",
            title: "Temperature",
            keywords: ["weather", "fahrenheit", "celsius", "units"],
            Control: TemperatureUnitControl,
          },
          {
            id: "weather.animate",
            title: "Animate weather",
            description:
              "The drawings move in an event's popover, and on the day you point at. Off, they hold still. Reduce motion in your system settings holds them still too.",
            keywords: ["weather", "animation", "motion", "moving", "still"],
            Control: AnimateWeatherControl,
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
    keywords: [
      "alerts",
      "primary",
      "unread",
      "tray",
      "background",
      "sound",
      "focus",
      "calendar",
      "event",
      "reminders",
    ],
    Component: NotificationsSettings,
    matches: accountsMatch,
  },
  {
    id: "mcp",
    title: "MCP",
    icon: Bot,
    group: "App",
    keywords: [
      "ai",
      "assistants",
      "audit",
      "activity",
      "mcp",
      "claude",
      "claude code",
      "agent",
      "llm",
      "chatgpt",
      "token",
      "automation",
      "calendar",
      "events",
      "tasks",
    ],
    Component: AssistantSettings,
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
      "diagnostics",
      "logs",
      "support",
      "help",
    ],
    sections: [
      { id: "about", Component: AboutSettings },
      {
        id: "diagnostics",
        Component: DiagnosticsSection,
        keywords: [
          "send diagnostics",
          "report",
          "problem",
          "slow",
          "bug",
          "usage stats",
          "telemetry",
          "ping",
        ],
      },
      { id: "whatsNew", Component: WhatsNew },
    ],
  },
];
