// When the weather in the hours moves. Still by default, so an open calendar costs nothing:
// every day shown plays for a few seconds when the grid shows a new set of days (opening
// Calendar mode, another view or week), and a day plays again when the pointer moves into it.
// A pointer resting in a day doesn't keep it going. Nothing plays with Animate weather off,
// with reduced motion, or while the window is hidden or in the background, and leaving the
// window stops it at once. No timers run once everything is still.
import { useEffect } from "react";
import { create } from "zustand";
import { useWeatherSettings } from "./weatherSettings";

/** How long a day's weather plays. */
export const PLAY_MS = 4000;

function mayMove(): boolean {
  return (
    useWeatherSettings.getState().animate &&
    document.visibilityState !== "hidden" &&
    document.hasFocus() &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

const NONE: ReadonlySet<string> = new Set();
/** Each playing day's stop. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The days whose weather is moving now (one grid shows at a time). */
const usePlaying = create<{ playing: ReadonlySet<string> }>(() => ({ playing: NONE }));

function play(dates: string[]) {
  if (!mayMove() || dates.length === 0) return;
  for (const date of dates) {
    clearTimeout(timers.get(date));
    timers.set(
      date,
      setTimeout(() => {
        timers.delete(date);
        usePlaying.setState(({ playing }) => {
          const next = new Set(playing);
          next.delete(date);
          return { playing: next.size ? next : NONE };
        });
      }, PLAY_MS),
    );
  }
  usePlaying.setState(({ playing }) => ({ playing: new Set([...playing, ...dates]) }));
}

function stopAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  usePlaying.setState({ playing: NONE });
}

/** The pointer moved into `date`: play it. */
const enter = (date: string) => play([date]);

export function useWeatherMotion(days: string[]): {
  /** The days whose weather is moving now. */
  playing: ReadonlySet<string>;
  enter: (date: string) => void;
} {
  const animate = useWeatherSettings((s) => s.animate);
  const playing = usePlaying((s) => s.playing);

  // A new set of days: they all play once.
  const key = days.join();
  useEffect(() => {
    play(key.split(","));
  }, [key]);

  // Leaving the window or hiding it stops everything; so does the grid going away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") stopAll();
    };
    window.addEventListener("blur", stopAll);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", stopAll);
      document.removeEventListener("visibilitychange", onHide);
      stopAll();
    };
  }, []);

  // Turned off: still at once (the stops still due clear themselves).
  return { playing: animate ? playing : NONE, enter };
}
