import { expect, test, vi } from "vitest";
import { SWIPE_DISTANCE, SWIPE_GAP_MS, swipeStepper } from "./swipe";

const wheel = (
  deltaX: number,
  deltaY = 0,
  more: { deltaMode?: number; ctrlKey?: boolean } = {},
) => ({
  deltaX,
  deltaY,
  deltaMode: more.deltaMode ?? 0,
  ctrlKey: more.ctrlKey ?? false,
});

test("a swipe left steps forward once, however long its momentum runs", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = 0;
  for (const dx of [10, 20, 30, 40, 30, 20, 10, 5, 2, 1])
    expect(handle(wheel(dx), (t += 16))).toBe(true);
  expect(step.mock.calls).toEqual([[1]]);
});

test("a swipe right steps back", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  handle(wheel(-40), 0);
  handle(wheel(-40), 16);
  expect(step.mock.calls).toEqual([[-1]]);
});

test("a pause ends the gesture, so the next swipe steps again", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  handle(wheel(80), 0);
  handle(wheel(80), 16);
  handle(wheel(80), 16 + SWIPE_GAP_MS + 1);
  expect(step.mock.calls).toEqual([[1], [1]]);
});

test("swiping back during the momentum steps back at once", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = 0;
  for (const dx of [30, 40, 30, 20, 10, 5, 2]) handle(wheel(dx), (t += 16));
  handle(wheel(-40), (t += 16));
  handle(wheel(-40), (t += 16));
  expect(step.mock.calls).toEqual([[1], [-1]]);
});

test("a stray reverse twitch during momentum doesn't step forward again", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = 0;
  for (const dx of [30, 40, -1, 30, 20, 10, 5, 2]) handle(wheel(dx), (t += 16));
  for (const dx of [-20, 20, -20, 20, -20]) handle(wheel(dx), (t += 16));
  expect(step.mock.calls).toEqual([[1]]);
});

test("a short nudge doesn't step, and is forgotten after a pause", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  handle(wheel(40), 0);
  handle(wheel(40), SWIPE_GAP_MS + 1);
  expect(step).not.toHaveBeenCalled();
});

test("vertical scrolling and pinch-zoom are left alone", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  expect(handle(wheel(30, 40), 0)).toBe(false);
  expect(handle(wheel(100, 0, { ctrlKey: true }), 16)).toBe(false);
  expect(step).not.toHaveBeenCalled();
});

test("line-mode wheels count in lines", () => {
  const step = vi.fn();
  swipeStepper(step)(wheel(-4, 0, { deltaMode: 1 }), 0);
  expect(step.mock.calls).toEqual([[-1]]);
});

/** Feeds `deltas` 16 ms apart (a frame each), starting one frame after `t`; returns the last time. */
function feed(handle: ReturnType<typeof swipeStepper>, deltas: number[], t: number): number {
  for (const dx of deltas) handle(wheel(dx), (t += 16));
  return t;
}
const SWIPE = [4, 12, 24, 36, 40];
const MOMENTUM = [38, 34, 30, 26, 22, 19, 16, 13, 11, 9, 7, 5, 4, 3, 2, 2, 1, 1];

test("a new swipe during the last one's momentum steps again", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = feed(handle, SWIPE, 0);
  t = feed(handle, MOMENTUM.slice(0, 6), t);
  // The fingers land, which stops the momentum, and swipe again.
  feed(handle, SWIPE, t + 32);
  expect(step.mock.calls).toEqual([[1], [1]]);
});

test("swiping again and again steps every time, never waiting for a pause", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = 0;
  for (let i = 0; i < 8; i++) {
    t = feed(handle, SWIPE, t);
    t = feed(handle, MOMENTUM.slice(0, 4 + (i % 3) * 4), t);
  }
  expect(step).toHaveBeenCalledTimes(8);
});

test("a swipe right after the momentum has died away steps again", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = feed(handle, SWIPE, 0);
  t = feed(handle, MOMENTUM, t);
  feed(handle, SWIPE, t);
  expect(step.mock.calls).toEqual([[1], [1]]);
});

test("merged or late wheel events in the momentum don't step again", () => {
  const step = vi.fn();
  const handle = swipeStepper(step);
  let t = feed(handle, SWIPE, 0);
  // The page was busy re-drawing: a late first momentum event, then three frames in one.
  t += 40;
  handle(wheel(38), t);
  t = feed(handle, [34, 30, 26, 22, 19], t);
  handle(wheel(16 + 13 + 11), (t += 48));
  feed(handle, [9, 7, 5, 4, 3, 2, 2, 1, 1], t);
  expect(step.mock.calls).toEqual([[1]]);
});

test("a late wheel event and the rush after it don't step again", () => {
  // Recorded in WebKit: the step's first draw held the page for 77 ms, then the waiting events
  // came 4 ms apart, one frame of movement each.
  const step = vi.fn();
  const handle = swipeStepper(step);
  const recorded = [
    [3676, 3],
    [3693, 8],
    [3709, 16],
    [3725, 26],
    [3741, 34],
    [3818, 38],
    [3822, 36],
    [3838, 33],
    [3857, 30],
    [3915, 27],
    [3919, 24],
    [3935, 21],
  ];
  for (const [t, dx] of recorded) handle(wheel(dx), t);
  expect(step.mock.calls).toEqual([[1]]);
});

// Many made-up swipes: fingers speeding up from rest, momentum slowing at different rates,
// ±15% noise on every event, and sometimes up to three frames merged into one late event (a busy
// page; never the first event of a swipe, which arrives after a quiet moment).
let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function madeUpSwipe(): number[] {
  const top = 8 + random() * 50;
  const frames = 4 + Math.floor(random() * 5);
  // From rest: a few px in the first frame, then faster each frame up to the top speed.
  const first = 2 + random() * 3;
  const out = Array.from({ length: frames }, (_, i) => first * (top / first) ** (i / (frames - 1)));
  const decay = 0.85 + random() * 0.12;
  for (let v = top * (0.8 + random() * 0.3); v >= 0.5; v *= decay) out.push(Math.round(v));
  return out;
}

function play(handle: ReturnType<typeof swipeStepper>, deltas: number[], t: number): number {
  for (let i = 0; i < deltas.length;) {
    const merged = i > 0 && random() < 0.2 ? 1 + Math.floor(random() * 3) : 1;
    const dx = deltas.slice(i, i + merged).reduce((a, b) => a + b, 0) * (0.85 + random() * 0.3);
    i += merged;
    handle(wheel(dx), (t += 16 * merged + random() * 6 - 3));
  }
  return t;
}

test("a swipe with all its momentum never steps twice, however noisy", () => {
  for (let i = 0; i < 2000; i++) {
    const step = vi.fn();
    play(swipeStepper(step), madeUpSwipe(), 0);
    expect(step.mock.calls.length).toBeLessThanOrEqual(1);
  }
});

test("swipes that cut the last one's momentum short step once each, barring a rare miss", () => {
  // A gentle swipe right after another gentle one can't always be told from its momentum.
  let steps = 0;
  for (let i = 0; i < 500; i++) {
    const step = vi.fn();
    const handle = swipeStepper(step);
    let t = 0;
    for (let swipes = 0; swipes < 6;) {
      const all = madeUpSwipe();
      const part = all.slice(0, 6 + Math.floor(random() * (all.length - 6)));
      if (part.reduce((a, b) => a + b, 0) < 2 * SWIPE_DISTANCE) continue;
      // The fingers land (which stops the momentum) and move again.
      t = play(handle, part, t) + 40 + random() * 80;
      swipes++;
    }
    expect(step.mock.calls.length).toBeLessThanOrEqual(6);
    steps += step.mock.calls.length;
  }
  expect(steps).toBeGreaterThanOrEqual(0.99 * 500 * 6);
});
