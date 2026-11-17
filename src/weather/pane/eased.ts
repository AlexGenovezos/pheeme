// What snow, fog and sun share: they move at a pace that eases in when their day starts playing
// and eases out when it stops, so the snow slows to a stop rather than freezing mid-fall.
import { ease, type Ink } from "./ink";
import type { Scene } from "./scene";

export abstract class EasedScene implements Scene {
  /** How fast it moves now: 0 (still) to 1. */
  protected pace = 0;
  private playing = false;

  get still(): boolean {
    return !this.playing && this.pace === 0;
  }

  step(dt: number, playing: boolean) {
    this.playing = playing;
    this.pace = ease(this.pace, playing ? 1 : 0, dt, playing ? 0.6 : 1.2);
    if (this.pace > 0) this.move(dt * this.pace);
  }

  /** Moves everything on by `dt` seconds of the scene's own (eased) time. */
  protected abstract move(dt: number): void;

  abstract paint(ctx: CanvasRenderingContext2D, ink: Ink): void;
}

/** Keeps what's built from the theme's colours until they change. */
export function byInk<T>(build: (ink: Ink) => T): (ink: Ink) => T {
  let last: { ink: Ink; value: T } | null = null;
  return (ink) => {
    if (last?.ink !== ink) last = { ink, value: build(ink) };
    return last.value;
  };
}
