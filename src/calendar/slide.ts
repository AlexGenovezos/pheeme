// Moving to another day, week or month slides the new days in from the side they come from:
// later dates from the right, earlier ones from the left. The hours gutter stays put.
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { CalendarView } from "./views";

/** The parts of Day, Week and Month that show dates. */
const SLIDING = ".cal-grid__day-head, .cal-grid__band-cells, .cal-grid__column, .cal-month__weeks";
const OFFSET_PX = 40;
const DURATION_MS = 220;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"; // --ease-out

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which way the dates moved: 1 to later, -1 to earlier, 0 not at all. */
export function slideDirection(from: string, to: string): 1 | -1 | 0 {
  return to > from ? 1 : to < from ? -1 : 0;
}

/** Slides the dates in whenever the first day on screen moves (not when picking a day it shows). */
export function useSlideIn(
  ref: RefObject<HTMLElement | null>,
  view: CalendarView,
  firstDay: string,
) {
  const last = useRef({ view, firstDay });
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { view, firstDay };
    // Switching views isn't a move through time.
    if (before.view !== view) return;
    const dir = slideDirection(before.firstDay, firstDay);
    const root = ref.current;
    if (!dir || !root || reducedMotion()) return;
    for (const el of root.querySelectorAll<HTMLElement>(SLIDING)) {
      if (typeof el.animate !== "function") return;
      el.animate(
        [
          { transform: `translateX(${dir * OFFSET_PX}px)`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: DURATION_MS, easing: EASE },
      );
    }
  }, [ref, view, firstDay]);
}
