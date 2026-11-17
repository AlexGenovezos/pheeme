// Rain on a window pane (and a storm: the same, with lightning lighting up the glass). Beads of
// water sit on the glass; while it rains, drops hit it and run together, and a bead that grows
// heavy enough runs down as a drip: in fits and starts, wandering a little, picking up the beads
// in its way and leaving a wet streak and a few small beads behind it. When the rain stops, each
// drip slows and comes to rest as a bead, so the still picture is a wet pane, not frozen motion.
// The simulation is pure and seeded: the same day and size start from the same pane.
import { random } from "../WeatherArt";
import { DROP_SCALE, dropSprite, type Ink, rgba, stamp } from "./ink";
import type { Intensity } from "../codes";
import type { Scene } from "./scene";

interface Bead {
  x: number;
  y: number;
  r: number;
  /** When a drop hit the pane, s (drawn landing for a moment); absent for the first beads. */
  born?: number;
}

interface Drip extends Bead {
  /** Speed down the pane, px/s. */
  vy: number;
  /** Seconds left held in place before it moves again. */
  hold: number;
  /** Where its last trail bead was left. */
  lastBead: number;
  /** Its sideways wander's phase. */
  phase: number;
  /** The streak behind it: points with the time they were wet. */
  trail: { x: number; y: number; t: number }[];
}

interface Glass {
  w: number;
  h: number;
  intensity: Intensity;
  beads: Bead[];
  drips: Drip[];
  /** At most this many beads: past it, a drop joins a bead already there. */
  cap: number;
  /** Seconds since the pane was made. */
  time: number;
  rand: () => number;
}

/** Beads per 10,000 px² at the start, light to heavy rain; micro-beads are the fine mist. */
const BEADS = [12, 18, 26];
const MICRO = [60, 90, 130];
/** Drops hitting the pane per second per 10,000 px² while it rains. */
const HITS = [5, 10, 18];
/** Beads that start running per second per 100 px of width, apart from those grown heavy. */
const STARTS = [0.25, 0.5, 0.9];
/** A bead this big runs. */
const DRIP_R = 5.2;
/** A drip doesn't grow past this. */
const MAX_R = 7.5;
/** How long a streak stays wet, s. */
const TRAIL_S = 1.4;
/** The pane holds at most this many times the beads it starts with. */
const CAP = 1.2;

const area = (g: Pick<Glass, "w" | "h">) => (g.w * g.h) / 10_000;

/** A bead's size: many small, a few large. */
function beadR(rand: () => number): number {
  return 1.3 + rand() ** 2.2 * 4.2;
}

export function createGlass(w: number, h: number, intensity: Intensity, seed: string): Glass {
  const rand = random(seed);
  const g: Glass = { w, h, intensity, beads: [], drips: [], cap: 0, time: 0, rand };
  const micro = Math.round(area(g) * MICRO[intensity - 1]);
  for (let i = 0; i < micro; i++) {
    g.beads.push({ x: rand() * w, y: rand() * h, r: 0.45 + rand() * 0.75 });
  }
  const beads = Math.round(area(g) * BEADS[intensity - 1]);
  for (let i = 0; i < beads; i++) {
    const r = beadR(rand);
    // A few tries for a spot clear of the others, so the pane starts as separate beads.
    for (let t = 0; t < 6; t++) {
      const x = r + rand() * (w - 2 * r);
      const y = r + rand() * (h - 2 * r);
      if (t === 5 || !touching(g, x, y, r, 1.2)) {
        g.beads.push({ x, y, r });
        break;
      }
    }
  }
  g.cap = Math.round(g.beads.length * CAP);
  return g;
}

/** The index of a bead (past the micro mist) that a drop of radius `r` at x, y would touch. */
function touching(g: Glass, x: number, y: number, r: number, reach = 0.85): number | undefined {
  for (let i = 0; i < g.beads.length; i++) {
    const b = g.beads[i];
    if (b.r < 1) continue;
    const d = (b.r + r) * reach;
    const dx = b.x - x;
    const dy = b.y - y;
    if (dx * dx + dy * dy < d * d) return i;
  }
  return undefined;
}

/** Two drops' water as one: their volumes add, and it sits nearer the bigger. */
function join(a: Bead, b: Bead): Bead {
  const va = a.r ** 3;
  const vb = b.r ** 3;
  return {
    x: (a.x * va + b.x * vb) / (va + vb),
    y: (a.y * va + b.y * vb) / (va + vb),
    r: Math.cbrt(va + vb),
  };
}

function startDrip(g: Glass, b: Bead) {
  g.drips.push({
    ...b,
    r: Math.min(b.r, MAX_R),
    vy: 0,
    hold: g.rand() * 0.25,
    lastBead: b.y,
    phase: g.rand() * Math.PI * 2,
    trail: [],
  });
}

/** A drop of rain hits the pane. */
function hit(g: Glass) {
  const { rand } = g;
  const drop = { x: rand() * g.w, y: rand() * g.h, r: beadR(rand) * 0.9, born: g.time };
  const i =
    g.beads.length > g.cap
      ? g.beads.length - 1 - Math.floor(rand() * Math.min(g.beads.length, 40))
      : touching(g, drop.x, drop.y, drop.r);
  if (i === undefined) {
    g.beads.push(drop);
    return;
  }
  const joined = { ...join(g.beads[i], drop), born: g.time };
  if (joined.r >= DRIP_R) {
    g.beads.splice(i, 1);
    startDrip(g, joined);
  } else g.beads[i] = joined;
}

/** A bead starts to run by itself: the biggest of some picked at random. */
function loosen(g: Glass) {
  let best = -1;
  for (let t = 0; t < 24; t++) {
    const i = Math.floor(g.rand() * g.beads.length);
    if (g.beads[i] && (best < 0 || g.beads[i].r > g.beads[best].r)) best = i;
  }
  if (best < 0 || g.beads[best].r < 2.2) return;
  const [b] = g.beads.splice(best, 1);
  startDrip(g, { ...b, r: Math.max(b.r, 3.4) });
}

/** How many of something with `rate` per second happen in `dt`. */
function events(rand: () => number, rate: number, dt: number): number {
  const expected = rate * dt;
  return Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
}

/**
 * The pane `dt` seconds on. While `raining`, drops hit it and drips run; otherwise each drip
 * slows and rests as a bead, and the streaks dry.
 */
export function step(g: Glass, dt: number, raining: boolean) {
  g.time += dt;
  const { rand } = g;
  const level = g.intensity - 1;
  if (raining) {
    for (let n = events(rand, HITS[level] * area(g), dt); n > 0; n--) hit(g);
    for (let n = events(rand, (STARTS[level] * g.w) / 100, dt); n > 0; n--) loosen(g);
  }
  const kept: Drip[] = [];
  for (const d of g.drips) {
    while (d.trail.length && g.time - d.trail[0].t > TRAIL_S) d.trail.shift();
    // A drip that came to rest (size 0) stays only until its streak dries.
    if (d.r === 0) {
      if (d.trail.length) kept.push(d);
      continue;
    }
    if (raining) run(g, d, dt);
    else {
      d.vy *= Math.exp(-dt * 5);
      d.y += d.vy * dt;
    }
    d.trail.push({ x: d.x, y: d.y - d.r * 0.6, t: g.time });
    if (d.y - d.r * 2 > g.h) {
      kept.push({ ...d, r: 0 });
      continue;
    }
    if (!raining && d.vy < 6) {
      g.beads.push({ x: d.x, y: d.y, r: d.r });
      kept.push({ ...d, r: 0, vy: 0 });
      continue;
    }
    kept.push(d);
  }
  g.drips = kept;
}

function run(g: Glass, d: Drip, dt: number) {
  const { rand } = g;
  if (d.hold > 0) {
    d.hold -= dt;
    d.vy = 0;
  } else {
    // Heavier runs faster; water held back by the glass makes it stop and start.
    const top = 26 * d.r;
    d.vy = Math.min(top, d.vy + (d.r - 2) * 90 * dt);
    if (rand() < dt * (d.r < 4.5 ? 1.6 : 0.6)) d.hold = 0.08 + rand() * 0.45;
  }
  d.y += d.vy * dt;
  d.phase += dt * (1.5 + rand() * 2);
  d.x += Math.sin(d.phase) * d.vy * dt * 0.12;
  // Pick up the beads in its way.
  for (let i = g.beads.length - 1; i >= 0; i--) {
    const b = g.beads[i];
    const reach = d.r + b.r * 0.6;
    const dx = b.x - d.x;
    const dy = b.y - d.y;
    if (dx * dx + dy * dy < reach * reach) {
      g.beads.splice(i, 1);
      d.r = Math.min(MAX_R, Math.cbrt(d.r ** 3 + b.r ** 3 * 0.6));
    }
  }
  // Leave a little water behind now and then.
  if (d.y - d.lastBead > d.r * (2.2 + rand() * 3)) {
    d.lastBead = d.y;
    if (rand() < 0.75) {
      g.beads.push({
        x: d.x + (rand() - 0.5) * d.r * 0.6,
        y: d.y - d.r * (1.2 + rand()),
        r: d.r * (0.22 + rand() * 0.22),
      });
      d.r = Math.max(2.4, d.r * 0.985);
    }
  }
}

/** Nothing left moving or drying: the canvas can stop drawing. */
export function isStill(g: Glass): boolean {
  return g.drips.length === 0;
}

/** How long a drop that hits the pane takes to settle, s. */
const LAND_S = 0.12;
/** Seconds between flashes in a storm: at least, and how much more at random. */
const FLASH_GAP = [2.5, 3.5] as const;
/** A flash lasts this long, s. */
const FLASH_S = 0.9;

/** How bright a flash is `t` s in: a stroke, a flicker, a second stroke, then fading. */
function flashLight(t: number): number {
  if (t < 0 || t > FLASH_S) return 0;
  if (t < 0.06) return 1;
  if (t < 0.11) return 0.25;
  if (t < 0.19) return 0.85;
  return 0.85 * Math.exp(-(t - 0.19) * 7);
}

/** A bolt far off behind the glass: a jagged line down from the top and one fork. */
function bolt(rand: () => number, w: number, h: number): [number, number][][] {
  const main: [number, number][] = [[w * (0.2 + rand() * 0.6), 0]];
  const end = h * (0.45 + rand() * 0.4);
  while (main[main.length - 1][1] < end) {
    const [x, y] = main[main.length - 1];
    main.push([x + (rand() - 0.5) * 24, y + 10 + rand() * 14]);
  }
  const from = main[Math.floor(main.length * (0.3 + rand() * 0.3))];
  const fork: [number, number][] = [from];
  const dir = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < 4 + rand() * 4; i++) {
    const [x, y] = fork[fork.length - 1];
    fork.push([x + dir * (4 + rand() * 12), y + 8 + rand() * 10]);
  }
  return [main, fork];
}

export class RainScene implements Scene {
  private glass: Glass;
  private sprite: { ink: Ink; img: HTMLCanvasElement } | null = null;
  private playing = false;
  private nextFlash = Infinity;
  private flash: { at: number; bolt: [number, number][][] } | null = null;

  constructor(
    w: number,
    h: number,
    intensity: Intensity,
    seed: string,
    private storm: boolean,
  ) {
    this.glass = createGlass(w, h, intensity, seed);
  }

  get still(): boolean {
    return isStill(this.glass) && !this.flash;
  }

  step(dt: number, playing: boolean) {
    const g = this.glass;
    step(g, dt, playing);
    if (!this.storm) return;
    // The first flash comes soon after it starts playing, so a glance sees one.
    if (playing && !this.playing) this.nextFlash = g.time + 0.4 + g.rand() * 0.8;
    this.playing = playing;
    if (this.flash && g.time - this.flash.at > FLASH_S) this.flash = null;
    if (playing && g.time >= this.nextFlash) {
      this.flash = { at: g.time, bolt: bolt(g.rand, g.w, g.h) };
      this.nextFlash = g.time + FLASH_GAP[0] + g.rand() * FLASH_GAP[1];
    }
  }

  paint(ctx: CanvasRenderingContext2D, ink: Ink) {
    const g = this.glass;
    if (this.sprite?.ink !== ink) this.sprite = { ink, img: dropSprite(ink) };
    const sprite = this.sprite.img;
    ctx.clearRect(0, 0, g.w, g.h);
    if (this.flash) this.paintFlash(ctx, ink, flashLight(g.time - this.flash.at));
    // The wet streaks behind the drips, drying from the top.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const d of g.drips) {
      const t = d.trail;
      if (t.length < 2) continue;
      const head = t[t.length - 1];
      const tail = t[0];
      // One stroke, fading from fresh at the drip to dry at its oldest point.
      const fresh = Math.max(0, 1 - (g.time - head.t) / TRAIL_S);
      const dry = Math.max(0, 1 - (g.time - tail.t) / TRAIL_S);
      const wet = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
      wet.addColorStop(0, rgba(ink.shine, 0.1 * fresh));
      wet.addColorStop(1, rgba(ink.shine, 0.1 * dry));
      ctx.strokeStyle = wet;
      ctx.lineWidth = Math.max(1.2, (d.r || 4) * 0.55);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      for (let i = 1; i < t.length; i++) ctx.lineTo(t[i].x, t[i].y);
      ctx.stroke();
    }
    for (const b of g.beads) {
      // A drop that just hit lands: a touch bigger and fainter, settling in a moment.
      const landing = b.born === undefined ? 1 : Math.min(1, (g.time - b.born) / LAND_S);
      // The fine mist is drawn fainter, so it reads as fogged glass rather than dots.
      ctx.globalAlpha = (b.r < 1 ? 0.55 : 1) * (0.3 + 0.7 * landing);
      stamp(ctx, sprite, b.x, b.y, b.r * DROP_SCALE * (1.35 - 0.35 * landing));
    }
    ctx.globalAlpha = 1;
    for (const d of g.drips) {
      if (d.r === 0) continue;
      // A running drop is pulled long, its weight at the bottom.
      const s = d.r * DROP_SCALE;
      const stretch = 1 + Math.min(0.45, d.vy / 400);
      ctx.drawImage(sprite, d.x - s / 2, d.y - s * stretch + s / 2, s, s * stretch);
    }
  }

  /** Lightning: the pane lit up from behind, and the bolt, soft through the wet glass. */
  private paintFlash(ctx: CanvasRenderingContext2D, ink: Ink, light: number) {
    if (light <= 0 || !this.flash) return;
    const { w, h } = this.glass;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, rgba(ink.shine, 0.3 * light));
    sky.addColorStop(1, rgba(ink.bolt, 0.08 * light));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.shadowColor = rgba(ink.shine, light);
    ctx.shadowBlur = 10;
    ctx.lineJoin = "round";
    this.flash.bolt.forEach((line, i) => {
      ctx.strokeStyle = rgba(ink.shine, (i === 0 ? 0.75 : 0.45) * light);
      ctx.lineWidth = i === 0 ? 1.6 : 1;
      ctx.beginPath();
      line.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    });
    ctx.restore();
  }
}
