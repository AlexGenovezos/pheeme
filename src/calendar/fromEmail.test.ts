import { describe, expect, test } from "vitest";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { wallClock } from "./dates";
import {
  cleanSubject,
  emailDescription,
  findTime,
  formFromEmail,
  gmailLink,
  nextHalfHour,
  threadGuests,
} from "./fromEmail";

const NY = "America/New_York";
/** Tuesday 10 November 2026, 9:00 in New York. */
const SENT = Date.UTC(2026, 10, 10, 14);

const at = (ms: number) => {
  const w = wallClock(ms, NY);
  return `${w.date} ${String(Math.floor(w.minutes / 60)).padStart(2, "0")}:${String(w.minutes % 60).padStart(2, "0")}`;
};

function message(over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: "m1",
    threadId: "t1",
    fromName: "Jonas Weber",
    fromAddress: "jonas@example.net",
    to: [{ name: "Avery", address: "Avery@Example.com" }],
    cc: [{ name: null, address: "mira@example.net" }],
    subject: "Re: Fwd: Coffee",
    snippet: "snippet",
    date: SENT,
    bodyHtml: null,
    hasRemoteContent: false,
    declaresDarkMode: false,
    bodyText: "Are you free Thursday at 3pm?",
    bodyAvailable: true,
    unread: false,
    starred: false,
    labelIds: [],
    hasAttachment: false,
    attachments: [],
    ...over,
  };
}

describe("cleanSubject", () => {
  test("drops reply and forward prefixes, however many", () => {
    expect(cleanSubject("Re: Fwd: RE: Coffee")).toBe("Coffee");
    expect(cleanSubject("FW: AW: Plan")).toBe("Plan");
    expect(cleanSubject("Re[2]: Plan")).toBe("Plan");
    expect(cleanSubject("Rebooting the server")).toBe("Rebooting the server");
    expect(cleanSubject(null)).toBe("");
  });
});

describe("threadGuests", () => {
  test("everyone on the thread once, without the user", () => {
    const reply = message({
      fromName: "Avery",
      fromAddress: "avery@example.com",
      to: [{ name: "Jonas", address: "JONAS@example.net" }],
      cc: [{ name: "Dana", address: "dana@example.org" }],
    });
    expect(threadGuests([message(), reply], ["avery@example.com"])).toEqual([
      { name: "Jonas Weber", address: "jonas@example.net", optional: false },
      { name: null, address: "mira@example.net", optional: false },
      { name: "Dana", address: "dana@example.org", optional: false },
    ]);
  });
});

describe("findTime", () => {
  test("a weekday with a time, relative to when the email was sent", () => {
    const found = findTime("Are you free Thursday at 3pm?", SENT, NY);
    expect(found?.allDay).toBe(false);
    if (found?.allDay !== false) return;
    expect(at(found.start)).toBe("2026-11-12 15:00");
    expect(found.end - found.start).toBe(60 * 60_000);
  });

  test("a range sets the end", () => {
    const found = findTime("Let's meet Nov 19 2–3:30pm", SENT, NY);
    if (found?.allDay !== false) throw new Error("expected a time");
    expect(at(found.start)).toBe("2026-11-19 14:00");
    expect(at(found.end)).toBe("2026-11-19 15:30");
  });

  test("the first match with a time wins over an earlier date", () => {
    const found = findTime("Deadline is December 1. Call on Friday at 10am?", SENT, NY);
    if (found?.allDay !== false) throw new Error("expected a time");
    expect(at(found.start)).toBe("2026-11-13 10:00");
  });

  test("a date alone is an all-day event", () => {
    expect(findTime("The offsite is on December 3rd.", SENT, NY)).toEqual({
      allDay: true,
      date: "2026-12-03",
      lastDate: "2026-12-03",
    });
  });

  test("a time in another zone keeps its instant", () => {
    const found = findTime("Call at 3pm PST tomorrow", SENT, NY);
    if (found?.allDay !== false) throw new Error("expected a time");
    expect(at(found.start)).toBe("2026-11-11 18:00");
  });

  test("no date at all, or only “now”", () => {
    expect(findTime("Thanks for the notes, all good.", SENT, NY)).toBeNull();
    expect(findTime("I'm free now", SENT, NY)).toBeNull();
  });
});

test("nextHalfHour rounds up, and past 23:30 goes to tomorrow", () => {
  expect(at(nextHalfHour(Date.UTC(2026, 10, 10, 14, 10), NY).start)).toBe("2026-11-10 09:30");
  expect(at(nextHalfHour(Date.UTC(2026, 10, 10, 14, 30), NY).start)).toBe("2026-11-10 10:00");
  expect(at(nextHalfHour(Date.UTC(2026, 10, 11, 4, 45), NY).start)).toBe("2026-11-11 00:00");
});

describe("formFromEmail", () => {
  const detail = (messages: MessageDetail[]): ThreadDetail => ({
    thread: { id: "t1", subject: "Coffee" } as ThreadDetail["thread"],
    messages,
    bodyError: null,
  });
  const opts = {
    email: "avery@example.com",
    accountId: "acc",
    calendarId: "avery@example.com",
    tz: NY,
    now: SENT,
  };

  test("title, guests, a link back and the time the email names", () => {
    const m = message();
    const { form, found } = formFromEmail(detail([m]), m, opts);
    expect(found).toBe(true);
    expect(form.summary).toBe("Coffee");
    expect(form.guests.map((g) => g.address)).toEqual(["jonas@example.net", "mira@example.net"]);
    expect(form.description).toBe(
      `${gmailLink("avery@example.com", "t1")}\n\nAre you free Thursday at 3pm?`,
    );
    expect(
      form.description.startsWith(
        "https://mail.google.com/mail/?authuser=avery%40example.com#all/t1",
      ),
    ).toBe(true);
    expect([form.startDate, form.startMinutes, form.endMinutes]).toEqual([
      "2026-11-12",
      15 * 60,
      16 * 60,
    ]);
    expect([form.accountId, form.calendarId, form.startZone]).toEqual([
      "acc",
      "avery@example.com",
      NY,
    ]);
  });

  test("without a time it starts at the next half hour", () => {
    const m = message({ bodyText: "See attached.", subject: "Report" });
    const { form, found } = formFromEmail(detail([m]), m, { ...opts, now: SENT + 5 * 60_000 });
    expect(found).toBe(false);
    expect([form.startDate, form.startMinutes, form.allDay]).toEqual([
      "2026-11-10",
      9 * 60 + 30,
      false,
    ]);
  });

  test("the description quotes only the start of a long email", () => {
    const quoted = emailDescription("L", "x".repeat(800));
    expect(quoted.length).toBeLessThan(520);
    expect(quoted.endsWith("…")).toBe(true);
  });
});
