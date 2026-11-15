import { describe, expect, test } from "vitest";
import {
  dayShift,
  formatGap,
  formatGutterTime,
  formatOffset,
  gutterTimes,
  offsetMinutes,
  travelNote,
  zoneCity,
  zoneIds,
  zoneRegion,
} from "./zones";

// Monday, November 16 2026, noon UTC: New York on EST (−5), Athens on EET (+2).
const NOV = Date.UTC(2026, 10, 16, 12);

describe("zone names", () => {
  test("a zone's city and region", () => {
    expect(zoneCity("America/New_York")).toBe("New York");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCity("UTC")).toBe("UTC");
    expect(zoneCity("Etc/GMT+3")).toBe("GMT+3");
    expect(zoneRegion("America/Argentina/Buenos_Aires")).toBe("America, Argentina");
    expect(zoneRegion("UTC")).toBe("");
  });

  test("every zone the runtime knows, with UTC", () => {
    const ids = zoneIds(["Europe/Athens"]);
    expect(ids).toContain("UTC");
    expect(ids).toContain("Asia/Kolkata");
    expect(ids.filter((z) => z === "Europe/Athens")).toHaveLength(1);
  });

  test("offsets, half hours included", () => {
    expect(offsetMinutes(NOV, "America/New_York")).toBe(-300);
    expect(offsetMinutes(NOV, "Asia/Kolkata")).toBe(330);
    expect(offsetMinutes(Date.UTC(2026, 6, 1), "America/New_York")).toBe(-240);
    expect(formatOffset(330)).toBe("UTC+5:30");
    expect(formatOffset(-180)).toBe("UTC−3");
    expect(formatOffset(0)).toBe("UTC");
  });

  test("day shifts", () => {
    expect(dayShift("2026-11-16", "2026-11-17")).toBe("+1 day");
    expect(dayShift("2026-11-16", "2026-11-15")).toBe("−1 day");
    expect(dayShift("2026-11-16", "2026-11-16")).toBe("");
  });
});

describe("gutter times", () => {
  test("each hour line of the main zone in another zone", () => {
    const athens = gutterTimes("2026-11-16", "America/New_York", "Europe/Athens");
    expect(athens).toHaveLength(24);
    expect(athens[0]).toEqual({ hour: 7, minute: 0 });
    expect(athens[17]).toEqual({ hour: 0, minute: 0 });
  });

  test("half and three-quarter hour zones land between hours", () => {
    expect(gutterTimes("2026-11-16", "America/New_York", "Asia/Kolkata")[9]).toEqual({
      hour: 19,
      minute: 30,
    });
    expect(gutterTimes("2026-11-16", "UTC", "Asia/Kathmandu")[0]).toEqual({ hour: 5, minute: 45 });
  });

  test("follows the day's DST: New York is 4 hours from London between their changes", () => {
    // The US moved its clocks on March 8 2026, Europe only on March 29.
    expect(gutterTimes("2026-03-15", "America/New_York", "Europe/London")[9]).toEqual({
      hour: 13,
      minute: 0,
    });
    expect(gutterTimes("2026-04-15", "America/New_York", "Europe/London")[9]).toEqual({
      hour: 14,
      minute: 0,
    });
  });

  test("labels", () => {
    expect(formatGutterTime({ hour: 14, minute: 0 })).toBe("2 PM");
    expect(formatGutterTime({ hour: 19, minute: 30 })).toBe("7:30 PM");
  });
});

describe("travelling note", () => {
  test("says how far ahead or behind the computer is", () => {
    expect(travelNote("America/New_York", "Europe/Athens", NOV)).toBe(
      "Your computer is on Athens time, 7 hours ahead of your calendar (New York).",
    );
    expect(travelNote("Asia/Kolkata", "Europe/London", NOV)).toBe(
      "Your computer is on London time, 5 hours 30 minutes behind your calendar (Kolkata).",
    );
  });

  test("nothing when the clocks agree, even under another name", () => {
    expect(travelNote("America/New_York", "America/Toronto", NOV)).toBeNull();
    expect(travelNote("UTC", "UTC", NOV)).toBeNull();
  });

  test("gaps", () => {
    expect(formatGap(60)).toBe("1 hour");
    expect(formatGap(-45)).toBe("45 minutes");
  });
});

test("old zone names read as the new ones", () => {
  expect(zoneCity("Asia/Calcutta")).toBe("Kolkata");
  expect(zoneIds()).not.toContain("Asia/Calcutta");
});
