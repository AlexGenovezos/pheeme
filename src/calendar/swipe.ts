// Two-finger horizontal swipe on a trackpad (or a sideways mouse wheel) steps the calendar
// one period: swipe left for the next day, week or month, right for the previous.
import { type RefObject, useEffect } from "react";

/** Sideways travel (px) that makes one step. */
export const SWIPE_DISTANCE = 60;
/** A pause this long (ms) between wheel events ends a gesture, momentum included. */
export const SWIPE_GAP_MS = 200;
const LINE_PX = 16;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

/**
 * Turns a stream of wheel events into at most one step per gesture. Returns a handler that
 * answers whether the event was a sideways swipe (the caller then cancels its default).
 */
export function swipeStepper(onStep: (direction: 1 | -1) => void) {
  let travel = 0;
  let last = -Infinity;
  // The direction this gesture already stepped: its momentum moves that way until a pause.
  let spent: 1 | -1 | 0 = 0;
  return (e: WheelLike, now: number): boolean => {
    // Pinch-to-zoom arrives as a wheel event with ctrlKey; mostly-vertical scrolling is the grid's.
    if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return false;
    if (now - last > SWIPE_GAP_MS) {
      travel = 0;
      spent = 0;
    }
    last = now;
    const dir = Math.sign(e.deltaX);
    if (dir === spent) {
      travel = 0; // the rest of this gesture's momentum; it also cancels any twitch back
      return true;
    }
    // Momentum never reverses, so travel the other way is a new swipe back.
    if (dir === -Math.sign(travel)) travel = 0;
    travel += e.deltaMode === 1 ? e.deltaX * LINE_PX : e.deltaX;
    if (Math.abs(travel) >= SWIPE_DISTANCE) {
      spent = travel > 0 ? 1 : -1;
      travel = 0;
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
