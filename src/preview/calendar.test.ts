import { describe, expect, test } from "vitest";
import type { CalendarAccess, CalendarAccount, CalendarEvent } from "../lib/tauri";
import { createCalendarHandlers } from "./calendar";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();
const DAY = 86_400_000;
const weekStart = new Date(2026, 10, 8).getTime();

function weekEvents(handlers: ReturnType<typeof createCalendarHandlers>): CalendarEvent[] {
  return handlers.calendar_events({
    fromMs: weekStart,
    toMs: weekStart + 7 * DAY,
    timeZone: "UTC",
  }) as CalendarEvent[];
}

const startOf = (e: CalendarEvent) => e.start.ms ?? Date.parse(`${e.start.date}T00:00:00`);

describe("calendar preview", () => {
  test("the fixture week has a sorted mix with an unanswered invite that clashes", () => {
    const events = weekEvents(createCalendarHandlers(ACCOUNTS, null, NOW));
    const starts = events.map(startOf);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));

    const invite = events.find((e) => e.selfResponse === "needsAction");
    expect(invite).toBeDefined();
    const clash = events.find(
      (e) =>
        e !== invite &&
        e.start.ms !== null &&
        e.start.ms < invite!.end.ms! &&
        e.end.ms! > invite!.start.ms!,
    );
    expect(clash).toBeDefined();
    expect(events.some((e) => e.allDay)).toBe(true);
    expect(events.some((e) => e.recurring)).toBe(true);
    expect(events.some((e) => e.selfResponse === "declined")).toBe(true);
    expect(new Set(events.map((e) => e.accountId)).size).toBe(2);
  });

  test("hiding a calendar removes its events", () => {
    const handlers = createCalendarHandlers(ACCOUNTS, null, NOW);
    const before = weekEvents(handlers);
    const team = before.find((e) => e.calendarId === "team");
    expect(team).toBeDefined();

    handlers.set_calendar_hidden({ accountId: team!.accountId, calendarId: "team", hidden: true });

    expect(weekEvents(handlers).some((e) => e.calendarId === "team")).toBe(false);
    const accounts = handlers.calendar_accounts() as CalendarAccount[];
    const hidden = accounts.flatMap((a) => a.calendars).find((c) => c.id === "team");
    expect(hidden?.hidden).toBe(true);
  });

  test("?calendar= sets the second account's access", () => {
    const handlers = createCalendarHandlers(ACCOUNTS, "missing_scope", NOW);
    const accounts = handlers.calendar_accounts() as CalendarAccount[];
    expect(accounts[0].access.status).toBe("on");
    expect(accounts[1].access.status).toBe("missing_scope");
    expect(accounts[1].calendars).toEqual([]);
    expect(weekEvents(handlers).every((e) => e.accountId === "acc-personal")).toBe(true);

    const disabled = createCalendarHandlers(ACCOUNTS, "api_disabled", NOW);
    const access = disabled.calendar_sync_now({ accountId: "acc-work" }) as CalendarAccess;
    expect(access.status).toBe("on");
  });
});
