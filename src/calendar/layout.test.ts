import { describe, expect, test } from "vitest";
import type { CalendarEvent } from "../lib/tauri";
import { addDays, addMonths, startOfWeek, wallClock, zonedMs } from "./dates";
import { eventDays, fitRows, layoutBand, layoutDay } from "./layout";
import { shiftAnchor, viewTitle, visibleDays } from "./views";

const NY = "America/New_York";

let n = 0;
function timed(start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    accountId: "a",
    calendarId: "c",
    id: `e${++n}`,
    masterId: null,
    summary: null,
    start: { ms: start, date: null, timeZone: NY },
    end: { ms: end, date: null, timeZone: NY },
    allDay: false,
    status: "confirmed",
    selfResponse: null,
    location: null,
    hasConference: false,
    colorId: null,
    transparency: null,
    recurring: false,
    ...extra,
  };
}
const allDay = (start: string, end: string) =>
  timed(0, 0, {
    allDay: true,
    start: { ms: null, date: start, timeZone: null },
    end: { ms: null, date: end, timeZone: null },
  });
/** `date` at `h:m` New York time. */
const at = (date: string, h: number, m = 0) => zonedMs(date, h * 60 + m, NY);

describe("dates", () => {
  test("zoned midnight and wall clock round-trip across DST", () => {
    // 2026-11-01 is the US fall-back day: 25 hours long.
    expect(zonedMs("2026-11-01", 0, NY)).toBe(Date.UTC(2026, 10, 1, 4));
    expect(zonedMs("2026-11-02", 0, NY)).toBe(Date.UTC(2026, 10, 2, 5));
    expect(wallClock(Date.UTC(2026, 10, 9, 19, 30), NY)).toEqual({
      date: "2026-11-09",
      minutes: 14 * 60 + 30,
    });
  });

  test("a midnight skipped by DST starts the day just after the gap", () => {
    // Chile springs forward at midnight: 2026-09-06 00:00 doesn't exist, the day starts at 01:00.
    const start = zonedMs("2026-09-06", 0, "America/Santiago");
    expect(wallClock(start, "America/Santiago")).toEqual({ date: "2026-09-06", minutes: 60 });
    // Far from UTC too: Auckland skips 02:00–03:00 on 2026-09-27.
    expect(wallClock(zonedMs("2026-09-27", 150, "Pacific/Auckland"), "Pacific/Auckland")).toEqual({
      date: "2026-09-27",
      minutes: 210,
    });
    // The repeated hour on fall-back day resolves to its first occurrence.
    expect(zonedMs("2026-11-01", 90, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  test("weeks start on the chosen day and months step by first-of-month", () => {
    expect(startOfWeek("2026-11-11", 0)).toBe("2026-11-08");
    expect(startOfWeek("2026-11-11", 1)).toBe("2026-11-09");
    expect(startOfWeek("2026-11-08", 1)).toBe("2026-11-02");
    expect(addMonths("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("views", () => {
  test("month shows the whole weeks covering it", () => {
    const days = visibleDays("month", "2026-11-11", 0);
    expect(days[0]).toBe("2026-11-01");
    expect(days[days.length - 1]).toBe("2026-12-05");
    expect(days.length % 7).toBe(0);
    expect(visibleDays("week", "2026-11-11", 1)[0]).toBe("2026-11-09");
    expect(visibleDays("day", "2026-11-11", 1)).toEqual(["2026-11-11"]);
  });

  test("prev and next move by the view's period", () => {
    expect(shiftAnchor("day", "2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftAnchor("week", "2026-11-11", -1)).toBe("2026-11-04");
    expect(shiftAnchor("month", "2026-11-30", 1)).toBe("2026-12-01");
  });

  test("week titles name both months when the week spans two", () => {
    const days = visibleDays("week", "2026-12-01", 0);
    expect(viewTitle("week", "2026-12-01", days)).toMatch(/Nov.*29.*Dec.*5.*2026/);
  });
});

describe("layoutDay", () => {
  const d = "2026-11-11";

  test("overlapping events share the width and a lone one takes it all", () => {
    const a = timed(at(d, 14), at(d, 15));
    const b = timed(at(d, 14, 30), at(d, 15, 30));
    const c = timed(at(d, 17), at(d, 18));
    const blocks = layoutDay([c, b, a], d, NY);
    const of = (e: CalendarEvent) => blocks.find((x) => x.event === e)!;
    expect(of(a)).toMatchObject({ start: 840, end: 900, column: 0, columns: 2, span: 1 });
    expect(of(b)).toMatchObject({ column: 1, columns: 2 });
    expect(of(c)).toMatchObject({ column: 0, columns: 1, span: 1 });
  });

  test("an event widens into a column that is free for its whole time", () => {
    const long = timed(at(d, 9), at(d, 12));
    const early = timed(at(d, 9), at(d, 10));
    const late = timed(at(d, 11), at(d, 12));
    const short = timed(at(d, 9, 30), at(d, 10, 30));
    const blocks = layoutDay([long, early, late, short], d, NY);
    const of = (e: CalendarEvent) => blocks.find((x) => x.event === e)!;
    expect(of(long).columns).toBe(3);
    // `late` lands in column 1 (free after `early`), and nothing is in column 2 at 11.
    expect(of(late)).toMatchObject({ column: 1, span: 2 });
    expect(of(short)).toMatchObject({ column: 2, span: 1 });
  });

  test("an overnight event is clipped to each day", () => {
    const e = timed(at(d, 22), at(addDays(d, 1), 2));
    expect(layoutDay([e], d, NY)[0]).toMatchObject({ start: 1320, end: 1440, clippedEnd: true });
    expect(layoutDay([e], addDays(d, 1), NY)[0]).toMatchObject({
      start: 0,
      end: 120,
      clippedStart: true,
    });
  });

  test("all-day and 24-hour events stay out of the hours", () => {
    const long = timed(at(d, 9), at(addDays(d, 1), 9));
    expect(layoutDay([allDay(d, addDays(d, 1)), long], d, NY)).toEqual([]);
  });
});

describe("layoutBand", () => {
  const week = visibleDays("week", "2026-11-11", 0);

  test("bars pack into rows and are cut at the week's edges", () => {
    const summit = allDay("2026-11-10", "2026-11-13");
    const holiday = allDay("2026-11-11", "2026-11-12");
    const trip = allDay("2026-11-06", "2026-11-10");
    const segs = layoutBand([holiday, summit, trip], week, NY);
    const of = (e: CalendarEvent) => segs.find((s) => s.event === e)!;
    expect(of(summit)).toMatchObject({ start: 2, span: 3, row: 0 });
    expect(of(holiday)).toMatchObject({ start: 3, span: 1, row: 1 });
    expect(of(trip)).toMatchObject({ start: 0, span: 2, row: 0, continuesBefore: true });
  });

  test("a timed event ending at midnight covers one day", () => {
    const e = timed(at("2026-11-11", 0), at("2026-11-12", 0));
    expect(eventDays(e, NY)).toEqual({ first: "2026-11-11", last: "2026-11-11" });
  });

  test("month cells hide what doesn't fit behind +N more", () => {
    const d = "2026-11-11";
    const events = [
      allDay(d, addDays(d, 1)),
      timed(at(d, 9), at(d, 10)),
      timed(at(d, 11), at(d, 12)),
      timed(at(d, 13), at(d, 14)),
    ];
    const segs = layoutBand(events, week, NY, true);
    const { visible, more } = fitRows(segs, 7, 3);
    expect(visible.map((s) => s.row)).toEqual([0, 1]);
    expect(more[3]).toBe(2);
    expect(fitRows(segs, 7, 4).more[3]).toBe(0);
  });
});
