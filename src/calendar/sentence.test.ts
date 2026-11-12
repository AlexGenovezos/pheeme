import { describe, expect, test } from "vitest";
import { wallClock } from "./dates";
import { parseQuickAdd, type Target } from "./sentence";

const NY = "America/New_York";
/** Tuesday 10 November 2026, 10:00 in New York. */
const NOW = Date.UTC(2026, 10, 10, 15);

const targets: Target[] = [
  { key: "a\nprimary", name: "alex@example.com" },
  { key: "a\nwork", name: "Work" },
  { key: "a\nfamily", name: "Family stuff" },
];
const lists: Target[] = [{ key: "a\nlist1", name: "My Tasks" }];

const parse = (text: string, now = NOW) =>
  parseQuickAdd(text, { now, tz: NY, targets, taskTargets: lists });

const at = (ms: number) => {
  const w = wallClock(ms, NY);
  return `${w.date} ${String(Math.floor(w.minutes / 60)).padStart(2, "0")}:${String(w.minutes % 60).padStart(2, "0")}`;
};
const timed = (text: string) => {
  const r = parse(text);
  if (!r.when || r.when.allDay) throw new Error(`not timed: ${text}`);
  return { ...r, start: at(r.when.start), end: at(r.when.end) };
};
const spanText = (text: string, kind: string) =>
  parse(text)
    .spans.filter((s) => s.kind === kind)
    .map((s) => text.slice(s.start, s.end));

describe("parseQuickAdd", () => {
  test("Meet with Kevin tomorrow at 9 am", () => {
    const r = timed("Meet with Kevin tomorrow at 9 am");
    expect(r.title).toBe("Meet with Kevin");
    expect(r.start).toBe("2026-11-11 09:00");
    expect(r.end).toBe("2026-11-11 10:00");
    expect(r.people).toEqual([{ text: "Kevin", address: null, full: null }]);
    expect(r.kind).toBe("event");
  });

  test("an hour from 1 to 7 without AM/PM is the afternoon", () => {
    const r = timed("touch base with nissa next Thursday at 2");
    expect(r.title).toBe("Touch base with nissa");
    expect(r.start).toBe("2026-11-19 14:00");
    expect(r.people.map((p) => p.text)).toEqual(["nissa"]);
    expect(timed("coffee at 8").start).toBe("2026-11-11 08:00");
  });

  test("a time alone is the next time it comes round", () => {
    expect(timed("Call mom at 5").start).toBe("2026-11-10 17:00");
    expect(timed("Call mom at 9am").start).toBe("2026-11-11 09:00");
  });

  test("place, guests and the issue's example", () => {
    const r = timed("Lunch with Sam Friday at noon at Joe's");
    expect(r.title).toBe("Lunch with Sam");
    expect(r.start).toBe("2026-11-13 12:00");
    expect(r.place).toBe("Joe's");
    expect(spanText("Lunch with Sam Friday at noon at Joe's", "place")).toEqual(["at Joe's"]);
    const s = timed("Lunch at Joe's with Sam Park and kim@example.com tomorrow at 1pm");
    expect(s.place).toBe("Joe's");
    expect(s.people).toEqual([
      { text: "Sam Park", address: null, full: null },
      { text: "kim@example.com", address: "kim@example.com", full: null },
    ]);
    expect(s.title).toBe("Lunch with Sam Park and kim@example.com");
  });

  test("a time and day said apart", () => {
    const r = timed("Friday lunch at noon");
    expect(r.title).toBe("Lunch");
    expect(r.start).toBe("2026-11-13 12:00");
    expect(r.place).toBe("");
  });

  test("ranges and lengths", () => {
    const r = timed("sync 2-3pm thursday");
    expect([r.title, r.start, r.end]).toEqual(["Sync", "2026-11-12 14:00", "2026-11-12 15:00"]);
    const d = timed("Review tomorrow at 10 for 30 min");
    expect([d.title, d.start, d.end]).toEqual(["Review", "2026-11-11 10:00", "2026-11-11 10:30"]);
    expect(timed("Call at 4 for an hour and a bit").end).toBe("2026-11-10 17:00");
    expect(parse("Review for 30 min").length).toBe(30 * 60_000);
    const late = timed("Call at 11pm to 1am");
    expect([late.start, late.end]).toEqual(["2026-11-10 23:00", "2026-11-11 01:00"]);
  });

  test("a date without a time is all day", () => {
    const r = parse("Dentist on Friday");
    expect(r.title).toBe("Dentist");
    expect(r.when).toEqual({ allDay: true, date: "2026-11-13", lastDate: "2026-11-13" });
  });

  test("nothing about when leaves it to the caller", () => {
    const r = parse("Write the report");
    expect(r.when).toBeNull();
    expect(r.title).toBe("Write the report");
    expect(r.spans).toEqual([]);
  });

  test("repeats", () => {
    const r = timed("every other Tue standup at 10");
    expect(r.title).toBe("Standup");
    expect(r.repeat).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: ["TU"],
      ends: { kind: "never" },
    });
    // 10:00 today has passed (it's 10:00 now), so the next Tuesday.
    expect(r.start).toBe("2026-11-17 10:00");

    const d = parse("Stretch daily until Dec 1 at 7am");
    expect(d.repeat).toEqual({
      freq: "DAILY",
      interval: 1,
      byDay: [],
      ends: { kind: "on", date: "2026-12-01" },
    });
    expect(d.title).toBe("Stretch");
    expect(d.when && !d.when.allDay && at(d.when.start)).toBe("2026-11-11 07:00");

    expect(parse("Gym every Mon, Wed and Fri at 6pm").repeat?.byDay).toEqual(["MO", "WE", "FR"]);
    expect(parse("Report weekdays at 9am").repeat?.byDay).toEqual(["MO", "TU", "WE", "TH", "FR"]);
    expect(parse("Rent monthly on Dec 1").repeat).toMatchObject({ freq: "MONTHLY", byDay: [] });
    const w = parse("1:1 weekly thursday at 3 for 6 times");
    expect(w.repeat).toMatchObject({ byDay: ["TH"], ends: { kind: "after", count: 6 } });
    // The limit after the time, and "weekly" with no day yet leaves the day to the start.
    expect(parse("Meet every Tuesday at 10 until Dec 1").repeat?.ends).toEqual({
      kind: "on",
      date: "2026-12-01",
    });
    expect(timed("Meet every Tuesday at 10 until Dec 1").title).toBe("Meet");
    expect(parse("Standup weekly").repeat?.byDay).toEqual([]);
    expect(parse("Bins every Thursday").when).toEqual({
      allDay: true,
      date: "2026-11-12",
      lastDate: "2026-11-12",
    });
  });

  test("/calendar picks a calendar by name", () => {
    const r = parse("Planning tomorrow at 3 /work");
    expect(r.target).toBe("a\nwork");
    expect(r.title).toBe("Planning");
    expect(parse("Dinner /fam").target).toBe("a\nfamily");
    expect(parse("Dinner /alex").target).toBe("a\nprimary");
    const unknown = parse("Dinner /nope");
    expect(unknown.target).toBeNull();
    expect(unknown.title).toBe("Dinner /nope");
  });

  test("todo makes a task with a due date", () => {
    const r = parse("todo pay rent Friday at 5 /my");
    expect(r.kind).toBe("task");
    expect(r.title).toBe("Pay rent");
    expect(r.when).toMatchObject({ allDay: false });
    expect(r.target).toBe("a\nlist1");
    const m = parse("remind me to call Sam with the news tomorrow");
    expect(m.kind).toBe("task");
    expect(m.title).toBe("Call Sam with the news");
    expect(m.people).toEqual([]);
  });

  test("an uncapitalised surname counts when contacts know the full name", () => {
    const text = "work on church with mike murray every thur at 5 pm 10 times";
    const plain = parse(text);
    expect(plain.people).toEqual([{ text: "mike", address: null, full: "mike murray" }]);
    expect(spanText(text, "guest")).toEqual(["mike"]);
    const known = parseQuickAdd(text, {
      now: NOW,
      tz: NY,
      targets,
      fullNames: (full) => full === "mike murray",
    });
    expect(known.people).toEqual([{ text: "mike murray", address: null, full: "mike murray" }]);
    expect(known.title).toBe("Work on church with mike murray");
    expect(
      known.spans.filter((s) => s.kind === "guest").map((s) => text.slice(s.start, s.end)),
    ).toEqual(["mike murray"]);
    // The people after an unknown surname are still read, so they can be looked up too.
    expect(parse("lunch with mike murray and grace hopper").people.map((p) => p.full)).toEqual([
      "mike murray",
      "grace hopper",
    ]);
    // "and" joins two people, never a surname.
    expect(parse("lunch with sam and kim").people.map((p) => [p.text, p.full])).toEqual([
      ["sam", null],
      ["kim", null],
    ]);
  });

  test("words after with that aren't people", () => {
    expect(parse("Lunch with the team tomorrow").people).toEqual([]);
    expect(parse("Catch up with me").people).toEqual([]);
  });

  test("spans mark what was read", () => {
    const text = "Meet with Kevin tomorrow at 9 am /work";
    expect(parse(text).spans.map((s) => [s.kind, text.slice(s.start, s.end)])).toEqual([
      ["guest", "Kevin"],
      ["time", "tomorrow at 9 am"],
      ["calendar", "/work"],
    ]);
  });
});
