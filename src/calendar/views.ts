// Which days a Day, Week or Month view shows, how prev/next move, and the title above the grid.
import {
  addDays,
  addMonths,
  daysBetween,
  formatDay,
  startOfMonth,
  startOfWeek,
  zonedMs,
} from "./dates";

export type CalendarView = "day" | "week" | "month";

export const CALENDAR_VIEWS: readonly CalendarView[] = ["day", "week", "month"];

/** The days the view shows around `anchor`: one, a week, or the whole weeks covering its month. */
export function visibleDays(view: CalendarView, anchor: string, weekStart: number): string[] {
  let first: string;
  let count: number;
  if (view === "day") {
    first = anchor;
    count = 1;
  } else if (view === "week") {
    first = startOfWeek(anchor, weekStart);
    count = 7;
  } else {
    const monthStart = startOfMonth(anchor);
    first = startOfWeek(monthStart, weekStart);
    const lastDay = addDays(addMonths(anchor, 1), -1);
    count = daysBetween(first, startOfWeek(lastDay, weekStart)) + 7;
  }
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/**
 * The days the calendar keeps in memory around `anchor`: the grid of its month and of the months
 * either side, so switching Day, Week and Month, or stepping once, draws without waiting on a read.
 */
export function windowDays(anchor: string, weekStart: number): { first: string; last: string } {
  const after = visibleDays("month", addMonths(anchor, 1), weekStart);
  return {
    first: visibleDays("month", addMonths(anchor, -1), weekStart)[0],
    last: after[after.length - 1],
  };
}

/** The UTC ms range `[from, to)` covering `days` in `tz`. */
export function daysRange(days: string[], tz: string): { from: number; to: number } {
  return { from: zonedMs(days[0], 0, tz), to: zonedMs(addDays(days[days.length - 1], 1), 0, tz) };
}

/** The anchor one period before (`-1`) or after (`1`) `anchor`. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: 1 | -1): string {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return addMonths(anchor, dir);
}

/** "Monday, November 9, 2026", "Nov 9 – 15, 2026" or "November 2026". */
export function viewTitle(view: CalendarView, anchor: string, days: string[]): string {
  if (view === "day")
    return formatDay(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (view === "month") return formatDay(anchor, { month: "long", year: "numeric" });
  const first = days[0];
  const last = days[days.length - 1];
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const sameMonth = sameYear && first.slice(0, 7) === last.slice(0, 7);
  const start = formatDay(first, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const end = formatDay(last, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return `${start} – ${end}, ${last.slice(0, 4)}`;
}
