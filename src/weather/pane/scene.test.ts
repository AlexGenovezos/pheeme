import { describe, expect, test } from "vitest";
import type { RunKind } from "../hourly";
import { createScene } from "./scene";

const KINDS: RunKind[] = ["rain", "storm", "snow", "fog", "sun"];

describe("scenes on the pane", () => {
  test.each(KINDS)("%s is still until it plays, and winds down to still when it stops", (kind) => {
    const scene = createScene(kind, 300, 500, 2, "2026-11-17|840");
    expect(scene.still).toBe(true);
    for (let t = 0; t < 3; t += 1 / 60) scene.step(1 / 60, true);
    expect(scene.still).toBe(false);
    let wound = 0;
    while (!scene.still && wound < 10) {
      scene.step(1 / 60, false);
      wound += 1 / 60;
    }
    // A few seconds at most: drips come to rest, snow and mist slow, a flash fades.
    expect(wound).toBeLessThan(5);
  });
});
