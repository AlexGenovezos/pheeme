import { describe, expect, test } from "vitest";
import type { AvailabilityResult } from "../lib/tauri";
import {
  isFree,
  knownBusy,
  mergeBusy,
  nextFreeSlot,
  plannerRange,
  plannerTime,
  roundUpToSlot,
  searchRange,
  unknownNote,
  withoutSpan,
} from "./availability";
import { zonedMs } from "./dates";

const NY = "America/New_York";
const at = (date: string, hhmm: string, tz = NY) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedMs(date, h * 60 + m, tz);
};
const busy = (date: string, from: string, to: string, tz = NY) => ({
  startMs: at(date, from, tz),
  endMs: at(date, to, tz),
});
const HOUR = 3_600_000;

describe("mergeBusy", () => {
  test("joins overlapping and touching stretches from everyone, sorted", () => {
    const merged = mergeBusy([
      [busy("2026-11-16", "13:00", "14:00"), busy("2026-11-16", "09:00", "10:00")],
      [busy("2026-11-16", "09:30", "11:00"), busy("2026-11-16", "11:00", "11:30")],
      [busy("2026-11-16", "15:00", "15:00")],
    ]);
    expect(merged).toEqual([
      busy("2026-11-16", "09:00", "11:30"),
      busy("2026-11-16", "13:00", "14:00"),
    ]);
  });

  test("doesn't change its input", () => {
    const a = [busy("2026-11-16", "09:00", "10:00")];
    mergeBusy([a, [busy("2026-11-16", "09:30", "12:00")]]);
    expect(a).toEqual([busy("2026-11-16", "09:00", "10:00")]);
  });
});

test("isFree treats busy ends as exclusive", () => {
  const b = [busy("2026-11-16", "10:00", "11:00")];
  expect(isFree(b, at("2026-11-16", "11:00"), at("2026-11-16", "12:00"))).toBe(true);
  expect(isFree(b, at("2026-11-16", "09:00"), at("2026-11-16", "10:00"))).toBe(true);
  expect(isFree(b, at("2026-11-16", "10:45"), at("2026-11-16", "11:15"))).toBe(false);
});

test("roundUpToSlot rounds up to a quarter hour, keeping exact ones", () => {
  expect(roundUpToSlot(at("2026-11-16", "10:00"))).toBe(at("2026-11-16", "10:00"));
  expect(roundUpToSlot(at("2026-11-16", "10:01"))).toBe(at("2026-11-16", "10:15"));
  // Kathmandu is UTC+5:45: still a quarter hour on its clock.
  expect(roundUpToSlot(at("2026-11-16", "10:07", "Asia/Kathmandu"))).toBe(
    at("2026-11-16", "10:15", "Asia/Kathmandu"),
  );
});

describe("nextFreeSlot", () => {
  // 2026-11-16 is a Monday.
  test("the first quarter hour after the start that fits between busy stretches", () => {
    const b = mergeBusy([
      [busy("2026-11-16", "09:00", "10:10")],
      [busy("2026-11-16", "10:50", "12:00")],
    ]);
    // 30 minutes fit at 10:15 (until 10:45); an hour doesn't, so it goes after noon.
    expect(nextFreeSlot(b, HOUR / 2, at("2026-11-16", "09:00"), NY)).toBe(
      at("2026-11-16", "10:15"),
    );
    expect(nextFreeSlot(b, HOUR, at("2026-11-16", "09:00"), NY)).toBe(at("2026-11-16", "12:00"));
  });

  test("starts at the start when it is already free", () => {
    expect(nextFreeSlot([], HOUR, at("2026-11-16", "14:30"), NY)).toBe(at("2026-11-16", "14:30"));
  });

  test("stays inside 9:00–17:00 and skips weekends", () => {
    // Friday 16:30: an hour doesn't fit before 17:00, so Monday 9:00.
    expect(nextFreeSlot([], HOUR, at("2026-11-20", "16:30"), NY)).toBe(at("2026-11-23", "09:00"));
    // Saturday evening, before working hours: Monday 9:00.
    expect(nextFreeSlot([], HOUR, at("2026-11-21", "20:00"), NY)).toBe(at("2026-11-23", "09:00"));
    // Early morning: 9:00 the same day.
    expect(nextFreeSlot([], HOUR, at("2026-11-17", "06:00"), NY)).toBe(at("2026-11-17", "09:00"));
  });

  test("a slot ending exactly at 17:00 fits", () => {
    expect(nextFreeSlot([], HOUR, at("2026-11-16", "16:00"), NY)).toBe(at("2026-11-16", "16:00"));
  });

  test("null when nothing fits in 14 days", () => {
    const wall = [{ startMs: at("2026-11-16", "00:00"), endMs: at("2026-12-01", "00:00") }];
    expect(nextFreeSlot(wall, HOUR, at("2026-11-16", "09:00"), NY)).toBeNull();
    // Longer than the working day.
    expect(nextFreeSlot([], 9 * HOUR, at("2026-11-16", "09:00"), NY)).toBeNull();
  });

  test("searches 14 days counting the first, and no further", () => {
    // Busy through Friday 2026-11-27: Monday 11-30 would be the 15th day, too far.
    const b = [{ startMs: at("2026-11-16", "00:00"), endMs: at("2026-11-28", "00:00") }];
    expect(nextFreeSlot(b, HOUR, at("2026-11-16", "09:00"), NY)).toBeNull();
    const shorter = [{ startMs: at("2026-11-16", "00:00"), endMs: at("2026-11-27", "15:00") }];
    expect(nextFreeSlot(shorter, HOUR, at("2026-11-16", "09:00"), NY)).toBe(
      at("2026-11-27", "15:00"),
    );
  });

  test("working hours stay 9:00–17:00 on the clock across a DST change", () => {
    // New York falls back on Sunday 2026-11-01: Monday's 9:00 is 14:00 UTC, Friday's was 13:00.
    const fromFriday = at("2026-10-30", "16:30");
    const monday = nextFreeSlot([], HOUR, fromFriday, NY);
    expect(monday).toBe(at("2026-11-02", "09:00"));
    expect(new Date(monday!).getUTCHours()).toBe(14);
    expect(new Date(at("2026-10-30", "09:00")).getUTCHours()).toBe(13);
  });

  test("in the calendar's time zone, not the computer's", () => {
    const tokyo = "Asia/Tokyo";
    expect(nextFreeSlot([], HOUR, at("2026-11-16", "18:00", tokyo), tokyo)).toBe(
      at("2026-11-17", "09:00", tokyo),
    );
  });
});

test("searchRange runs from the start to midnight 14 days later in the zone", () => {
  const from = at("2026-11-16", "10:20");
  expect(searchRange(from, NY)).toEqual({ fromMs: from, toMs: at("2026-11-30", "00:00") });
});

test("plannerRange is 7:00–21:00 on the day", () => {
  expect(plannerRange("2026-11-16", NY)).toEqual({
    fromMs: at("2026-11-16", "07:00"),
    toMs: at("2026-11-16", "21:00"),
  });
});

test("plannerTime snaps a point across the day to the nearest quarter hour inside it", () => {
  expect(plannerTime(0, "2026-11-16", NY)).toBe(at("2026-11-16", "07:00"));
  expect(plannerTime(0.5, "2026-11-16", NY)).toBe(at("2026-11-16", "14:00"));
  // 3/14 of the way is 10:00; a little past still snaps to it.
  expect(plannerTime(3 / 14 + 0.002, "2026-11-16", NY)).toBe(at("2026-11-16", "10:00"));
  // The very end starts the last quarter hour, not 21:00.
  expect(plannerTime(1, "2026-11-16", NY)).toBe(at("2026-11-16", "20:45"));
});

describe("results", () => {
  const result: AvailabilityResult = {
    you: { email: "me@x.com", status: "known", busy: [busy("2026-11-16", "09:00", "10:00")] },
    guests: [
      { email: "sam@x.com", status: "known", busy: [busy("2026-11-16", "09:30", "11:00")] },
      { email: "a@other.org", status: "unknown", reason: "notFound" },
      { email: "b@other.org", status: "unknown", reason: "somethingNew" },
    ],
  };

  test("knownBusy merges you and the guests whose availability is known", () => {
    expect(knownBusy(result)).toEqual([busy("2026-11-16", "09:00", "11:00")]);
  });

  test("withoutSpan leaves the event's saved time out of everyone's busy time", () => {
    const own = busy("2026-11-16", "09:30", "10:30");
    expect(withoutSpan(result, own)).toEqual({
      you: { ...result.you, busy: [busy("2026-11-16", "09:00", "09:30")] },
      guests: [
        { ...result.guests[0], busy: [busy("2026-11-16", "10:30", "11:00")] },
        result.guests[1],
        result.guests[2],
      ],
    });
    // A stretch around the event keeps both ends.
    const inside = busy("2026-11-16", "09:15", "09:45");
    expect(withoutSpan(result, inside).you).toEqual({
      ...result.you,
      busy: [busy("2026-11-16", "09:00", "09:15"), busy("2026-11-16", "09:45", "10:00")],
    });
    expect(withoutSpan(result, null)).toBe(result);
  });

  test("unknownNote counts the guests whose availability is unknown", () => {
    expect(unknownNote(result, ["sam@x.com", "A@other.org", "b@other.org"])).toBe(
      "2 guests' availability unknown",
    );
    expect(unknownNote(result, ["sam@x.com", "a@other.org"])).toBe(
      "1 guest's availability unknown",
    );
    expect(unknownNote(result, ["sam@x.com"])).toBeNull();
  });
});
