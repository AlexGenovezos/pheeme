import { describe, expect, it } from "vitest";
import type { CalendarWriteShown } from "../lib/tauri";
import { timeWrite } from "./writeTiming";

function clock(...times: number[]) {
  return () => times.shift() ?? 0;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("timeWrite", () => {
  it("splits the wait into Google's answer and the redraw", async () => {
    const sent: CalendarWriteShown[] = [];
    const timer = timeWrite("delete", "following", clock(100, 4_100, 4_350), (r) => sent.push(r));
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

  it("reports a refused write without a redraw, once", async () => {
    const sent: CalendarWriteShown[] = [];
    const timer = timeWrite("create", null, clock(0, 900), (r) => sent.push(r));
    timer.done("failed");
    timer.done("shown");
    await settle();
    expect(sent).toEqual([
      { op: "create", scope: null, outcome: "failed", writeMs: 900, redrawMs: null, totalMs: 900 },
    ]);
  });

  it("never lets the log break the change", async () => {
    const timer = timeWrite("copy", null, clock(0, 1, 2), () => {
      throw new Error("ipc down");
    });
    timer.wrote();
    expect(() => timer.done("shown")).not.toThrow();
    await settle();
  });
});
