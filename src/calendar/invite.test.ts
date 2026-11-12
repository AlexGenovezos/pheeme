import { describe, expect, test } from "vitest";
import type { CalendarEvent, EventDetail, Invite } from "../lib/tauri";
import { inviteMessage, isCalendarBodyPart } from "../mail/invitePart";
import {
  canAnswer,
  clashes,
  clashText,
  inviteNotice,
  miniWindow,
  selfAnswer,
  shownEvent,
} from "./invite";

const NY = "America/New_York";
const H = 60 * 60_000;
/** Thursday 12 November 2026, 14:00 in New York. */
const T = Date.UTC(2026, 10, 12, 19);

function invite(over: Partial<Invite> = {}): Invite {
  return {
    method: "REQUEST",
    uid: "review@google.com",
    sequence: 0,
    cancelled: false,
    summary: "Design review",
    description: null,
    location: null,
    meeting: null,
    start: { ms: T, date: null, timeZone: NY },
    end: { ms: T + H, date: null, timeZone: NY },
    allDay: false,
    recurrence: [],
    recurrenceId: null,
    organizer: { email: "morgan@example.org", name: "Morgan", isSelf: false },
    attendees: [
      {
        email: "a@example.org",
        name: null,
        response: "needsAction",
        optional: false,
        organizer: false,
        isSelf: true,
        resource: false,
        comment: null,
      },
    ],
    live: null,
    liveSequence: null,
    import: { summary: "Design review" },
    ...over,
  };
}

function event(id: string, start: number, end: number, over: Partial<CalendarEvent> = {}) {
  return {
    accountId: "acc",
    calendarId: "cal",
    id,
    masterId: null,
    summary: id,
    start: { ms: start, date: null, timeZone: NY },
    end: { ms: end, date: null, timeZone: NY },
    allDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    location: null,
    hasConference: false,
    meeting: null,
    colorId: null,
    transparency: null,
    recurring: false,
    canEdit: true,
    ...over,
  } satisfies CalendarEvent;
}

const live = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    ...event("review", T, T + H, { summary: "Design review", selfResponse: "tentative" }),
    canRsvp: true,
    recurrence: [],
    attendees: [],
    organizer: null,
    ...over,
  }) as EventDetail;

describe("the event the card shows", () => {
  test("the email's, answered as the email says, until the calendar has it", () => {
    const e = shownEvent(invite(), "acc");
    expect(e.id).toBe("invite:review@google.com");
    expect(e.selfResponse).toBe("needsAction");
    expect(selfAnswer(invite())).toBe("needsAction");
    const withLive = invite({ live: live() });
    expect(shownEvent(withLive, "acc")).toBe(withLive.live);
    expect(selfAnswer(withLive)).toBe("tentative");
  });
});

describe("inviteNotice", () => {
  test("cancelled, moved, changed since, updated, a guest's answer", () => {
    expect(inviteNotice(invite({ cancelled: true }), NY)?.text).toBe("This event was cancelled.");
    expect(inviteNotice(invite({ live: live({ status: "cancelled" }) }), NY)?.tone).toBe("danger");
    const moved = live({
      start: { ms: T + H, date: null, timeZone: NY },
      end: { ms: T + 2 * H, date: null, timeZone: NY },
    });
    expect(inviteNotice(invite({ live: moved }), NY)?.text).toMatch(
      /^Time changed to Thursday, November 12 · 3:00\sPM – 4:00\sPM\.$/,
    );
    expect(inviteNotice(invite({ live: live(), liveSequence: 3, sequence: 1 }), NY)?.text).toMatch(
      /changed since this email/,
    );
    expect(inviteNotice(invite({ sequence: 2 }), NY)?.text).toBe("This is an updated invitation.");
    expect(inviteNotice(invite({ live: live() }), NY)).toBeNull();
    const reply = invite({
      method: "REPLY",
      attendees: [{ ...invite().attendees[0], name: "Dana", response: "accepted", isSelf: false }],
    });
    expect(inviteNotice(reply, NY)?.text).toBe("Dana accepted this invitation.");
  });
});

describe("canAnswer", () => {
  test("requests you're invited to, not cancellations, replies or your own", () => {
    expect(canAnswer(invite())).toBe(true);
    expect(canAnswer(invite({ cancelled: true }))).toBe(false);
    expect(canAnswer(invite({ method: "REPLY", import: null }))).toBe(false);
    expect(
      canAnswer(invite({ organizer: { email: "a@example.org", name: null, isSelf: true } })),
    ).toBe(false);
    expect(canAnswer(invite({ live: live({ canRsvp: false }) }))).toBe(false);
    // One changed occurrence needs the calendar's copy.
    expect(
      canAnswer(invite({ recurrenceId: { ms: T, date: null, timeZone: NY }, import: null })),
    ).toBe(false);
  });
});

describe("clashes", () => {
  const shown = shownEvent(invite(), "acc");
  test("busy, timed events that overlap, not the invitation itself", () => {
    const list = [
      event("one-on-one", T + H / 2, T + 1.5 * H, { summary: "1:1 Alex" }),
      event("before", T - H, T),
      event("declined", T, T + H, { selfResponse: "declined" }),
      event("free", T, T + H, { transparency: "transparent" }),
      event("all-day", 0, 0, {
        allDay: true,
        start: { ms: null, date: "2026-11-12", timeZone: null },
      }),
      // The same invitation on another of the user's calendars.
      event("copy", T, T + H, { summary: "Design review", accountId: "other" }),
    ];
    const found = clashes(list, shown);
    expect(found.map((e) => e.id)).toEqual(["one-on-one"]);
    expect(clashText(found, NY)).toMatch(/^Overlaps 1:1 Alex \(2:30\sPM\)$/);
  });

  test("the occurrence of the live series at the same time isn't a clash", () => {
    const series = live({ recurrence: ["RRULE:FREQ=WEEKLY"] });
    const occurrence = event("review_20261112T190000Z", T, T + H, {
      summary: "Design review",
      masterId: "review",
    });
    expect(clashes([occurrence], series)).toEqual([]);
  });

  test("words for two and more", () => {
    const a = event("a", T, T + H);
    const b = event("b", T, T + H);
    const c = event("c", T, T + H);
    expect(clashText([a, b], NY)).toMatch(/^Overlaps a \(2:00\sPM\) and b \(2:00\sPM\)$/);
    expect(clashText([a, b, c], NY)).toMatch(/^Overlaps a \(2:00\sPM\) and 2 more$/);
    expect(clashText([], NY)).toBeNull();
  });
});

test("miniWindow: an hour either side, at least four hours, within the day", () => {
  expect(miniWindow(14 * 60, 15 * 60)).toEqual({ from: 13 * 60, to: 17 * 60 });
  expect(miniWindow(9 * 60, 13 * 60)).toEqual({ from: 8 * 60, to: 14 * 60 });
  expect(miniWindow(30, 60)).toEqual({ from: 0, to: 4 * 60 });
  expect(miniWindow(23 * 60, 24 * 60)).toEqual({ from: 20 * 60, to: 24 * 60 });
});

describe("invite parts", () => {
  const part = (filename: string | null, mimeType: string) => ({
    id: filename ?? mimeType,
    filename,
    mimeType,
    size: 1,
    isInline: false,
    contentId: null,
  });
  test("the newest message with a calendar file; the unnamed part isn't listed", () => {
    const m = (id: string, attachments: ReturnType<typeof part>[]) =>
      ({ id, attachments }) as never;
    const messages = [
      m("1", [part(null, "text/calendar")]),
      m("2", [part("Invite.ICS", "application/octet-stream")]),
      m("3", [part("notes.pdf", "application/pdf")]),
    ];
    expect(inviteMessage(messages)?.id).toBe("2");
    expect(inviteMessage([messages[2]])).toBeNull();
    expect(isCalendarBodyPart(part(null, "text/calendar"))).toBe(true);
    expect(isCalendarBodyPart(part("invite.ics", "text/calendar"))).toBe(false);
  });
});
