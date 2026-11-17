// Fog seen through the window: the glass misted over with condensation (a milky veil, thicker in
// patches, with a fine grain of droplets and a few beads), and banks of mist drifting past behind.
import { random } from "../WeatherArt";
import { EasedScene, byInk } from "./eased";
import { DROP_SCALE, dotSprite, dropSprite, type Ink, rgba, stamp } from "./ink";
import type { Intensity } from "../codes";

interface Wisp {
  x: number;
  y: number;
  rx: number;
  ry: number;
  vx: number;
  alpha: number;
}

interface Dot {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

/** Condensation droplets and beads per 10,000 px², light to heavy. */
const FILM = [140, 220, 320];
const BEADS = [2, 3, 5];
/** How strongly the mist and the film show, light to heavy. */
const STRENGTH = [0.7, 0.85, 1];

export class FogScene extends EasedScene {
  private wisps: Wisp[] = [];
  private film: Dot[] = [];
  private patches: { x: number; y: number; r: number }[];
  private beads: Dot[] = [];
  private strength: number;
  private sprites = byInk((ink: Ink) => ({
    mist: dotSprite(ink.fog, 0),
    drop: dropSprite(ink),
    film: this.paintFilm(ink),
  }));

  constructor(
    private w: number,
    private h: number,
    intensity: Intensity,
    seed: string,
  ) {
    super();
    const rand = random(seed);
    const level = intensity - 1;
    const area = (w * h) / 10_000;
    this.strength = STRENGTH[level];
    const wisps = Math.max(3, Math.round(area * 1.1));
    for (let i = 0; i < wisps; i++) {
      this.wisps.push({
        x: rand() * w,
        y: rand() * h,
        rx: 70 + rand() * 140,
        ry: 24 + rand() * 40,
        vx: 5 + rand() * 10,
        alpha: 0.22 + rand() * 0.2,
      });
    }
    // Patches where the glass is more misted, so the film isn't an even grain.
    const patches = (this.patches = Array.from({ length: 3 + Math.round(area / 6) }, () => ({
      x: rand() * w,
      y: rand() * h,
      r: 40 + rand() * 90,
    })));
    const thick = (x: number, y: number) =>
      patches.reduce((t, p) => Math.max(t, 1 - Math.hypot(x - p.x, y - p.y) / p.r), 0);
    for (let i = Math.round(area * FILM[level]); i > 0; i--) {
      const x = rand() * w;
      const y = rand() * h;
      if (rand() > 0.35 + 0.65 * thick(x, y)) continue;
      this.film.push({ x, y, r: 0.25 + rand() * 0.45, alpha: 0.1 + rand() * 0.2 });
    }
    for (let i = Math.round(area * BEADS[level]); i > 0; i--) {
      this.beads.push({ x: rand() * w, y: rand() * h, r: 1 + rand() * 1.6, alpha: 0.8 });
    }
  }

  /** The film never moves: drawn once, at the screen's resolution, and stamped each frame. */
  private paintFilm(ink: Ink): HTMLCanvasElement {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.width = Math.ceil(this.w * dpr);
    c.height = Math.ceil(this.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    ctx.scale(dpr, dpr);
    // The veil: an even haze, thicker where the patches are.
    ctx.fillStyle = rgba(ink.fog, 0.07 * this.strength);
    ctx.fillRect(0, 0, this.w, this.h);
    for (const p of this.patches) {
      const haze = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 1.3);
      haze.addColorStop(0, rgba(ink.fog, 0.16 * this.strength));
      haze.addColorStop(1, rgba(ink.fog, 0));
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    for (const d of this.film) {
      ctx.fillStyle = rgba(ink.shine, d.alpha * this.strength);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    return c;
  }

  protected move(dt: number) {
    for (const m of this.wisps) {
      m.x += m.vx * dt;
      if (m.x - m.rx > this.w) m.x = -m.rx;
    }
  }

  paint(ctx: CanvasRenderingContext2D, ink: Ink) {
    const { mist, drop, film } = this.sprites(ink);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const m of this.wisps) {
      ctx.globalAlpha = m.alpha * this.strength;
      stamp(ctx, mist, m.x, m.y, m.rx * 2, m.ry * 2);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(film, 0, 0, this.w, this.h);
    for (const b of this.beads) stamp(ctx, drop, b.x, b.y, b.r * DROP_SCALE);
  }
}
