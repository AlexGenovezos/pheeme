import type { SettingsPageDef } from "./schema";
import { ABOUT_PAGE, MCP_PAGE, MODS_PAGE, NOTIFICATIONS_PAGE } from "./pages/app";
import { APPEARANCE_PAGE } from "./pages/appearance";
import { CALENDAR_PAGE } from "./pages/calendar";
import { KEYBOARD_PAGE } from "./pages/keyboard";
import { ACCOUNTS_PAGE, COMPOSE_PAGE, CONTACTS_PAGE, INBOX_PAGE } from "./pages/mail";
import { READING_PAGE } from "./pages/reading";

/**
 * Every settings page, in sidebar order. To add a setting, add a `SettingDef` to a section of its
 * page under `pages/`; to add a page, add one there (rows via `sections`, or its own `Component`)
 * and list it here.
 */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  APPEARANCE_PAGE,
  READING_PAGE,
  KEYBOARD_PAGE,
  ACCOUNTS_PAGE,
  INBOX_PAGE,
  COMPOSE_PAGE,
  CONTACTS_PAGE,
  CALENDAR_PAGE,
  NOTIFICATIONS_PAGE,
  MCP_PAGE,
  MODS_PAGE,
  ABOUT_PAGE,
];
