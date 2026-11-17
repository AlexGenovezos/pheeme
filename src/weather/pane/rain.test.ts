import { describe, expect, test } from "vitest";
import { createGlass, isStill, step } from "./rain";

const run = (g: ReturnType<typeof createGlass>, seconds: number, raining: boolean) => {
  for (let t = 0; t < seconds; t += 1 / 60) step(g, 1 / 60, raining);
};

describe("rain on the glass", () => {
  test("the same day and size start from the same pane, heavier rain from more water", () => {
    const a = createGlass(300, 400, 2, "2026-11-17|840");
    const b = createGlass(300, 400, 2, "2026-11-17|840");
    expect(a.beads).toEqual(b.beads);
    expect(createGlass(300, 400, 3, "x").beads.length).toBeGreaterThan(
      createGlass(300, 400, 1, "x").beads.length,
    );
    expect(isStill(a)).toBe(true);
  });

  test("while it rains drips run down; when it stops they come to rest and the streaks dry", () => {
    const g = createGlass(300, 600, 3, "storm");
    let ran = false;
    for (let t = 0; t < 4; t += 1 / 60) {
      step(g, 1 / 60, true);
      ran ||= g.drips.some((d) => d.vy > 0);
    }
    expect(ran).toBe(true);
    expect(g.beads.length).toBeLessThanOrEqual(g.cap);
    run(g, 3, false);
    expect(isStill(g)).toBe(true);
    // Resting stays at rest.
    const beads = g.beads.map((b) => ({ ...b }));
    run(g, 1, false);
    expect(g.beads).toEqual(beads);
  });
});
