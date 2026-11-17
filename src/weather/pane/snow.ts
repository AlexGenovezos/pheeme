// Snow seen through the window: flakes falling outside at three depths (far ones small and
// faint, near ones big and soft, out of focus) swaying as they come down, and a few flakes
// caught on the glass as crystals. While it plays, now and then a near flake lands on the pane.
import { random } from "../WeatherArt";
import { EasedScene, byInk } from "./eased";
import { dotSprite, type Ink, rgba, stamp } from "./ink";
import type { Intensity } from "../codes";

interface Flake {
  x: number;
  y: number;
  r: number;
  /** 0 far away to 1 just outside the glass. */
  depth: number;
  sway: number;
  phase: number;
  freq: number;
}

interface Crystal {
  x: number;
  y: number;
  r: number;
  turn: number;
  /** When it landed, s; absent for those already there. */
  born?: number;
}

/** Falling flakes and flakes on the glass per 10,000 px², light to heavy. */
const FLAKES = [10, 18, 30];
const CRYSTALS = [1.2, 2, 3.5];
/** Near flakes landing on the glass per second per 10,000 px². */
const LANDINGS = [0.25, 0.45, 0.8];
/** How long a landing flake takes to settle, s. */
const LAND_S = 0.25;

export class SnowScene extends EasedScene {
  private flakes: Flake[] = [];
  private crystals: Crystal[] = [];
  private cap: number;
  private time = 0;
  private rand: () => number;
  private sprites = byInk((ink: Ink) => ({
    crisp: dotSprite(ink.snow, 0.45),
    soft: dotSprite(ink.snow, 0.05),
  }));

  constructor(
    private w: number,
    private h: number,
    private intensity: Intensity,
    seed: string,
  ) {
    super();
    const rand = (this.rand = random(seed));
    const area = (w * h) / 10_000;
    const level = intensity - 1;
    for (let i = Math.round(area * FLAKES[level]); i > 0; i--) {
      const depth = rand();
      this.flakes.push({
        x: rand() * w,
        y: rand() * h,
        r: 0.6 + depth * 2.4 + rand() * 0.5,
        depth,
        sway: 2 + depth * 7,
        phase: rand() * Math.PI * 2,
        freq: 0.6 + rand() * 0.9,
      });
    }
    // Far first, so the near ones fall in front.
    this.flakes.sort((a, b) => a.depth - b.depth);
    for (let i = Math.round(area * CRYSTALS[level]); i > 0; i--) this.crystals.push(this.crystal());
    this.cap = Math.max(4, Math.round(this.crystals.length * 1.8));
  }

  private crystal(born?: number): Crystal {
    const { rand } = this;
    return { x: rand() * this.w, y: rand() * this.h, r: 2 + rand() * 2.2, turn: rand(), born };
  }

  protected move(dt: number) {
    this.time += dt;
    const fall = 0.85 + this.intensity * 0.15;
    for (const f of this.flakes) {
      f.y += (8 + f.depth * 26) * fall * dt;
      f.phase += f.freq * dt;
      if (f.y - f.r > this.h) {
        f.y = -f.r;
        f.x = this.rand() * this.w;
      }
    }
    const landings = LANDINGS[this.intensity - 1] * ((this.w * this.h) / 10_000) * dt;
    if (this.crystals.length < this.cap && this.rand() < landings) {
      this.crystals.push(this.crystal(this.time));
    }
  }

  paint(ctx: CanvasRenderingContext2D, ink: Ink) {
    const { crisp, soft } = this.sprites(ink);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const f of this.flakes) {
      const x = f.x + Math.sin(f.phase) * f.sway;
      // The nearest are out of focus: bigger, softer and fainter.
      const near = f.depth > 0.82;
      ctx.globalAlpha = near ? 0.4 : 0.3 + f.depth * 0.55;
      stamp(ctx, near ? soft : crisp, x, f.y, f.r * (near ? 3.4 : 2.2));
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";
    for (const c of this.crystals) {
      const landing = c.born === undefined ? 1 : Math.min(1, (this.time - c.born) / LAND_S);
      drawCrystal(ctx, ink, c, landing);
    }
  }
}

/** A six-armed crystal on the glass, with a small branch on each arm. */
function drawCrystal(ctx: CanvasRenderingContext2D, ink: Ink, c: Crystal, landing: number) {
  const r = c.r * (1.4 - 0.4 * landing);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.turn * Math.PI);
  ctx.globalAlpha = 0.35 + 0.55 * landing;
  // A faint shade first, so it shows on a light pane too.
  for (const [color, width, dx] of [
    [rgba(ink.shade, 0.25), 1.6, 0.4],
    [rgba(ink.snow, 0.95), 0.8, 0],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let a = 0; a < 6; a++) {
      const angle = (a * Math.PI) / 3;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.moveTo(dx, dx);
      ctx.lineTo(cos * r + dx, sin * r + dx);
      // The branch: off the arm at 60% of its length, both ways.
      const bx = cos * r * 0.6 + dx;
      const by = sin * r * 0.6 + dx;
      for (const side of [-1, 1]) {
        const b = angle + (side * Math.PI) / 4;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(b) * r * 0.32, by + Math.sin(b) * r * 0.32);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
