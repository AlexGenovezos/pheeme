import { describe, expect, it } from "vitest";
import type { CalendarWriteShown } from "../lib/tauri";
import { timeWrite } from "./writeTiming";

function clock(...times: number[]) {
  return () => times.shift() ?? 0;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const paintNow = (f: (painted: boolean) => void) => f(true);

describe("timeWrite", () => {
  it("splits the wait into Google's answer and the redraw", async () => {
    const sent: CalendarWriteShown[] = [];
    const timer = timeWrite(
      "delete",
      "following",
      clock(100, 4_100, 4_350),
      (r) => sent.push(r),
      paintNow,
    );
    timer.wrote();
    timer.done("shown");
    await settle();
    expect(sent).toEqual([
      {
        op: "delete",
        scope: "following",
        outcome: "shown",
        writeMs: 4_000,
        redrawMs: 250,
        totalMs: 4_250,
      },
    ]);
  });

  it("measures a shown change only once the frame has painted", () => {
    const sent: CalendarWriteShown[] = [];
    let paint: ((painted: boolean) => void) | null = null;
    const timer = timeWrite(
      "create",
      null,
      clock(0, 10, 50),
      (r) => sent.push(r),
      (f) => (paint = f),
    );
    timer.wrote();
    timer.done("shown");
    expect(sent).toEqual([]);
    paint!(true);
    expect(sent[0]).toMatchObject({ redrawMs: 40, totalMs: 50 });
  });

  it("says when a hidden window painted no frame in time", () => {
    const sent: CalendarWriteShown[] = [];
    const timer = timeWrite(
      "delete",
      null,
      clock(0, 10, 1_010),
      (r) => sent.push(r),
      (f) => f(false),
    );
    timer.wrote();
    timer.done("shown");
    expect(sent[0]).toMatchObject({ outcome: "not_painted", redrawMs: null, totalMs: 1_010 });
  });

  it("reports a refused write, or one the calendar didn't redraw, at once and once", () => {
    const sent: CalendarWriteShown[] = [];
    const failed = timeWrite("create", null, clock(0, 900), (r) => sent.push(r), paintNow);
    failed.done("failed");
    failed.done("shown");
    const stale = timeWrite("respond", null, clock(0, 300, 800), (r) => sent.push(r), paintNow);
    stale.wrote();
    stale.done("not_redrawn");
    expect(sent).toEqual([
      { op: "create", scope: null, outcome: "failed", writeMs: 900, redrawMs: null, totalMs: 900 },
      {
        op: "respond",
        scope: null,
        outcome: "not_redrawn",
        writeMs: 300,
        redrawMs: null,
        totalMs: 800,
      },
    ]);
  });

  it("never lets the log break the change", async () => {
    const timer = timeWrite(
      "copy",
      null,
      clock(0, 1, 2),
      () => {
        throw new Error("ipc down");
      },
      paintNow,
    );
    timer.wrote();
    expect(() => timer.done("shown")).not.toThrow();
    await settle();
  });
});
