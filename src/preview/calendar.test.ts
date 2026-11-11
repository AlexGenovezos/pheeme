import { describe, expect, test } from "vitest";
import type {
  CalendarAccess,
  CalendarAccount,
  CalendarEvent,
  EventDetail,
  EventRef,
} from "../lib/tauri";
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

  test("create then edit then delete round-trips in the preview", async () => {
    const handlers = createCalendarHandlers(ACCOUNTS, null, NOW);
    const calendarId = "avery@example.com";
    const ref = (await handlers.create_calendar_event({
      accountId: "acc-personal",
      calendarId,
      edit: {
        summary: "Coffee",
        start: { ms: weekStart + DAY + 9 * 3_600_000 },
        end: { ms: weekStart + DAY + 10 * 3_600_000 },
      },
      sendUpdates: "none",
    })) as EventRef;
    expect(weekEvents(handlers).find((e) => e.id === ref.id)?.summary).toBe("Coffee");

    await handlers.update_calendar_event({
      ...ref,
      accountId: ref.accountId,
      eventId: ref.id,
      scope: "all",
      edit: { summary: "Coffee chat", location: "Cafe" },
      sendUpdates: "none",
    });
    const edited = weekEvents(handlers).find((e) => e.id === ref.id);
    expect(edited?.summary).toBe("Coffee chat");
    expect(edited?.location).toBe("Cafe");
    const detail = (await handlers.calendar_event_detail({
      accountId: ref.accountId,
      calendarId: ref.calendarId,
      eventId: ref.id,
    })) as EventDetail;
    expect(detail.canEdit).toBe(true);

    await handlers.delete_calendar_event({
      accountId: ref.accountId,
      calendarId: ref.calendarId,
      eventId: ref.id,
      scope: "this",
      sendUpdates: "none",
    });
    expect(weekEvents(handlers).some((e) => e.id === ref.id)).toBe(false);
  });

  test("rsvp on the design review invite marks it accepted", async () => {
    const handlers = createCalendarHandlers(ACCOUNTS, null, NOW);
    const invite = weekEvents(handlers).find((e) => e.id === "design-review")!;
    expect(invite.selfResponse).toBe("needsAction");
    await handlers.respond_to_calendar_event({
      accountId: invite.accountId,
      calendarId: invite.calendarId,
      eventId: invite.id,
      scope: "this",
      response: "accepted",
      comment: null,
    });
    expect(weekEvents(handlers).find((e) => e.id === "design-review")?.selfResponse).toBe(
      "accepted",
    );
  });

  test("editing an organizer-owned guest event rejects with read_only", async () => {
    const handlers = createCalendarHandlers(ACCOUNTS, null, NOW);
    const invite = weekEvents(handlers).find((e) => e.id === "design-review")!;
    await expect(
      Promise.resolve().then(() =>
        handlers.update_calendar_event({
          accountId: invite.accountId,
          calendarId: invite.calendarId,
          eventId: invite.id,
          scope: "all",
          edit: { summary: "Renamed" },
          sendUpdates: "none",
        }),
      ),
    ).rejects.toEqual({
      code: "read_only",
      message: "Only the organizer can change this event.",
    });
    expect(weekEvents(handlers).find((e) => e.id === "design-review")?.summary).toBe(
      "Design review",
    );
  });
});
