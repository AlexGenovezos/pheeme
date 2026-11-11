import { expect, test, vi } from "vitest";
import { SWIPE_GAP_MS, swipeStepper } from "./swipe";

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
