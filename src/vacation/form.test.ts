import { describe, expect, test } from "vitest";
import type { VacationResponder } from "../lib/tauri";
import { dateOf, endOfDate, isOn, isWaiting, lastDateOf, startOfDate } from "./dates";
import { formOf, formProblem, responderOf, sameForm } from "./form";

const off: VacationResponder = {
  enabled: false,
  subject: "",
  html: "",
  onlyContacts: false,
  onlyDomain: false,
  startMs: null,
  endMs: null,
  workspace: false,
};

describe("days", () => {
  test("the first day starts at local midnight and the last runs to the next one", () => {
    expect(startOfDate("2026-12-01")).toBe(new Date(2026, 11, 1).getTime());
    expect(endOfDate("2026-12-31")).toBe(new Date(2027, 0, 1).getTime());
    expect(dateOf(startOfDate("2026-12-01"))).toBe("2026-12-01");
    expect(lastDateOf(endOfDate("2026-12-08"))).toBe("2026-12-08");
  });

  test("a responder is on until its end, and waits before its first day", () => {
    const now = new Date(2026, 11, 5, 12).getTime();
    const on = { ...off, enabled: true, startMs: startOfDate("2026-12-01") };
    expect(isOn(on, now)).toBe(true);
    expect(isOn({ ...on, endMs: endOfDate("2026-12-04") }, now)).toBe(false);
    expect(isOn({ ...on, enabled: false }, now)).toBe(false);
    expect(isWaiting(on, now)).toBe(false);
    expect(isWaiting({ ...on, startMs: startOfDate("2026-12-06") }, now)).toBe(true);
  });
});

describe("form", () => {
  test("reads Gmail's responder and saves the same back", () => {
    const r: VacationResponder = {
      enabled: true,
      subject: "Away",
      html: "<p>Back Monday</p>",
      onlyContacts: true,
      onlyDomain: true,
      startMs: startOfDate("2026-12-01"),
      endMs: endOfDate("2026-12-08"),
      workspace: true,
    };
    const form = formOf(r);
    expect(form).toMatchObject({ firstDay: "2026-12-01", ends: true, lastDay: "2026-12-08" });
    expect(responderOf(form, true)).toEqual(r);
  });

  test("no first day reads as today; no last day saves none", () => {
    const now = new Date(2026, 10, 26, 15).getTime();
    const form = formOf(off, now);
    expect(form).toMatchObject({ firstDay: "2026-11-26", ends: false, lastDay: "2026-11-26" });
    const saved = responderOf({ ...form, enabled: true, subject: "  Out  " }, false);
    expect(saved).toMatchObject({
      startMs: startOfDate("2026-11-26"),
      endMs: null,
      subject: "Out",
    });
  });

  test("a personal account never limits replies to its domain", () => {
    expect(responderOf({ ...formOf(off), onlyDomain: true }, false).onlyDomain).toBe(false);
  });

  test("a last day before the first is refused; untouched fields match", () => {
    const form = formOf(off, new Date(2026, 10, 26).getTime());
    expect(formProblem({ ...form, ends: true, lastDay: "2026-11-25" })).toMatch(/last day/);
    expect(formProblem({ ...form, ends: false, lastDay: "2026-11-25" })).toBeNull();
    expect(sameForm(form, { ...form })).toBe(true);
    expect(sameForm(form, { ...form, subject: "x" })).toBe(false);
  });
});
