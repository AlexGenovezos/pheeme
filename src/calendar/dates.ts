// Calendar dates. A day is a `YYYY-MM-DD` string (as Google stores all-day events), and times are
// UTC ms shown in the user's Calendar time zone, which may differ from the computer's.

const pad = (n: number) => String(n).padStart(2, "0");

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The computer's time zone. */
export const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock at `ms` in `tz`: its day and minutes since that day's midnight. */
export function wallClock(ms: number, tz: string): { date: string; minutes: number } {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms)))
    if (type !== "literal") p[type] = Number(value);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minutes: (p.hour % 24) * 60 + p.minute,
  };
}

/** The day `ms` falls on in `tz`. */
export const dateOf = (ms: number, tz: string): string => wallClock(ms, tz).date;

function offsetAt(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms)))
    if (type !== "literal") p[type] = Number(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC ms of `minutes` past midnight of `date` in `tz`. A time repeated by DST is its first
 * occurrence; a time skipped by DST lands just after the gap (Santiago's midnight is 1:00).
 */
export function zonedMs(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const local = Date.UTC(y, m - 1, d, 0, minutes);
  // The offsets a day either side cover any transition near this time (zones reach ±14 h).
  const candidates = [
    local - offsetAt(local - 86_400_000, tz),
    local - offsetAt(local + 86_400_000, tz),
  ];
  const exact = candidates.filter((ms) => offsetAt(ms, tz) === local - ms);
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

const utcOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const addDays = (date: string, n: number): string => fromUtc(utcOf(date) + n * 86_400_000);

/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((utcOf(b) - utcOf(a)) / 86_400_000);

/** 0 Sunday … 6 Saturday. */
export const weekday = (date: string): number => new Date(utcOf(date)).getUTCDay();

/** The first day of the week holding `date`, weeks starting on `weekStart` (0 Sunday, 1 Monday, 6 Saturday). */
export const startOfWeek = (date: string, weekStart: number): string =>
  addDays(date, -((weekday(date) - weekStart + 7) % 7));

export const startOfMonth = (date: string): string => `${date.slice(0, 7)}-01`;

/** The first of the month `n` months from `date`'s. */
export function addMonths(date: string, n: number): string {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

/** A `Date` whose UTC fields are `date`'s, for formatting with `timeZone: "UTC"`. */
export const asUtcDate = (date: string): Date => new Date(utcOf(date));

/** Format a day (no time) in the user's locale. */
export const formatDay = (date: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(asUtcDate(date));

/** Format a time of day in `tz`, e.g. "2:30 PM" or "14:30" by locale. */
export const formatTime = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );

/** "2 PM"-style hour label for the time gutter. */
export const formatHour = (hour: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 1, hour)),
  );
