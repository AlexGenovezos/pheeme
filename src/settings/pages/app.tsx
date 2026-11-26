import { Bell, Bot, Info, Puzzle } from "lucide-react";
import { ModsSettings } from "../../mods/ModsSettings";
import { AboutSettings, WhatsNew } from "../AboutSettings";
import { accountsMatch } from "../AccountsSettings";
import { AssistantSettings } from "../AssistantSettings";
import { DiagnosticsSection } from "../DiagnosticsSection";
import { NotificationsSettings } from "../NotificationsSettings";
import type { SettingsPageDef } from "../schema";

export const NOTIFICATIONS_PAGE: SettingsPageDef = {
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
};

export const MCP_PAGE: SettingsPageDef = {
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
};

export const MODS_PAGE: SettingsPageDef = {
  id: "mods",
  title: "Mods",
  icon: Puzzle,
  group: "App",
  keywords: ["plugins", "extensions", "install", "custom features"],
  Component: ModsSettings,
};

export const ABOUT_PAGE: SettingsPageDef = {
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
};
