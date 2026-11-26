// The vacation responder's days, as Gmail on the web sets them: the first day starts at this
// computer's midnight, and the last day runs to the next midnight (Gmail replies to mail received
// before `endMs`). Dates are `YYYY-MM-DD` strings, as `DateField` takes them.
import type { VacationResponder } from "../lib/tauri";

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date `ms` falls on. */
export function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of `date`. */
export function startOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/** Local midnight at the end of `date`: the start of the next day. */
export function endOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d! + 1).getTime();
}

/** The last day a responder ending at `endMs` replies on. */
export const lastDateOf = (endMs: number) => dateOf(endMs - 1);

/** Whether the responder is on and not over yet (it may still be waiting for its first day). */
export const isOn = (r: VacationResponder, now = Date.now()) =>
  r.enabled && (r.endMs === null || r.endMs > now);

/** Whether it's on but its first day hasn't come yet. */
export const isWaiting = (r: VacationResponder, now = Date.now()) =>
  isOn(r, now) && r.startMs !== null && r.startMs > now;

/** "Dec 8", with the year when it isn't this one. */
export function shortDate(ms: number, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(ms));
}
