import { describe as group, expect, it } from "vitest";
import type { WindowProblem } from "./tauri";
import {
  createProblemLog,
  describe,
  MAX_PER_MINUTE,
  REPEAT_WINDOW_MS,
  STALL_TICK_MS,
} from "./windowProblems";

function setup({ visible = true, focused = true } = {}) {
  let now = 0;
  const reports: WindowProblem[] = [];
  const state = { visible, focused };
  const timers = { running: 0 };
  const log = createProblemLog({
    now: () => now,
    every: () => {
      timers.running += 1;
      return () => {
        timers.running -= 1;
      };
    },
    visible: () => state.visible,
    focused: () => state.focused,
    report: (p) => reports.push(p),
  });
  return {
    log,
    reports,
    state,
    timers,
    advance(ms: number) {
      now += ms;
    },
  };
}

group("window problems", () => {
  it("reports an uncaught error once and folds repeats into the next report", () => {
    const s = setup();
    s.log.error("error", new TypeError("x is undefined"));
    s.log.error("error", new TypeError("x is undefined"));
    s.log.error("error", new TypeError("x is undefined"));
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ kind: "error", repeats: 0, visible: true });
    expect(s.reports[0].message).toMatch(/^TypeError: x is undefined/);
    s.advance(REPEAT_WINDOW_MS);
    s.log.error("error", new TypeError("x is undefined"));
    expect(s.reports[1]).toMatchObject({ repeats: 2 });
  });

  it("caps reports per minute", () => {
    const s = setup();
    for (let i = 0; i < MAX_PER_MINUTE + 5; i++) s.log.error("rejection", `failure ${i}`);
    expect(s.reports).toHaveLength(MAX_PER_MINUTE);
    s.advance(60_000);
    s.log.error("rejection", "later");
    expect(s.reports).toHaveLength(MAX_PER_MINUTE + 1);
  });

  it("drops browser noise", () => {
    const s = setup();
    s.log.error("error", "ResizeObserver loop completed with undelivered notifications.");
    expect(s.reports).toHaveLength(0);
  });

  it("reports a late tick as a stall only while the window is visible and focused", () => {
    const s = setup();
    s.advance(STALL_TICK_MS + 300);
    s.log.tick();
    expect(s.reports).toHaveLength(0);
    s.advance(STALL_TICK_MS + 2500);
    s.log.tick();
    expect(s.reports).toEqual([
      { kind: "stall", message: null, lagMs: 2500, repeats: 0, visible: true, focused: true },
    ]);
    s.state.focused = false;
    s.advance(STALL_TICK_MS + 5000);
    s.log.tick();
    expect(s.reports).toHaveLength(1);
  });

  it("ticks only while watching", () => {
    const s = setup({ focused: false });
    expect(s.timers.running).toBe(0);
    s.log.watch(true);
    s.log.watch(true);
    expect(s.timers.running).toBe(1);
    s.log.watch(false);
    expect(s.timers.running).toBe(0);
  });

  it("describes errors with their first frames and without the app's origin", () => {
    const e = new Error("boom");
    e.stack =
      "Error: boom\n    at f (tauri://localhost/assets/index.js:1:2)\n    at g (http://localhost:1420/src/x.ts:3:4)\n    at h\n    at i";
    expect(describe(e)).toBe(
      "Error: boom | at f (assets/index.js:1:2) | at g (src/x.ts:3:4) | at h",
    );
    expect(describe(e, false)).toBe(
      "Error | at f (assets/index.js:1:2) | at g (src/x.ts:3:4) | at h",
    );
    // A message spanning lines never leaks into the frames; WebKit's frames are `fn@url:1:2`.
    const multi = new Error("secret\nmore secret");
    multi.stack = "f@tauri://localhost/assets/index.js:1:2\nglobal code@tauri://localhost/x.js:3:4";
    expect(describe(multi, false)).toBe("Error | f@assets/index.js:1:2 | global code@x.js:3:4");
    // A real V8 stack: the message (with an `@`, over two lines) heads it.
    const v8 = new TypeError("cell bob@example.com\nSalary: 92,000");
    expect(describe(v8, false)).toMatch(/^TypeError \| at /);
    expect(describe(v8, false)).not.toMatch(/bob|Salary/);
    expect(describe({ code: 1 })).toBe('{"code":1}');
    expect(describe("x".repeat(700))).toHaveLength(601);
  });
});
