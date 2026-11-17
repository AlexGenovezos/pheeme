// The weather in a band of hours, seen through a window pane: one scene per kind, each a small
// seeded simulation the canvas in Pane.tsx steps and paints. A scene moves only while its day
// plays; when the day stops it winds down by itself (drips come to rest, snow and mist slow to a
// stop, a flash fades) instead of freezing mid-motion, then reports `still` so the frames stop.
import type { Intensity } from "../codes";
import type { RunKind } from "../hourly";
import type { Ink } from "./ink";
import { RainScene } from "./rain";
import { FogScene } from "./fog";
import { SnowScene } from "./snow";
import { SunScene } from "./sun";

export interface Scene {
  /** The scene `dt` seconds on; with `playing` false it winds down. */
  step(dt: number, playing: boolean): void;
  paint(ctx: CanvasRenderingContext2D, ink: Ink): void;
  /** Nothing is moving: no more frames until it plays again. */
  readonly still: boolean;
}

export function createScene(
  kind: RunKind,
  w: number,
  h: number,
  intensity: Intensity,
  seed: string,
): Scene {
  const key = `${seed}|${kind}|${Math.round(w)}x${Math.round(h)}`;
  switch (kind) {
    case "rain":
      return new RainScene(w, h, intensity, key, false);
    case "storm":
      // A storm is never light rain.
      return new RainScene(w, h, Math.max(intensity, 2) as Intensity, key, true);
    case "snow":
      return new SnowScene(w, h, intensity, key);
    case "fog":
      return new FogScene(w, h, intensity, key);
    case "sun":
      return new SunScene(w, h, intensity, key);
  }
}
