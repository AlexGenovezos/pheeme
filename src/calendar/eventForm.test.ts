import { describe, expect, test } from "vitest";
import type { EventDetail } from "../lib/tauri";
import { zonedMs } from "./dates";
import {
  describeRule,
  formEdit,
  formFromDetail,
  formProblem,
  formTimes,
  hasMeet,
  moveStart,
  newForm,
  nthWeekday,
  otherCall,
  parseRecurrence,
  type Repeat,
  reminderFrom,
  repeatChoice,
  repeatPresets,
  ruleLine,
  plainText,
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
    meeting: null,
    colorId: null,
    transparency: null,
    recurring: false,
    canEdit: true,
    taskLink: null,
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

  test("Meet comes from a Google Meet conference only, not another provider's", () => {
    const zoom = { url: "https://acme.zoom.us/j/1", provider: "Zoom" };
    const meet = { url: "https://meet.google.com/abc-defg-hij", provider: "Google Meet" };
    // A Zoom add-on conference: its video entry point is the Zoom link.
    const zoomConf = detail({ hasConference: true, meetUrl: zoom.url, meeting: zoom });
    expect(hasMeet(zoomConf)).toBe(false);
    expect(otherCall(zoomConf)).toEqual(zoom);
    const form = formFromDetail(zoomConf, TZ);
    expect(form.meet).toBe(false);
    // Saving another change never sends `conference`.
    expect(formEdit({ ...form, summary: "Planning v2" }, form).conference).toBeUndefined();

    const meetConf = detail({ hasConference: true, meetUrl: meet.url, meeting: meet });
    expect(hasMeet(meetConf)).toBe(true);
    expect(otherCall(meetConf)).toBeNull();
    // An old hangoutLink-only Meet, and one Google is still making.
    expect(hasMeet(detail({ hasConference: true, meeting: meet }))).toBe(true);
    expect(hasMeet(detail({ conferencePending: true }))).toBe(true);
    // A Teams link in the description: not Meet, shown as the event's call.
    const teams = {
      url: "https://teams.microsoft.com/l/meetup-join/x",
      provider: "Microsoft Teams",
    };
    expect(hasMeet(detail({ meeting: teams }))).toBe(false);
    expect(otherCall(detail({ meeting: teams }))).toEqual(teams);
  });

  test("moving the start to another day takes a day-based Repeat preset with it", () => {
    const ruleOf = (r: Repeat) => {
      if (r.kind !== "rule") throw new Error(`no rule: ${r.kind}`);
      return r.rule;
    };
    const base = newForm({
      accountId: "a",
      calendarId: "c",
      zone: TZ,
      allDay: false,
      start: zonedMs("2026-11-13", 9 * 60, TZ),
      end: zonedMs("2026-11-13", 10 * 60, TZ),
    });
    const preset = (id: string, date: string) =>
      ({ kind: "rule", rule: repeatPresets(date).find((p) => p.id === id)!.rule }) as const;
    // Friday the 13th → Monday the 16th.
    const weekly = moveStart(
      { ...base, repeat: preset("weekly", "2026-11-13") },
      "2026-11-16",
      540,
    );
    expect(repeatChoice(weekly.repeat, "2026-11-16")).toBe("weekly");
    expect(ruleLine(ruleOf(weekly.repeat), false, TZ)).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
    // Wednesday the 11th (second Wednesday) → Tuesday the 24th (fourth Tuesday).
    const monthly = moveStart(
      { ...base, startDate: "2026-11-11", repeat: preset("monthly", "2026-11-11") },
      "2026-11-24",
      540,
    );
    expect(ruleLine(ruleOf(monthly.repeat), false, TZ)).toBe("RRULE:FREQ=MONTHLY;BYDAY=4TU");
    // A rule of the user's own stays as it is.
    const custom = {
      kind: "rule" as const,
      rule: {
        freq: "WEEKLY" as const,
        interval: 2,
        byDay: ["FR"],
        ends: { kind: "never" as const },
      },
    };
    expect(moveStart({ ...base, repeat: custom }, "2026-11-16", 540).repeat).toEqual(custom);
    // Only the time changes: the preset stays.
    const sameDay = moveStart(
      { ...base, repeat: preset("weekly", "2026-11-13") },
      "2026-11-13",
      600,
    );
    expect(sameDay.repeat).toEqual(preset("weekly", "2026-11-13"));
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
    // The editor offers the first to fourth and the last weekday of a month, nothing else.
    for (const day of ["5SU", "-2MO", "1XX", "2WEX"]) {
      const lines = [`RRULE:FREQ=MONTHLY;BYDAY=${day}`];
      expect(parseRecurrence(lines).repeat).toEqual({ kind: "other", lines });
    }
    expect(parseRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=-1FR"]).repeat.kind).toBe("rule");
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

describe("plainText", () => {
  test("lines as a browser shows them, without the source's whitespace or scripts", () => {
    // Gmail: a div per line, <div><br></div> for a blank one, sometimes a <br> ending a line.
    expect(
      plainText(`<div dir="ltr">
        <div>Hi   Avery,</div>
        <div><br></div>
        <div>Lunch on Friday?<br></div><div>Sam</div><script>track()</script>
      </div>`),
    ).toBe("Hi Avery,\n\nLunch on Friday?\nSam");
    // Outlook: a <p> per line, an empty one for a blank line.
    expect(
      plainText(
        `<p class=MsoNormal>Hi,<o:p></o:p></p>\n<p class=MsoNormal>&nbsp;</p>\n<p class=MsoNormal>Thanks<o:p></o:p></p>`,
      ),
    ).toBe("Hi,\n\nThanks");
    expect(plainText("Line one\nLine two")).toBe("Line one\nLine two");
  });

  test("leaves out a newsletter's hidden preview text and its invisible padding", () => {
    const padding = "&nbsp;&zwnj;&#847;&#65279;".repeat(120);
    expect(
      plainText(`<div style="display:none;max-height:0;overflow:hidden">Esteemed members, an interest in coding appl...</div>
        <div style="display: none; mso-hide: all">${padding}</div>
        <span hidden>also hidden</span>
        <table><tr><td><h1>All Hands</h1></td></tr><tr><td>
          <p>Esteemed members, an interest in coding applications.&zwnj;</p>
          <p>We propose November 20th at 6 PM.</p>
        </td></tr></table>`),
    ).toBe(
      "All Hands\nEsteemed members, an interest in coding applications.\nWe propose November 20th at 6 PM.",
    );
  });
});
