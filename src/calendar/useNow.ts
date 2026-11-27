import { useState, useSyncExternalStore } from "react";
import { dateOf } from "./dates";

const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/** The current time, updated every 30 s (for today and the current-time line). */
export function useNow(): number {
  const [initial] = useState(Date.now);
  return useSyncExternalStore(subscribe, () => (timer === undefined ? initial : now));
}

/** Consumers that only display the date update when midnight passes in their zone. */
export function useToday(tz: string): string {
  const [initial] = useState(Date.now);
  return useSyncExternalStore(subscribe, () => dateOf(timer === undefined ? initial : now, tz));
}
