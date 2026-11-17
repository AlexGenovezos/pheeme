import { call } from "./call";

/** Whether an account allowed calendar access, and how its last calendar sync went. */
export interface CalendarAccess {
  /** `unknown` (never allowed), `on`, `missing_scope` (allow calendar access), `api_disabled` (turn on the Calendar API) or `error`. */
  status: "unknown" | "on" | "missing_scope" | "api_disabled" | "error";
  /** What failed, for `error`. */
  message: string | null;
  /** The Calendar API page for the user's Google Cloud project, for `api_disabled`. */
  enableUrl: string | null;
  syncedAt: number | null;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  /** `owner`, `writer`, `reader` or `freeBusyReader`. */
  accessRole: string;
  primary: boolean;
  /** Unticked in the sidebar (local only). */
  hidden: boolean;
}

export interface CalendarAccount {
  accountId: string;
  email: string;
  access: CalendarAccess;
  /** The user's Google Calendar time zone. */
  timeZone: string | null;
  /** 0 Sunday, 1 Monday, 6 Saturday. */
  weekStart: number | null;
  calendars: CalendarInfo[];
}

/** A start or end: `ms` (UTC) for timed events, `date` (`YYYY-MM-DD`, end exclusive) for all-day ones. */
export interface EventTime {
  ms: number | null;
  date: string | null;
  timeZone: string | null;
}

/** A link that joins a video call. */
export interface MeetingLink {
  url: string;
  /** "Google Meet", "Zoom", "Microsoft Teams", "Webex", …; null for a conference from a provider Pheeme doesn't list. */
  provider: string | null;
}

/** Joins a video call: opens its link in the default browser. */
export const openMeetingLink = (url: string) => call("open_meeting_link", { url });
export interface CalendarEvent {
  accountId: string;
  calendarId: string;
  /** The event's id, or Google's instance id for an occurrence of a series. */
  id: string;
  /** The series this is an occurrence of. */
  masterId: string | null;
  summary: string | null;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  status: string;
  /** `needsAction`, `accepted`, `tentative` or `declined`; null when you aren't a guest. */
  selfResponse: string | null;
  location: string | null;
  hasConference: boolean;
  /** The video call to join (any provider), from the conference, location or description. */
  meeting: MeetingLink | null;
  colorId: string | null;
  /** `transparent` shows as free. */
  transparency: string | null;
  recurring: boolean;
  /** The account may change it (move, resize, edit): a writable calendar, and yours or open to guests. */
  canEdit: boolean;
  /** Google's task block for this task (`https://tasks.google.com/task/<code>`); not editable here. */
  taskLink: string | null;
}

/** Every account with its calendar access, settings and calendars (local). */
export const getCalendarAccounts = () => call("calendar_accounts");
/** Events of shown calendars overlapping `[fromMs, toMs)`, series expanded, sorted by start (local). */
export const getCalendarEvents = (fromMs: number, toMs: number, timeZone: string) =>
  call("calendar_events", { fromMs, toMs, timeZone });
/** Events of shown calendars in `[fromMs, toMs)` whose title, place, description or guests hold every word of `query` (local). */
export const searchCalendarEvents = (
  query: string,
  fromMs: number,
  toMs: number,
  timeZone: string,
) => call("search_calendar_events", { query, fromMs, toMs, timeZone });
/** Show or hide a calendar's events (local). */
export const setCalendarHidden = (accountId: string, calendarId: string, hidden: boolean) =>
  call("set_calendar_hidden", { accountId, calendarId, hidden });
/** Sync the account's calendars now (after allowing access, or "Check again"). */
export const calendarSyncNow = (accountId: string) => call("calendar_sync_now", { accountId });
/** One busy stretch, UTC ms, end exclusive. */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/** What Google could tell about one person: busy time (empty: free), or `unknown` with Google's reason (`notFound`: not shared). */
export type PersonAvailability =
  | { email: string; status: "known"; busy: BusyInterval[] }
  | { email: string; status: "unknown"; reason: string };

export interface AvailabilityResult {
  /** The account itself (its primary calendar). */
  you: PersonAvailability;
  /** One per guest asked about, in order, duplicates dropped. */
  guests: PersonAvailability[];
}

/**
 * When the account and each guest are busy in `[fromMs, toMs)`, asked of Google now (not cached).
 * Rejects with `missing_scope` until the account allows free/busy access (`{ kind: "availability" }`).
 */
export const calendarAvailability = (
  accountId: string,
  emails: string[],
  fromMs: number,
  toMs: number,
) => call("calendar_availability", { accountId, emails, fromMs, toMs });
/** Calendar mode is (or stopped being) in front: calendars are checked every 15 s instead of 60 s. */
export const setCalendarForeground = (on: boolean) => call("set_calendar_foreground", { on });
