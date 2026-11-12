// Moving to another day, week or month slides the new days in from the side they come from:
// later dates from the right, earlier ones from the left. The hours gutter stays put.
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { CalendarView } from "./views";

/** The parts of Day, Week and Month that show dates. */
const SLIDING = ".cal-grid__day-head, .cal-grid__band-cells, .cal-grid__column, .cal-month__weeks";
const OFFSET_PX = 32;
const DURATION_MS = 280;
// --ease-standard. It starts gently: the frame that draws the new days is slow (a whole week or
// month is laid out), and a curve that does most of its moving at the start (--ease-out) has
// finished most of its slide before the first frame shows, so the days jump into place.
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** Where the fade starts: never blank, so the grid lines don't blink on every step. */
const FROM_OPACITY = 0.4;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Runs `run` once the next frame has drawn; returns a cancel. */
function afterNextFrame(run: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}

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
    const slides: Animation[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(SLIDING)) {
      if (typeof el.animate !== "function") break;
      const slide = el.animate(
        [
          { transform: `translateX(${dir * OFFSET_PX}px)`, opacity: FROM_OPACITY },
          { transform: "none", opacity: 1 },
        ],
        { duration: DURATION_MS, easing: EASE },
      );
      slide.pause();
      slides.push(slide);
    }
    // Held at the start until the slow frame has drawn, so none of the slide is lost to it.
    const cancelStart = afterNextFrame(() => slides.forEach((s) => s.play()));
    return () => {
      cancelStart();
      // Stepped again before it started: parts that stay on screen (the month's weeks, the
      // all-day band) would otherwise keep this held slide's first frame.
      for (const s of slides) if (s.playState === "paused") s.cancel();
    };
  }, [ref, view, firstDay]);
}
