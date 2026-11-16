// @vitest-environment node
import { expect, test } from "vitest";
import type { CalendarEvent } from "../lib/tauri";
import { zoneLines } from "./EventPopover";

const at = (ms: number, timeZone: string | null) => ({ ms, date: null, timeZone });
const event = (start: number, end: number, timeZone: string | null): CalendarEvent =>
  ({
    id: "e",
    accountId: "a",
    calendarId: "c",
    allDay: false,
    start: at(start, timeZone),
    end: at(end, timeZone),
  }) as CalendarEvent;

// 2 – 3 PM in New York on Monday, November 16 2026.
const start = Date.UTC(2026, 10, 16, 19);
const end = start + 3_600_000;

test("the event's time in each other zone, with a day shift", () => {
  const lines = zoneLines(event(start, end, "America/New_York"), "America/New_York", [
    { zone: "Europe/Athens", label: "" },
    { zone: "Asia/Tokyo", label: "Home" },
  ]);
  expect(lines).toEqual([
    {
      zone: "Europe/Athens",
      name: "Athens",
      when: "9:00 PM – 10:00 PM",
      shift: "",
      eventZone: false,
    },
    {
      zone: "Asia/Tokyo",
      name: "Home",
      when: "4:00 AM – 5:00 AM",
      shift: "+1 day",
      eventZone: false,
    },
  ]);
});

test("the event's own zone, when its clock differs from the calendar's", () => {
  const lines = zoneLines(event(start, end, "America/Los_Angeles"), "America/New_York", [
    { zone: "America/New_York", label: "" },
  ]);
  expect(lines).toEqual([
    {
      zone: "America/Los_Angeles",
      name: "Los Angeles",
      when: "11:00 AM – 12:00 PM",
      shift: "",
      eventZone: true,
    },
  ]);
  // Toronto keeps New York's clock: nothing to add.
  expect(zoneLines(event(start, end, "America/Toronto"), "America/New_York", [])).toEqual([]);
});

test("nothing for an all-day event", () => {
  const e = { ...event(start, end, null), allDay: true };
  expect(zoneLines(e, "America/New_York", [{ zone: "Europe/Athens", label: "" }])).toEqual([]);
});
