// Sun through the window: shafts of light slanting in from the upper left, shimmering slowly,
// a soft glare where the sun is, and dust drifting and glinting in the light.
import { random } from "../WeatherArt";
import { EasedScene, byInk } from "./eased";
import { dotSprite, type Ink, rgba, stamp } from "./ink";
import type { Intensity } from "../codes";

interface Ray {
  /** Where it crosses the top of the band, px. */
  x: number;
  width: number;
  alpha: number;
  phase: number;
  freq: number;
}

interface Mote {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  twinkle: number;
}

/** How far the light slants from straight down, radians. */
const SLANT = 0.42;
/** Dust per 10,000 px², and how bright the light is, weak sun to strong. */
const MOTES = [5, 7, 10];
const LIGHT = [0.7, 0.85, 1];

export class SunScene extends EasedScene {
  private rays: Ray[] = [];
  private motes: Mote[] = [];
  private light: number;
  private rand: () => number;
  private sprites = byInk((ink: Ink) => ({ mote: dotSprite(ink.sun, 0.35) }));

  constructor(
    private w: number,
    private h: number,
    intensity: Intensity,
    seed: string,
  ) {
    super();
    const rand = (this.rand = random(seed));
    this.light = LIGHT[intensity - 1];
    // Rays start left of the band too, since they slant in from there.
    const count = 3 + Math.round(rand() * 2);
    for (let i = 0; i < count; i++) {
      this.rays.push({
        x: -h * Math.tan(SLANT) * 0.5 + ((i + rand() * 0.8) / count) * (w + h * Math.tan(SLANT)),
        width: 16 + rand() * 46,
        alpha: 0.06 + rand() * 0.08,
        phase: rand() * Math.PI * 2,
        freq: 0.5 + rand() * 0.7,
      });
    }
    for (let i = Math.round(((w * h) / 10_000) * MOTES[intensity - 1]); i > 0; i--) {
      this.motes.push({
        x: rand() * w,
        y: rand() * h,
        r: 0.5 + rand() * 0.9,
        vx: (rand() - 0.5) * 6,
        vy: (rand() - 0.6) * 5,
        twinkle: rand() * Math.PI * 2,
      });
    }
  }

  protected move(dt: number) {
    const { rand, w, h } = this;
    for (const r of this.rays) r.phase += r.freq * dt;
    for (const m of this.motes) {
      // A slow random wander, as dust in still air.
      m.vx += (rand() - 0.5) * 12 * dt;
      m.vy += (rand() - 0.5) * 12 * dt;
      m.vx *= 1 - dt * 0.6;
      m.vy *= 1 - dt * 0.6;
      m.x = (m.x + m.vx * dt + w) % w;
      m.y = (m.y + m.vy * dt + h) % h;
      m.twinkle += dt * (1.5 + m.r);
    }
  }

  paint(ctx: CanvasRenderingContext2D, ink: Ink) {
    const { w, h, light } = this;
    const { mote } = this.sprites(ink);
    ctx.clearRect(0, 0, w, h);
    const glare = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.9);
    glare.addColorStop(0, rgba(ink.sun, 0.16 * light));
    glare.addColorStop(1, rgba(ink.sunGlow, 0));
    ctx.fillStyle = glare;
    ctx.fillRect(0, 0, w, h);
    const length = h / Math.cos(SLANT) + 20;
    for (const r of this.rays) {
      const shimmer = 0.7 + 0.3 * Math.sin(r.phase);
      ctx.save();
      ctx.translate(r.x, 0);
      ctx.rotate(-SLANT);
      const shaft = ctx.createLinearGradient(-r.width / 2, 0, r.width / 2, 0);
      shaft.addColorStop(0, rgba(ink.sun, 0));
      shaft.addColorStop(0.5, rgba(ink.sun, r.alpha * shimmer * light));
      shaft.addColorStop(1, rgba(ink.sun, 0));
      ctx.fillStyle = shaft;
      ctx.fillRect(-r.width / 2, -10, r.width, length);
      ctx.restore();
    }
    for (const m of this.motes) {
      ctx.globalAlpha = (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(m.twinkle))) * light;
      stamp(ctx, mote, m.x, m.y, m.r * 3);
    }
    ctx.globalAlpha = 1;
  }
}
