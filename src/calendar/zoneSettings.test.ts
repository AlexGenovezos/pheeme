import { beforeEach, describe, expect, test } from "vitest";
import {
  columnLabel,
  MAX_LABEL_LENGTH,
  parseStored,
  placeName,
  travelKey,
  useZoneSettings,
  ZONES_KEY,
} from "./zoneSettings";

describe("parseStored", () => {
  test("nothing stored, or something unreadable, is no zones", () => {
    expect(parseStored(null)).toEqual({ zones: [], dismissed: [] });
    expect(parseStored("{not json")).toEqual({ zones: [], dismissed: [] });
    expect(parseStored('"text"')).toEqual({ zones: [], dismissed: [] });
  });

  test("keeps known zones once each, at most two, with trimmed labels", () => {
    const raw = JSON.stringify({
      zones: [
        { zone: "Europe/Athens", label: "  Home " },
        { zone: "Mars/Olympus", label: "" },
        { zone: "Europe/Athens", label: "again" },
        { zone: "Asia/Tokyo" },
        { zone: "Asia/Kolkata", label: "" },
      ],
      dismissed: ["UTC>Europe/Athens", 3],
    });
    expect(parseStored(raw)).toEqual({
      zones: [
        { zone: "Europe/Athens", label: "Home" },
        { zone: "Asia/Tokyo", label: "" },
      ],
      dismissed: ["UTC>Europe/Athens"],
    });
  });
});

describe("useZoneSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    useZoneSettings.setState({ zones: [], dismissed: [] });
  });

  const stored = () => JSON.parse(localStorage.getItem(ZONES_KEY) ?? "null");

  test("adds up to two zones, once each, and saves them", () => {
    const s = useZoneSettings.getState();
    s.add("Europe/Athens");
    s.add("Europe/Athens");
    s.add("Not/AZone");
    s.add("Asia/Tokyo");
    s.add("Asia/Kolkata");
    expect(useZoneSettings.getState().zones.map((z) => z.zone)).toEqual([
      "Europe/Athens",
      "Asia/Tokyo",
    ]);
    expect(stored().zones).toHaveLength(2);
  });

  test("labels are cut to fit their column, and removing frees a place", () => {
    const s = useZoneSettings.getState();
    s.add("Europe/Athens");
    s.setLabel("Europe/Athens", "Athens office");
    expect(useZoneSettings.getState().zones[0].label).toHaveLength(MAX_LABEL_LENGTH);
    s.remove("Europe/Athens");
    expect(stored().zones).toEqual([]);
  });

  test("remembers dismissed travelling notes by zone pair", () => {
    const key = travelKey("America/New_York", "Europe/Athens");
    useZoneSettings.getState().dismissTravel(key);
    useZoneSettings.getState().dismissTravel(key);
    expect(stored().dismissed).toEqual(["America/New_York>Europe/Athens"]);
  });
});

test("names: the user's label first", () => {
  const nov = Date.UTC(2026, 10, 16, 12);
  expect(columnLabel({ zone: "America/Los_Angeles", label: "" }, nov)).toBe("PST");
  expect(columnLabel({ zone: "Europe/Athens", label: " Home " }, nov)).toBe("Home");
  expect(columnLabel({ zone: "Asia/Kolkata", label: "" }, nov)).toBe("Kolkata");
  expect(placeName({ zone: "Europe/Athens", label: "" })).toBe("Athens");
  expect(placeName({ zone: "Europe/Athens", label: "Home" })).toBe("Home");
});
