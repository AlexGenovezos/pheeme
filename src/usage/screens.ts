// Which screens are showing, worked out from the stores, as fixed names for the anonymous usage
// report. A name never carries user content: a user label is `mail.label`, a mod's settings page
// `settings.mod`.

import type { AppMode } from "../calendar/calendarStore";
import type { CalendarView } from "../calendar/views";
import type { MailboxRef } from "../mail/mailboxes";

export interface ScreenState {
  mode: AppMode;
  view: CalendarView;
  mailbox: MailboxRef;
  searchText: string;
  conversationOpen: boolean;
  eventOpen: boolean;
  eventEditorOpen: boolean;
  emailPinned: boolean;
  /** The open Settings page, or null when Settings is closed. */
  settingsPage: string | null;
  statsOpen: boolean;
  paletteOpen: boolean;
  composing: boolean;
  previewOpen: boolean;
  personOpen: boolean;
  speedReading: boolean;
  tasksOpen: boolean;
  themeEditorOpen: boolean;
}

/** Gmail's system labels by the name they're counted under. */
const SYSTEM_MAILBOXES: Record<string, string> = {
  INBOX: "inbox",
  STARRED: "starred",
  DRAFT: "drafts",
  SENT: "sent",
  ALL: "all",
  SPAM: "spam",
  TRASH: "trash",
  IMPORTANT: "important",
  SNOOZED: "snoozed",
  CHAT: "chats",
  SCHEDULED: "scheduled",
};

export function mailboxScreen(mailbox: MailboxRef, searchText: string): string {
  if (searchText.trim()) return "mail.search";
  if (mailbox.category) return "mail.inbox";
  const system = SYSTEM_MAILBOXES[mailbox.labelId];
  return system ? `mail.${system}` : "mail.label";
}

export function settingsScreen(page: string): string {
  return /^[a-z0-9-]+$/i.test(page) ? `settings.${page.toLowerCase()}` : "settings.mod";
}

export function currentScreens(s: ScreenState): string[] {
  const screens: string[] = [];
  if (s.mode === "calendar") {
    screens.push(`calendar.${s.view}`);
    if (s.eventOpen) screens.push("calendar.event");
    if (s.eventEditorOpen) screens.push("calendar.editor");
    if (s.emailPinned) screens.push("calendar.pinned");
  } else {
    screens.push(mailboxScreen(s.mailbox, s.searchText));
    if (s.conversationOpen) screens.push("mail.conversation");
  }
  if (s.settingsPage !== null) screens.push(settingsScreen(s.settingsPage));
  if (s.statsOpen) screens.push("stats");
  if (s.paletteOpen) screens.push("palette");
  if (s.composing) screens.push("compose");
  if (s.previewOpen) screens.push("preview");
  if (s.personOpen) screens.push("person");
  if (s.speedReading) screens.push("speedread");
  if (s.tasksOpen) screens.push("tasks");
  if (s.themeEditorOpen) screens.push("theme-editor");
  return screens;
}
