import { describe, expect, test } from "vitest";
import { findZone, parseConversion, searchZones } from "./zoneConvert";

// Monday, November 16 2026, noon UTC (7 AM in New York).
const now = Date.UTC(2026, 10, 16, 12);
const convert = (query: string, calendarZone = "America/New_York") =>
  parseConversion(query, { now, calendarZone });

describe("findZone", () => {
  test("cities in any case, ids, abbreviations", () => {
    expect(findZone("athens")).toEqual({ zone: "Europe/Athens", name: "Athens" });
    expect(findZone("New York time")?.zone).toBe("America/New_York");
    expect(findZone("asia/tokyo")?.zone).toBe("Asia/Tokyo");
    expect(findZone("pt")).toEqual({ zone: "America/Los_Angeles", name: "PT" });
    expect(findZone("IST")?.zone).toBe("Asia/Kolkata");
    expect(findZone("Ho Chi Minh")?.zone).toBe("Asia/Ho_Chi_Minh");
    expect(findZone("Gotham")).toBeNull();
  });
});

describe("parseConversion", () => {
  test("3pm PT in Athens", () => {
    const c = convert("3pm PT in Athens");
    expect(c?.ms).toBe(Date.UTC(2026, 10, 16, 23));
    expect(c?.text).toBe("3:00 PM PT is 1:00 AM in Athens (+1 day)");
  });

  test("15:00 London to Tokyo", () => {
    expect(convert("15:00 London to Tokyo")?.text).toBe(
      "3:00 PM London is 12:00 AM in Tokyo (+1 day)",
    );
  });

  test("a time with no zone is the calendar's", () => {
    expect(convert("noon in New York", "Europe/Athens")?.text).toBe(
      "12:00 PM Athens is 5:00 AM in New York",
    );
  });

  test("any case, and an arrow", () => {
    expect(convert("3PM pt IN athens")?.ms).toBe(Date.UTC(2026, 10, 16, 23));
    expect(convert("9am ho chi minh -> paris")?.text).toBe(
      "9:00 AM Ho Chi Minh is 3:00 AM in Paris",
    );
  });

  test("half-hour zones", () => {
    expect(convert("9am IST in New York")?.text).toBe(
      "9:00 AM IST is 10:30 PM in New York (−1 day)",
    );
    expect(convert("10:15 Kolkata to UTC")?.text).toBe("10:15 AM Kolkata is 4:45 AM in UTC");
  });

  test("a date across a DST change uses that day's offsets", () => {
    // Between the US change (March 8) and Europe's (March 29), New York is 4 hours behind London.
    const march = convert("March 15 2026 9am ET in London");
    expect(march?.ms).toBe(Date.UTC(2026, 2, 15, 13));
    expect(march?.text).toBe("Sun, Mar 15, 9:00 AM ET is 1:00 PM in London");
    // In July PT is PDT (−7) and London BST (+1).
    expect(convert("July 1 2026 3pm PT in London")?.ms).toBe(Date.UTC(2026, 6, 1, 22));
  });

  test("a weekday alone is the next one", () => {
    expect(convert("Friday 9am Tokyo in New York")?.ms).toBe(Date.UTC(2026, 10, 20, 0));
  });

  test("now", () => {
    expect(convert("now in Tokyo")?.text).toBe("7:00 AM New York is 9:00 PM in Tokyo");
  });

  test("anything else isn't a conversion", () => {
    for (const q of [
      "",
      "archive",
      "3pm",
      "3pm in Gotham",
      "go to inbox",
      "3pm HST in Athens",
      "meeting notes in Athens",
    ])
      expect(convert(q)).toBeNull();
  });
});

describe("searchZones", () => {
  test("by city, region, abbreviation or offset", () => {
    expect(searchZones("athens", now)[0]).toEqual({
      zone: "Europe/Athens",
      label: "Athens · Europe · UTC+2",
    });
    expect(searchZones("kolk", now)[0].label).toBe("Kolkata · Asia · UTC+5:30");
    expect(searchZones("PT", now)[0].zone).toBe("America/Los_Angeles");
    expect(searchZones("utc+5:45", now).map((z) => z.zone)).toContain("Asia/Kathmandu");
    expect(searchZones("  ", now)).toEqual([]);
    expect(searchZones("a", now, 5)).toHaveLength(5);
  });
});
