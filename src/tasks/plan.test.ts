// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { CalendarEvent, Task } from "../lib/tauri";
import {
  bookingUrl,
  lateness,
  PLANNED_KEY,
  planQueue,
  readPlanned,
  shouldAutoOpen,
  taskForBlock,
  withoutBooked,
  writePlanned,
} from "./plan";

const TODAY = "2026-11-16";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  accountId: "a",
  listId: "l",
  id,
  parent: null,
  title: id,
  notes: null,
  due: null,
  completed: false,
  completedAt: null,
  hidden: false,
  updatedAt: 0,
  webViewLink: null,
  ...extra,
});

const event = (extra: Partial<CalendarEvent>): CalendarEvent => ({
  accountId: "a",
  calendarId: "a@example.com",
  id: "block",
  masterId: null,
  summary: "Block",
  start: { ms: null, date: null, timeZone: null },
  end: { ms: null, date: null, timeZone: null },
  allDay: false,
  status: "confirmed",
  selfResponse: null,
  location: null,
  hasConference: false,
  meeting: null,
  colorId: null,
  transparency: null,
  recurring: false,
  canEdit: false,
  taskLink: null,
  ...extra,
});

describe("planQueue", () => {
  test("overdue oldest first, then today's; never completed, future, undated or hidden ones", () => {
    const tasks = [
      task("today-1", { due: TODAY }),
      task("done-today", { due: TODAY, completed: true, completedAt: 1 }),
      task("nov-14", { due: "2026-11-14" }),
      task("tomorrow", { due: "2026-11-17" }),
      task("undated"),
      task("hidden", { due: "2026-11-12", hidden: true }),
      task("nov-10", { due: "2026-11-10" }),
      task("today-2", { due: TODAY }),
    ];
    expect(planQueue(tasks, TODAY).map((t) => t.id)).toEqual([
      "nov-10",
      "nov-14",
      "today-1",
      "today-2",
    ]);
  });
});

test("lateness says how late a task is", () => {
  expect(lateness(TODAY, TODAY)).toBe("Due today");
  expect(lateness("2026-11-15", TODAY)).toBe("Due yesterday");
  expect(lateness("2026-11-04", TODAY)).toBe("Due 12 days ago");
});

describe("planned date", () => {
  test("auto-opens only when not planned today and something is due", () => {
    const due = [task("x", { due: TODAY })];
    expect(shouldAutoOpen(TODAY, TODAY, due)).toBe(false);
    expect(shouldAutoOpen("2026-11-15", TODAY, [])).toBe(false);
    expect(shouldAutoOpen("2026-11-15", TODAY, due)).toBe(true);
    expect(shouldAutoOpen(null, TODAY, due)).toBe(true);
  });

  test("is kept in storage under its key", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    expect(readPlanned(store)).toBeNull();
    writePlanned(TODAY, store);
    expect(map.get(PLANNED_KEY)).toBe(TODAY);
    expect(readPlanned(store)).toBe(TODAY);
  });
});

test("bookingUrl opens Google Calendar's day for the account", () => {
  expect(bookingUrl("a+b@x.com", "2026-11-06")).toBe(
    "https://calendar.google.com/calendar/u/0/r/day/2026/11/6?authuser=a%2Bb%40x.com",
  );
});

test("taskForBlock matches the task's link, with or without its query", () => {
  const abc = task("abc", { webViewLink: "https://tasks.google.com/task/abc?sa=6" });
  const abcd = task("abcd", { webViewLink: "https://tasks.google.com/task/abcd" });
  expect(taskForBlock("https://tasks.google.com/task/abc", [abcd, abc])).toBe(abc);
  expect(taskForBlock("https://tasks.google.com/task/abcd", [abc, abcd])).toBe(abcd);
  expect(taskForBlock("https://tasks.google.com/task/ab", [abc, abcd])).toBeUndefined();
});

test("withoutBooked drops a task only on the day its block is", () => {
  const link = "https://tasks.google.com/task/abc";
  const booked = task("abc", { due: TODAY, webViewLink: `${link}?sa=6` });
  const other = task("other", { due: TODAY });
  const at = (date: string) =>
    event({
      taskLink: link,
      start: { ms: Date.parse(`${date}T15:00:00Z`), date: null, timeZone: "UTC" },
      end: { ms: Date.parse(`${date}T16:00:00Z`), date: null, timeZone: "UTC" },
    });
  expect(withoutBooked([booked, other], [at(TODAY)], "UTC")).toEqual([other]);
  expect(withoutBooked([booked, other], [at("2026-11-17")], "UTC")).toEqual([booked, other]);
  // A plain event with the same time doesn't count.
  expect(withoutBooked([booked, other], [{ ...at(TODAY), taskLink: null }], "UTC")).toEqual([
    booked,
    other,
  ]);
});
