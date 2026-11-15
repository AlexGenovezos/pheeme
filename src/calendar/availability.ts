// Guests' availability in the event editor: the hours the planner shows, the working hours "Next
// available time" searches, merging everyone's busy time, and finding the first slot that fits.
// Times are UTC ms, days `YYYY-MM-DD` in the calendar's time zone. Pure: no React, no IPC.
import type { AvailabilityResult, BusyInterval, PersonAvailability } from "../lib/tauri";
import { addDays, dateOf, weekday, zonedMs } from "./dates";

/** The hours the planner shows for a day: 7:00 to 21:00 in the calendar's time zone. */
export const PLANNER_HOURS = { start: 7, end: 21 } as const;
/** "Next available time" looks only inside working hours, Monday to Friday. */
export const WORKING_HOURS = { start: 9, end: 17 } as const;
/** 0 Sunday … 6 Saturday. */
export const WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];
/** How many days ahead (counting the first) "Next available time" searches, in one query. */
export const SEARCH_DAYS = 14;
/** Proposed times start on a quarter hour. */
export const SLOT_MINUTES = 15;

const MINUTE = 60_000;
const SLOT = SLOT_MINUTES * MINUTE;

/** `ms` rounded up to the next quarter hour (every time zone's offset is a multiple of 15 minutes). */
export const roundUpToSlot = (ms: number): number => Math.ceil(ms / SLOT) * SLOT;

/** Everyone's busy time as one sorted list of stretches that neither overlap nor touch. */
export function mergeBusy(lists: BusyInterval[][]): BusyInterval[] {
  const all = lists
    .flat()
    .filter((b) => b.endMs > b.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: BusyInterval[] = [];
  for (const b of all) {
    const last = out[out.length - 1];
    if (last && b.startMs <= last.endMs) last.endMs = Math.max(last.endMs, b.endMs);
    else out.push({ ...b });
  }
  return out;
}

/** Whether nothing in `busy` overlaps `[startMs, endMs)` (busy ends are exclusive). */
export const isFree = (busy: BusyInterval[], startMs: number, endMs: number): boolean =>
  !busy.some((b) => b.startMs < endMs && b.endMs > startMs);

/** `[fromMs, toMs)` of `PLANNER_HOURS` on `date` in `tz`. */
export const plannerRange = (date: string, tz: string) => ({
  fromMs: zonedMs(date, PLANNER_HOURS.start * 60, tz),
  toMs: zonedMs(date, PLANNER_HOURS.end * 60, tz),
});

/** The range one "Next available time" query covers: from `fromMs` to the end of the last day searched. */
export const searchRange = (fromMs: number, tz: string) => ({
  fromMs,
  toMs: zonedMs(addDays(dateOf(fromMs, tz), SEARCH_DAYS), 0, tz),
});

/**
 * The first start, on a quarter hour at or after `fromMs`, of a `lengthMs` slot that misses every
 * stretch of `busy` (already merged) and lies inside working hours on a working day in `tz`,
 * within `SEARCH_DAYS` days; null if there is none. Days are stepped by date, so a DST change
 * moves nothing: working hours stay 9:00–17:00 on the clock.
 */
export function nextFreeSlot(
  busy: BusyInterval[],
  lengthMs: number,
  fromMs: number,
  tz: string,
): number | null {
  const length = Math.max(lengthMs, MINUTE);
  const first = dateOf(fromMs, tz);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = addDays(first, i);
    if (!WORKING_DAYS.includes(weekday(day))) continue;
    const dayEnd = zonedMs(day, WORKING_HOURS.end * 60, tz);
    let start = roundUpToSlot(Math.max(fromMs, zonedMs(day, WORKING_HOURS.start * 60, tz)));
    while (start + length <= dayEnd) {
      const clash = busy.find((b) => b.startMs < start + length && b.endMs > start);
      if (!clash) return start;
      start = roundUpToSlot(clash.endMs);
    }
  }
  return null;
}

/** A saved event's time as Google has it, and the guests it was saved with. */
export type SavedSpan = BusyInterval & { guests: string[] };

/**
 * `result` without `span` in the busy time of you and the guests it was saved with. Editing a
 * saved event, Google counts the event itself as busy for everyone who has it on their calendar,
 * and freeBusy can't say which busy time is which; its saved time is left out so it doesn't clash
 * with itself. A guest added since has no copy, so their busy time there is another meeting.
 */
export function withoutSpan(
  result: AvailabilityResult,
  span: SavedSpan | null,
): AvailabilityResult {
  if (!span) return result;
  const holders = new Set(span.guests.map((g) => g.toLowerCase()));
  const cut = (p: PersonAvailability): PersonAvailability =>
    p.status === "known"
      ? {
          ...p,
          busy: p.busy.flatMap((b) =>
            [
              { startMs: b.startMs, endMs: Math.min(b.endMs, span.startMs) },
              { startMs: Math.max(b.startMs, span.endMs), endMs: b.endMs },
            ].filter((part) => part.endMs > part.startMs),
          ),
        }
      : p;
  return {
    you: cut(result.you),
    guests: result.guests.map((g) => (holders.has(g.email.toLowerCase()) ? cut(g) : g)),
  };
}

/** "2 guests' availability unknown", or null when every guest's is known. */
export function unknownNote(result: AvailabilityResult, guests: string[]): string | null {
  const count = result.guests.filter(
    (g) => g.status === "unknown" && guests.some((a) => a.toLowerCase() === g.email.toLowerCase()),
  ).length;
  if (count === 0) return null;
  return count === 1 ? "1 guest's availability unknown" : `${count} guests' availability unknown`;
}

/** The busy time that blocks a slot: yours and that of every guest whose availability is known. */
export function knownBusy(result: AvailabilityResult): BusyInterval[] {
  return mergeBusy([result.you, ...result.guests].map((p) => (p.status === "known" ? p.busy : [])));
}

/** The time at `fraction` (0…1) across the planner's hours on `date`, on the nearest quarter hour. */
export function plannerTime(fraction: number, date: string, tz: string): number {
  const { fromMs, toMs } = plannerRange(date, tz);
  const at = fromMs + Math.min(1, Math.max(0, fraction)) * (toMs - fromMs);
  return Math.min(Math.round(at / SLOT) * SLOT, toMs - SLOT);
}
