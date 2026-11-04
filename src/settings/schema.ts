import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Settings are data: a page lists sections, a section lists settings, and the dialog draws the
 * rows and searches their words. Adding a setting means adding one `SettingDef` to a section in
 * `pages.tsx`; nothing else changes.
 */
export interface SettingDef {
  id: string;
  title: string;
  description?: string;
  /** Extra words search matches on. */
  keywords?: string[];
  /** The control on the right of the row. */
  Control: ComponentType;
}

export interface SettingsSectionDef {
  title: string;
  settings: SettingDef[];
}

export interface SettingsPageDef {
  /** An installed mod rendered through the public declarative controls. */
  modId?: string;
  id: string;
  title: string;
  icon: LucideIcon;
  /** Sidebar heading the page sits under; pages without one go at the top. */
  group?: string;
  keywords?: string[];
  /** A page made of setting rows. */
  sections?: SettingsSectionDef[];
  /** A page that draws itself (Accounts, Keyboard). Gets the search query to filter by. */
  Component?: ComponentType<{ query: string }>;
  /** For `Component` pages: whether the query finds anything on the page. */
  matches?(query: string): boolean;
  /** A button for the dialog header while this page shows (e.g. "Reset all shortcuts"). */
  HeaderAction?: ComponentType;
}

const words = (...parts: Array<string | undefined | string[]>) =>
  parts.flat().filter(Boolean).join(" ").toLowerCase();

/** Every query word appears somewhere in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function settingMatches(setting: SettingDef, query: string): boolean {
  return matchesQuery(words(setting.title, setting.description, setting.keywords), query);
}

export function pageTitleMatches(page: SettingsPageDef, query: string): boolean {
  return matchesQuery(words(page.title, page.keywords), query);
}

/** Whether a search for `query` should list the page. */
export function pageMatches(page: SettingsPageDef, query: string): boolean {
  if (!query.trim() || pageTitleMatches(page, query)) return true;
  if (page.matches?.(query)) return true;
  return (page.sections ?? []).some((s) => s.settings.some((x) => settingMatches(x, query)));
}
