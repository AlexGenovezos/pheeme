import { expect, test } from "vitest";
import type { CalendarEvent } from "../lib/tauri";
import { describeWhen } from "./EventPopover";

const NY = "America/New_York";
const event = (start: string, end: string) =>
  ({
    allDay: false,
    start: { ms: Date.parse(start), date: null, timeZone: NY },
    end: { ms: Date.parse(end), date: null, timeZone: NY },
  }) as CalendarEvent;

test("an event ending at midnight is one day; past a day, the end has its own date", () => {
  expect(describeWhen(event("2026-11-11T22:00:00-05:00", "2026-11-12T00:00:00-05:00"), NY)).toBe(
    "Wednesday, November 11 · 10:00 PM – 12:00 AM",
  );
  expect(describeWhen(event("2026-11-11T10:00:00-05:00", "2026-11-13T00:00:00-05:00"), NY)).toBe(
    "Nov 11, 10:00 AM – Nov 13, 12:00 AM",
  );
});

test("a zero-length event at midnight stays on its day", () => {
  expect(describeWhen(event("2026-11-11T00:00:00-05:00", "2026-11-11T00:00:00-05:00"), NY)).toBe(
    "Wednesday, November 11 · 12:00 AM – 12:00 AM",
  );
});
