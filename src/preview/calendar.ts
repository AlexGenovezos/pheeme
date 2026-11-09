/** Calendar for browser preview: two accounts' calendars and a busy week around today (`src-tauri/src/calendar/` in the app). */

import { emit } from "@tauri-apps/api/event";
import {
  CALENDAR_EVENTS,
  type CalendarAccess,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarInfo,
} from "../lib/tauri";

type Args = Record<string, unknown> | undefined;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function calendar(id: string, summary: string, color: string, primary = false): CalendarInfo {
  return {
    id,
    summary,
    backgroundColor: color,
    foregroundColor: "#000000",
    accessRole: id.includes("holiday") ? "reader" : "owner",
    primary,
    hidden: false,
  };
}

/**
 * `access`: the second account's calendar access (`?calendar=missing_scope`, `api_disabled`,
 * `unknown` or `error`; `on` by default). `now` anchors the fixture week.
 */
export function createCalendarHandlers(
  accounts: { id: string; email: string }[],
  access: string | null,
  now = Date.now(),
) {
  const statuses = new Map<string, CalendarAccess["status"]>(
    accounts.map((a, i) => [a.id, (i === 1 && access ? access : "on") as CalendarAccess["status"]]),
  );
  const [first, second] = accounts;
  const calendars = new Map<string, CalendarInfo[]>();
  if (first)
    calendars.set(first.id, [
      calendar(first.email, first.email, "#9fe1e7", true),
      calendar("team", "Team", "#f691b2"),
      calendar("en.usa#holiday@group.v.calendar.google.com", "Holidays", "#16a765"),
    ]);
  if (second) calendars.set(second.id, [calendar(second.email, second.email, "#fbe983", true)]);

  // Monday of the week containing `now`, local midnight.
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const at = (dayOffset: number, hour: number, minute = 0) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  const dateAt = (dayOffset: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    return isoDate(d);
  };

  const base = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
  ): CalendarEvent => ({
    accountId: account.id,
    calendarId,
    id,
    masterId: null,
    summary,
    start: { ms: null, date: null, timeZone: null },
    end: { ms: null, date: null, timeZone: null },
    allDay: false,
    status: "confirmed",
    selfResponse: null,
    location: null,
    hasConference: false,
    colorId: null,
    transparency: null,
    recurring: false,
  });
  const timed = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
    start: number,
    end: number,
    extra: Partial<CalendarEvent> = {},
  ): CalendarEvent => ({
    ...base(account, calendarId, id, summary),
    start: { ms: start, date: null, timeZone: "America/New_York" },
    end: { ms: end, date: null, timeZone: "America/New_York" },
    ...extra,
  });
  const allDay = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
    fromDay: number,
    days: number,
  ): CalendarEvent => ({
    ...base(account, calendarId, id, summary),
    start: { ms: null, date: dateAt(fromDay), timeZone: null },
    end: { ms: null, date: dateAt(fromDay + days), timeZone: null },
    allDay: true,
    transparency: "transparent",
  });

  const events: CalendarEvent[] = [];
  if (first) {
    const primary = first.email;
    // A weekly Monday standup; this week's was moved to Tuesday.
    for (let week = -8; week <= 8; week++) {
      const start = at(week * 7, 9);
      const date = dateAt(week * 7).replace(/-/g, "");
      const occurrence = {
        masterId: "standup",
        recurring: true,
        hasConference: true,
        selfResponse: "accepted",
      };
      if (week === 0)
        events.push(
          timed(first, primary, `standup_${date}`, "Standup (moved)", at(1, 10), at(1, 10, 15), {
            ...occurrence,
          }),
        );
      else
        events.push(
          timed(
            first,
            primary,
            `standup_${date}`,
            "Standup",
            start,
            start + 15 * 60_000,
            occurrence,
          ),
        );
    }
    events.push(
      timed(first, primary, "lunch", "Lunch with Dana", at(3, 12), at(3, 13), {
        location: "Tartine",
      }),
      timed(first, primary, "vendor", "Vendor demo", at(1, 16), at(1, 17), {
        selfResponse: "declined",
        hasConference: true,
      }),
      timed(first, "team", "planning", "Team planning", at(2, 11), at(2, 12)),
      allDay(first, "en.usa#holiday@group.v.calendar.google.com", "holiday", "Veterans Day", 3, 1),
    );
  }
  if (second) {
    const primary = second.email;
    events.push(
      timed(second, primary, "design-review", "Design review", at(3, 14), at(3, 15), {
        selfResponse: "needsAction",
        hasConference: true,
        location: "Google Meet",
      }),
      timed(second, primary, "one-on-one", "1:1 Alex", at(3, 14, 30), at(3, 15, 30), {
        selfResponse: "accepted",
      }),
      allDay(second, primary, "summit", "Design Summit", 2, 3),
    );
  }

  const shown = (e: CalendarEvent) =>
    statuses.get(e.accountId) === "on" &&
    !calendars.get(e.accountId)?.find((c) => c.id === e.calendarId)?.hidden;
  const startKey = (e: CalendarEvent) => e.start.ms ?? Date.parse(`${e.start.date}T00:00:00`);
  const endKey = (e: CalendarEvent) => e.end.ms ?? Date.parse(`${e.end.date}T00:00:00`);
  const accessOf = (accountId: string): CalendarAccess => {
    const status = statuses.get(accountId) ?? "unknown";
    return {
      status,
      message: status === "error" ? "Calendar API error 500: Backend Error" : null,
      enableUrl:
        status === "api_disabled"
          ? "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
          : null,
      syncedAt: status === "on" ? now - 60_000 : null,
    };
  };

  return {
    calendar_accounts: (): CalendarAccount[] =>
      accounts.map((a) => {
        const on = statuses.get(a.id) === "on";
        return {
          accountId: a.id,
          email: a.email,
          access: accessOf(a.id),
          timeZone: on ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
          weekStart: on ? 0 : null,
          calendars: on ? (calendars.get(a.id) ?? []) : [],
        };
      }),
    calendar_events: (args: Args): CalendarEvent[] => {
      const from = Number(args?.fromMs);
      const to = Number(args?.toMs);
      return events
        .filter((e) => shown(e) && startKey(e) < to && endKey(e) > from)
        .sort(
          (a, b) =>
            startKey(a) - startKey(b) ||
            Number(b.allDay) - Number(a.allDay) ||
            a.id.localeCompare(b.id),
        );
    },
    set_calendar_hidden: (args: Args) => {
      const accountId = String(args?.accountId);
      const cal = calendars.get(accountId)?.find((c) => c.id === String(args?.calendarId));
      if (cal) cal.hidden = Boolean(args?.hidden);
      void emit(CALENDAR_EVENTS.updated, { accountId }).catch(() => {});
    },
    calendar_sync_now: (args: Args): CalendarAccess => {
      const accountId = String(args?.accountId);
      // After turning the API on (or allowing access), checking again works.
      statuses.set(accountId, "on");
      void emit(CALENDAR_EVENTS.access, { accountId, status: "on" }).catch(() => {});
      return accessOf(accountId);
    },
    set_calendar_foreground: () => undefined,
  };
}
