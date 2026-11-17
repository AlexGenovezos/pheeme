import { describe, expect, test } from "vitest";
import type { TemplateFields } from "../lib/tauri";
import { zonedMs } from "./dates";
import { newForm } from "./eventForm";
import {
  describeLength,
  describeTemplate,
  templateFields,
  templateTimes,
  withTemplate,
} from "./templates";

const tz = "America/New_York";
const at = (date: string, h: number, m = 0) => zonedMs(date, h * 60 + m, tz);

const gym: TemplateFields = {
  summary: "Gym",
  allDay: false,
  length: 45,
  accountId: "acc",
  calendarId: "fitness",
  guests: [{ name: "Sam", address: "sam@example.com", optional: true }],
  guestsCanModify: false,
  guestsCanInviteOthers: true,
  guestsCanSeeOtherGuests: true,
  meet: true,
  location: "Mission Cliffs",
  description: "Legs",
  colorId: "10",
  remindersDefault: false,
  reminders: [{ method: "popup", minutes: 60 }],
  transparency: "opaque",
  visibility: "private",
};

describe("templateFields", () => {
  test("keeps the details and the length, not when it is", () => {
    const form = {
      ...newForm({
        accountId: "acc",
        calendarId: "fitness",
        zone: tz,
        allDay: false,
        start: at("2026-11-12", 7),
        end: at("2026-11-12", 7, 45),
      }),
      summary: "  Gym ",
      guests: [{ name: "Sam", address: "sam@example.com", optional: true }],
      meet: true,
      location: "Mission Cliffs",
      description: "Legs",
      colorId: "10",
      remindersDefault: false,
      reminders: [{ method: "popup" as const, amount: 1, unit: "hours" as const }],
      visibility: "private" as const,
    };
    expect(templateFields(form)).toEqual(gym);
  });

  test("an all-day event keeps its number of days", () => {
    const form = newForm({
      accountId: "acc",
      calendarId: "fitness",
      zone: tz,
      allDay: true,
      startDate: "2026-11-12",
      endDate: "2026-11-14",
    });
    expect(templateFields(form)).toMatchObject({ allDay: true, length: 3 });
  });
});

describe("templateTimes", () => {
  const fallback = at("2026-11-11", 12, 30);
  const unsaid = { lengthSaid: false, length: null };

  test("the template's length from the sentence's start", () => {
    const when = { allDay: false as const, start: at("2026-11-13", 7), end: at("2026-11-13", 8) };
    expect(templateTimes(gym, when, unsaid, fallback, tz)).toEqual({
      allDay: false,
      start: at("2026-11-13", 7),
      end: at("2026-11-13", 7, 45),
    });
  });

  test("a length or end the sentence gives wins", () => {
    const when = { allDay: false as const, start: at("2026-11-13", 7), end: at("2026-11-13", 9) };
    expect(templateTimes(gym, when, { lengthSaid: true, length: null }, fallback, tz)).toBe(when);
  });

  test("“gym friday for 30 min”: the day at 9 AM, for the length said", () => {
    const friday = { allDay: true as const, date: "2026-11-13", lastDate: "2026-11-13" };
    expect(
      templateTimes(gym, friday, { lengthSaid: true, length: 30 * 60_000 }, fallback, tz),
    ).toEqual({ allDay: false, start: at("2026-11-13", 9), end: at("2026-11-13", 9, 30) });
  });

  test("a day alone starts a timed template at 9 AM; nothing said, the usual new-event time", () => {
    const friday = { allDay: true as const, date: "2026-11-13", lastDate: "2026-11-13" };
    expect(templateTimes(gym, friday, unsaid, fallback, tz)).toEqual({
      allDay: false,
      start: at("2026-11-13", 9),
      end: at("2026-11-13", 9, 45),
    });
    expect(templateTimes(gym, null, unsaid, fallback, tz)).toEqual({
      allDay: false,
      start: fallback,
      end: fallback + 45 * 60_000,
    });
  });

  test("an all-day template spans its days from the day said", () => {
    const trip = { ...gym, allDay: true, length: 3 };
    const friday = { allDay: true as const, date: "2026-11-13", lastDate: "2026-11-13" };
    expect(templateTimes(trip, friday, unsaid, fallback, tz)).toEqual({
      allDay: true,
      date: "2026-11-13",
      lastDate: "2026-11-15",
    });
    expect(templateTimes(trip, null, unsaid, fallback, tz)).toEqual({
      allDay: true,
      date: "2026-11-11",
      lastDate: "2026-11-13",
    });
  });
});

describe("withTemplate", () => {
  const form = newForm({
    accountId: "default",
    calendarId: "primary",
    zone: tz,
    allDay: false,
    start: at("2026-11-13", 7),
    end: at("2026-11-13", 7, 45),
  });

  test("fills the details and keeps the times", () => {
    const filled = withTemplate(form, gym, () => true);
    expect(filled).toMatchObject({
      accountId: "acc",
      calendarId: "fitness",
      summary: "Gym",
      meet: true,
      location: "Mission Cliffs",
      reminders: [{ method: "popup", amount: 1, unit: "hours" }],
      startMinutes: 7 * 60,
      endMinutes: 7 * 60 + 45,
    });
  });

  test("a calendar that can't take events any more leaves the default one", () => {
    expect(withTemplate(form, gym, () => false)).toMatchObject({
      accountId: "default",
      calendarId: "primary",
    });
  });
});

describe("describing templates", () => {
  test("lengths", () => {
    expect(describeLength({ allDay: false, length: 45 })).toBe("45 min");
    expect(describeLength({ allDay: false, length: 60 })).toBe("1 hr");
    expect(describeLength({ allDay: false, length: 90 })).toBe("1 hr 30 min");
    expect(describeLength({ allDay: true, length: 1 })).toBe("All day");
    expect(describeLength({ allDay: true, length: 3 })).toBe("3 days");
  });

  test("one line, its calendar named, left out or the default", () => {
    expect(describeTemplate(gym, "Fitness")).toBe(
      "45 min · Fitness · 1 guest · Google Meet · Mission Cliffs",
    );
    expect(describeTemplate(gym, null)).toBe(
      "45 min · Default calendar · 1 guest · Google Meet · Mission Cliffs",
    );
    expect(describeTemplate({ ...gym, guests: [], meet: false, location: "" }, undefined)).toBe(
      "45 min",
    );
  });
});
