// Two-finger horizontal swipe on a trackpad (or a sideways mouse wheel) steps the calendar
// one period: swipe left for the next day, week or month, right for the previous.
import { type RefObject, useEffect } from "react";

/** Sideways travel (px) that makes one step. */
export const SWIPE_DISTANCE = 60;
/** A pause this long (ms) between wheel events ends a gesture, momentum included. */
export const SWIPE_GAP_MS = 200;
const LINE_PX = 16;
/** A frame (ms): what one wheel event normally covers. */
const FRAME_MS = 16;
/** A new swipe reaches this speed (px/ms); the tail of a momentum never speeds back up to it. */
const NEW_SWIPE_RATE = 0.2;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

/**
 * Turns a stream of wheel events into one step per swipe. Returns a handler that answers
 * whether the event was a sideways swipe (the caller then cancels its default).
 *
 * After a step, the rest of the swipe and its momentum move the same way and mustn't step
 * again. The browser doesn't say where momentum ends and a new swipe starts, but momentum only
 * ever slows down: once it has slowed to half its top speed, more than doubling its speed again
 * is new fingers.
 *
 * Wheel event times can't be taken at face value. A busy page (drawing the step) gets events
 * late: either several frames merged into one, or one frame each followed by a rush of the
 * waiting ones. So each speed is read two ways: `high`, which is never slower than the fingers
 * really went, and `low`, which is never faster. The slowdown counts only when `high` is under
 * half the top `low`, and the speed-up only when `low` is over twice the lowest `high`: both
 * really happened, which neither a late event nor fingers still speeding up can fake.
 */
export function swipeStepper(onStep: (direction: 1 | -1) => void) {
  let travel = 0;
  let last = -Infinity;
  // The direction this swipe already stepped: its momentum moves that way.
  let spent: 1 | -1 | 0 = 0;
  // Since the step (from its speed): the top speed, and the lowest once it fell to half that.
  let peak = 0;
  let trough = Infinity;

  /** An event's speed (px/ms), read high and low (see above); `ms` since the one before. */
  const speed = (px: number, ms: number) => ({
    high: Math.abs(px) / Math.min(ms, FRAME_MS),
    low: Math.abs(px) / Math.max(ms, FRAME_MS),
  });

  /** Whether movement the way `spent` went starts a new swipe rather than continuing one. */
  const startsNewSwipe = (px: number, ms: number): boolean => {
    const { high, low } = speed(px, ms);
    if (trough === Infinity) {
      peak = Math.max(peak, low);
      if (high < peak / 2) trough = high;
      return false;
    }
    trough = Math.min(trough, high);
    return low > trough * 2 && low >= NEW_SWIPE_RATE;
  };

  return (e: WheelLike, now: number): boolean => {
    // Pinch-to-zoom arrives as a wheel event with ctrlKey; mostly-vertical scrolling is the grid's.
    if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return false;
    let ms = Math.max(now - last, 1);
    if (ms > SWIPE_GAP_MS) {
      travel = 0;
      spent = 0;
      ms = FRAME_MS;
    }
    last = now;
    const px = e.deltaMode === 1 ? e.deltaX * LINE_PX : e.deltaX;
    const dir = Math.sign(px);
    if (dir === spent) {
      if (!startsNewSwipe(px, ms)) {
        travel = 0; // the rest of this swipe or its momentum; it also cancels any twitch back
        return true;
      }
      spent = 0;
    }
    // Momentum never reverses, so travel the other way is a new swipe back.
    if (dir === -Math.sign(travel)) travel = 0;
    travel += px;
    if (Math.abs(travel) >= SWIPE_DISTANCE) {
      spent = travel > 0 ? 1 : -1;
      travel = 0;
      peak = speed(px, ms).low;
      trough = Infinity;
      onStep(spent);
    }
    return true;
  };
}

/** Steps on a sideways swipe over `ref` while `enabled`. */
export function useSwipeStep(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onStep: (direction: 1 | -1) => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const wheel = swipeStepper(onStep);
    const listener = (e: WheelEvent) => {
      if (wheel(e, e.timeStamp)) e.preventDefault();
    };
    // Not passive: cancelling stops the page's sideways rubber-band while swiping.
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [ref, enabled, onStep]);
}
