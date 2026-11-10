import { describe, expect, test } from "vitest";
import type { EventDetail } from "../lib/tauri";
import { zonedMs } from "./dates";
import {
  describeRule,
  formEdit,
  formFromDetail,
  formProblem,
  formTimes,
  moveStart,
  newForm,
  nthWeekday,
  parseRecurrence,
  reminderFrom,
  repeatChoice,
  repeatPresets,
  ruleLine,
} from "./eventForm";

const TZ = "America/New_York";

function detail(over: Partial<EventDetail> = {}): EventDetail {
  return {
    accountId: "a",
    calendarId: "a@example.com",
    id: "e1",
    masterId: null,
    summary: "Planning",
    start: { ms: zonedMs("2026-11-11", 14 * 60, TZ), date: null, timeZone: TZ },
    end: { ms: zonedMs("2026-11-11", 15 * 60, TZ), date: null, timeZone: TZ },
    allDay: false,
    status: "confirmed",
    selfResponse: null,
    location: "Room 1",
    hasConference: false,
    colorId: null,
    transparency: null,
    recurring: false,
    canEdit: true,
    description: "<p>Agenda</p><p>Goals<br>Hiring</p>",
    organizer: { email: "a@example.com", name: null, isSelf: true },
    attendees: [
      {
        email: "dana@example.com",
        name: "Dana",
        response: "accepted",
        optional: true,
        organizer: false,
        isSelf: false,
        resource: false,
        comment: null,
      },
      {
        email: "room@resource.calendar.google.com",
        name: "Room",
        response: "accepted",
        optional: false,
        organizer: false,
        isSelf: false,
        resource: true,
        comment: null,
      },
    ],
    meetUrl: null,
    conferencePending: false,
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE;TZID=America/New_York:20261118T140000"],
    originalStart: null,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] },
    visibility: null,
    htmlLink: null,
    guestsCanModify: false,
    guestsCanInviteOthers: true,
    guestsCanSeeOtherGuests: true,
    canRsvp: false,
    canDelete: true,
    ...over,
  };
}

describe("the event form", () => {
  test("an existing event fills the form in its own zone, and an untouched form sends nothing", () => {
    const form = formFromDetail(detail(), "Europe/London");
    expect(form).toMatchObject({
      startDate: "2026-11-11",
      startMinutes: 14 * 60,
      endMinutes: 15 * 60,
      startZone: TZ,
      location: "Room 1",
      description: "Agenda\nGoals\nHiring",
      guests: [{ address: "dana@example.com", name: "Dana", optional: true }],
      remindersDefault: false,
      reminders: [{ method: "popup", amount: 1, unit: "days" }],
      extraLines: ["EXDATE;TZID=America/New_York:20261118T140000"],
    });
    expect(form.repeat).toEqual({
      kind: "rule",
      rule: { freq: "WEEKLY", interval: 1, byDay: ["WE"], ends: { kind: "never" } },
    });
    expect(formEdit(form, form)).toEqual({});
  });

  test("a save sends only what changed, keeping the series' exceptions", () => {
    const initial = formFromDetail(detail(), TZ);
    const form = {
      ...initial,
      summary: " Planning v2 ",
      guestsCanModify: true,
      repeat: {
        kind: "rule" as const,
        rule: {
          freq: "WEEKLY" as const,
          interval: 2,
          byDay: ["WE"],
          ends: { kind: "never" as const },
        },
      },
    };
    expect(formEdit(form, initial)).toEqual({
      summary: "Planning v2",
      guestsCanModify: true,
      recurrence: [
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
        "EXDATE;TZID=America/New_York:20261118T140000",
      ],
    });
  });

  test("changing guests keeps booked rooms", () => {
    const initial = formFromDetail(detail(), TZ);
    expect(formEdit({ ...initial, guests: [] }, initial).attendees).toEqual([
      { email: "room@resource.calendar.google.com", optional: false },
    ]);
  });

  test("moving the start keeps the length; times are sent as UTC ms with the zone", () => {
    const form = moveStart(formFromDetail(detail(), TZ), "2026-11-12", 23 * 60 + 30);
    expect(form).toMatchObject({ endDate: "2026-11-13", endMinutes: 30 });
    expect(formTimes(form)).toEqual({
      start: { ms: zonedMs("2026-11-12", 23 * 60 + 30, TZ), timeZone: TZ },
      end: { ms: zonedMs("2026-11-13", 30, TZ), timeZone: TZ },
    });
  });

  test("a new all-day event sends Google's exclusive end date and no empty fields", () => {
    const form = newForm({
      accountId: "a",
      calendarId: "c",
      zone: TZ,
      allDay: true,
      startDate: "2026-11-11",
      endDate: "2026-11-12",
      summary: "Offsite",
    });
    expect(formEdit(form, null)).toEqual({
      summary: "Offsite",
      start: { date: "2026-11-11" },
      end: { date: "2026-11-13" },
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOtherGuests: true,
      transparency: "transparent",
    });
  });

  test("problems: ending before starting, bad guests, too-long reminders", () => {
    const form = formFromDetail(detail(), TZ);
    expect(formProblem(form)).toBeNull();
    expect(formProblem({ ...form, endMinutes: 13 * 60 })).toBe(
      "The event must end after it starts.",
    );
    expect(
      formProblem({ ...form, guests: [{ name: null, address: "dana", optional: false }] }),
    ).toMatch(/isn't an email address/);
    expect(
      formProblem({ ...form, reminders: [{ method: "popup", amount: 5, unit: "weeks" }] }),
    ).toMatch(/4 weeks/);
  });
});

describe("repeat rules", () => {
  test("presets for a day, and which one a rule is", () => {
    const presets = repeatPresets("2026-11-11");
    expect(presets.map((p) => p.label)).toEqual([
      "Daily",
      "Weekly on Wednesday",
      "Monthly on the second Wednesday",
      "Annually on November 11",
      "Every weekday (Monday to Friday)",
    ]);
    expect(repeatChoice({ kind: "rule", rule: presets[1].rule }, "2026-11-11")).toBe("weekly");
    expect(repeatChoice({ kind: "none" }, "2026-11-11")).toBe("none");
    expect(
      repeatChoice(
        { kind: "rule", rule: { ...presets[1].rule, ends: { kind: "after", count: 3 } } },
        "2026-11-11",
      ),
    ).toBe("custom");
  });

  test("the last week of a month is 'last'", () => {
    expect(nthWeekday("2026-11-30")).toBe("-1MO");
    expect(nthWeekday("2026-11-01")).toBe("1SU");
  });

  test("rules the editor can't show are kept as they are", () => {
    const { repeat } = parseRecurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15"]);
    expect(repeat).toEqual({ kind: "other", lines: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15"] });
  });

  test("UNTIL is the end of the last day in the event's zone, or a date for all-day events", () => {
    const rule = {
      freq: "DAILY" as const,
      interval: 1,
      byDay: [],
      ends: { kind: "on" as const, date: "2026-12-31" },
    };
    expect(ruleLine(rule, false, TZ)).toBe("RRULE:FREQ=DAILY;UNTIL=20270101T045959Z");
    expect(ruleLine(rule, true, TZ)).toBe("RRULE:FREQ=DAILY;UNTIL=20261231");
    expect(parseRecurrence([ruleLine(rule, true, TZ)]).repeat).toEqual({ kind: "rule", rule });
    expect(parseRecurrence([ruleLine(rule, false, TZ)], TZ).repeat).toEqual({ kind: "rule", rule });
  });

  test("described in words", () => {
    expect(
      describeRule({
        freq: "WEEKLY",
        interval: 2,
        byDay: ["MO", "WE"],
        ends: { kind: "after", count: 10 },
      }),
    ).toBe("Every 2 weeks on Monday, Wednesday, 10 times");
  });

  test("reminders pick the largest whole unit", () => {
    expect(reminderFrom("email", 10080)).toEqual({ method: "email", amount: 1, unit: "weeks" });
    expect(reminderFrom("popup", 90)).toEqual({ method: "popup", amount: 90, unit: "minutes" });
    expect(reminderFrom("popup", 0)).toEqual({ method: "popup", amount: 0, unit: "minutes" });
  });
});
