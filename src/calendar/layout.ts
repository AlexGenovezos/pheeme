// Where events sit on the grid: side-by-side columns for overlapping timed events (as on
// calendar.google.com), rows for all-day and multi-day bars, and month cells with "+N more".
import type { CalendarEvent } from "../lib/tauri";
import { addDays, daysBetween, wallClock, zonedMs } from "./dates";

const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * 60_000;
/** Events shorter than this still take this much room, so their titles fit and overlaps show. */
export const MIN_EVENT_MINUTES = 20;

/** Days an event covers: `[first, last]` inclusive. */
export function eventDays(e: CalendarEvent, tz: string): { first: string; last: string } | null {
  if (e.allDay) {
    if (!e.start.date) return null;
    const end = e.end.date && e.end.date > e.start.date ? e.end.date : addDays(e.start.date, 1);
    return { first: e.start.date, last: addDays(end, -1) };
  }
  if (e.start.ms == null) return null;
  const end = Math.max(e.end.ms ?? e.start.ms, e.start.ms);
  const first = wallClock(e.start.ms, tz).date;
  // An event ending at midnight doesn't cover the next day.
  const last = end > e.start.ms ? wallClock(end - 1, tz).date : first;
  return { first, last };
}

/** All-day events and timed ones of 24 hours or more sit in the band above the hours. */
export function inAllDayBand(e: CalendarEvent): boolean {
  if (e.allDay) return true;
  if (e.start.ms == null || e.end.ms == null) return false;
  return e.end.ms - e.start.ms >= DAY_MS;
}

export interface TimedBlock {
  event: CalendarEvent;
  /** Minutes past the day's midnight. */
  start: number;
  end: number;
  /** Column within its group of overlapping events, and how many columns it spans of `columns`. */
  column: number;
  span: number;
  columns: number;
  /** Starts before or ends after this day. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** The timed events of `date`, positioned in columns where they overlap. */
export function layoutDay(events: CalendarEvent[], date: string, tz: string): TimedBlock[] {
  const dayStart = zonedMs(date, 0, tz);
  const dayEnd = zonedMs(addDays(date, 1), 0, tz);
  const blocks: TimedBlock[] = [];
  for (const event of events) {
    if (inAllDayBand(event) || event.start.ms == null) continue;
    const s = event.start.ms;
    const e = Math.max(event.end.ms ?? s, s);
    // A zero-length event still shows on its day.
    const onDay = s < dayEnd && (e > dayStart || (e === s && s >= dayStart));
    if (!onDay) continue;
    const start = s <= dayStart ? 0 : wallClock(s, tz).minutes;
    const end = e >= dayEnd ? DAY_MINUTES : Math.max(wallClock(e, tz).minutes, start);
    blocks.push({
      event,
      start,
      end,
      column: 0,
      span: 1,
      columns: 1,
      clippedStart: s < dayStart,
      clippedEnd: e > dayEnd,
    });
  }
  const shownEnd = (b: TimedBlock) =>
    Math.min(DAY_MINUTES, Math.max(b.end, b.start + MIN_EVENT_MINUTES));
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);

  let group: TimedBlock[] = [];
  let groupEnd = -1;
  const closeGroup = () => {
    // Columns: each block goes in the first one free when it starts.
    const columnEnds: number[] = [];
    const byColumn: TimedBlock[][] = [];
    for (const b of group) {
      let c = columnEnds.findIndex((end) => end <= b.start);
      if (c < 0) c = columnEnds.length;
      columnEnds[c] = shownEnd(b);
      (byColumn[c] ??= []).push(b);
      b.column = c;
    }
    // Then each block widens into columns to its right that are free for its whole time.
    for (const b of group) {
      b.columns = columnEnds.length;
      let span = 1;
      for (let c = b.column + 1; c < columnEnds.length; c++) {
        const clash = byColumn[c].some((o) => o.start < shownEnd(b) && shownEnd(o) > b.start);
        if (clash) break;
        span++;
      }
      b.span = span;
    }
    group = [];
  };
  for (const b of blocks) {
    if (group.length && b.start >= groupEnd) closeGroup();
    group.push(b);
    groupEnd = Math.max(groupEnd, shownEnd(b));
  }
  if (group.length) closeGroup();
  return blocks;
}

export interface BandSegment {
  event: CalendarEvent;
  /** Index into the days, and how many days it covers among them. */
  start: number;
  span: number;
  row: number;
  /** Carries on before the first or after the last day shown. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Rows of bars across `days`. `includeTimed` also places shorter timed events as one-day items
 * after the bars (month cells); otherwise only band events are placed (the all-day band).
 */
export function layoutBand(
  events: CalendarEvent[],
  days: string[],
  tz: string,
  includeTimed = false,
): BandSegment[] {
  const first = days[0];
  const last = days[days.length - 1];
  const items: (BandSegment & { band: boolean; startMs: number })[] = [];
  for (const event of events) {
    const band = inAllDayBand(event);
    if (!band && !includeTimed) continue;
    const covered = eventDays(event, tz);
    if (!covered || covered.last < first || covered.first > last) continue;
    const from = covered.first < first ? first : covered.first;
    const to = covered.last > last ? last : covered.last;
    items.push({
      event,
      start: daysBetween(first, from),
      span: daysBetween(from, to) + 1,
      row: 0,
      continuesBefore: covered.first < first,
      continuesAfter: covered.last > last,
      band,
      startMs: event.start.ms ?? 0,
    });
  }
  // Bars first, longest first, then timed events by time: as on the website.
  items.sort(
    (a, b) =>
      Number(b.band) - Number(a.band) ||
      a.start - b.start ||
      b.span - a.span ||
      a.startMs - b.startMs,
  );
  const taken: boolean[][] = [];
  for (const item of items) {
    let row = 0;
    for (; ; row++) {
      const r = (taken[row] ??= []);
      let free = true;
      for (let d = item.start; d < item.start + item.span; d++) if (r[d]) free = false;
      if (free) break;
    }
    for (let d = item.start; d < item.start + item.span; d++) taken[row][d] = true;
    item.row = row;
  }
  return items.map((i) => ({
    event: i.event,
    start: i.start,
    span: i.span,
    row: i.row,
    continuesBefore: i.continuesBefore,
    continuesAfter: i.continuesAfter,
  }));
}

/**
 * Fit band segments into cells of `capacity` rows. A day with more than fit shows `capacity - 1`
 * rows and a "+N more" line counting the rest.
 */
export function fitRows<S extends Pick<BandSegment, "start" | "span" | "row">>(
  segments: S[],
  dayCount: number,
  capacity: number,
): { visible: S[]; more: number[] } {
  const perDay = Array.from({ length: dayCount }, () => 0);
  for (const s of segments)
    for (let d = s.start; d < s.start + s.span; d++) perDay[d] = Math.max(perDay[d], s.row + 1);
  const rowsFor = (d: number) => (perDay[d] > capacity ? Math.max(0, capacity - 1) : capacity);
  const more = Array.from({ length: dayCount }, () => 0);
  const visible: S[] = [];
  for (const s of segments) {
    let fits = true;
    for (let d = s.start; d < s.start + s.span; d++) if (s.row >= rowsFor(d)) fits = false;
    if (fits) visible.push(s);
    else for (let d = s.start; d < s.start + s.span; d++) more[d]++;
  }
  return { visible, more };
}
