// Time zone names and arithmetic shared by the time gutter's extra columns, the popover's other
// zones, the travelling note and the palette's converter. Zones are IANA ids ("Europe/Athens").
import { daysBetween, formatHour, isValidZone, wallClock, zonedMs } from "./dates";

/**
 * Zones the runtime's list (ICU's) still knows by an old name: Kolkata is listed as Calcutta.
 * Both names work; people search for and expect the new one.
 */
const RENAMED: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** A zone's current name, where the runtime knows it ("Asia/Calcutta" is "Asia/Kolkata"). */
const currentName = (tz: string): string => {
  const renamed = RENAMED[tz];
  return renamed && isValidZone(renamed) ? renamed : tz;
};

/** Every IANA zone this runtime knows, by current names, sorted, with UTC and `extra` in the list. */
export function zoneIds(extra: readonly string[] = []): string[] {
  const all =
    (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ??
    [];
  return [...new Set([...all.map(currentName), "UTC", ...extra])].sort();
}

/** The place a zone is named after: "America/New_York" is "New York", "Etc/UTC" is "UTC". */
export function zoneCity(tz: string): string {
  if (tz === "UTC" || tz.startsWith("Etc/")) return tz.replace(/^Etc\//, "");
  return (currentName(tz).split("/").pop() ?? tz).replace(/_/g, " ");
}

/** The region part of a zone ("America/Argentina/Buenos_Aires" is "America, Argentina"), or "". */
export function zoneRegion(tz: string): string {
  return tz.split("/").slice(0, -1).join(", ").replace(/_/g, " ");
}

/** `tz`'s offset from UTC at `ms`, in minutes (Athens in summer is 180). */
export function offsetMinutes(ms: number, tz: string): number {
  const { date, minutes } = wallClock(ms, tz);
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) + minutes * 60_000 - ms) / 60_000);
}

/** "UTC+5:30", "UTC−3", "UTC" for an offset in minutes. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  const m = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "EST"-style name of the zone at `ms`, or its offset ("GMT+3") where it has no short name. */
export function zoneShortName(tz: string, ms = Date.now()): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** "+1 day", "−1 day", "+2 days", or "" when `to` is `from`. */
export function dayShift(from: string, to: string): string {
  const n = daysBetween(from, to);
  if (n === 0) return "";
  return `${n > 0 ? "+" : "−"}${Math.abs(n)} ${Math.abs(n) === 1 ? "day" : "days"}`;
}

/** A gutter label: the wall clock in the other zone where a main-zone hour line sits. */
export interface GutterTime {
  hour: number;
  minute: number;
}

/**
 * The other zone's time at each of `date`'s 24 hour lines in `mainTz`, for the extra gutter
 * columns. Zones half or three quarters of an hour off ("Asia/Kolkata") land on :30 or :45.
 */
export function gutterTimes(date: string, mainTz: string, otherTz: string): GutterTime[] {
  return Array.from({ length: 24 }, (_, h) => {
    const { minutes } = wallClock(zonedMs(date, h * 60, mainTz), otherTz);
    return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
  });
}

/** "2 PM" on the hour, else "2:30 PM" (or "14:30", by locale). */
export function formatGutterTime({ hour, minute }: GutterTime): string {
  if (minute === 0) return formatHour(hour);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

/** "7 hours", "1 hour", "5 hours 30 minutes", "45 minutes" for a gap in minutes. */
export function formatGap(minutes: number): string {
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [
    h ? `${h} ${h === 1 ? "hour" : "hours"}` : "",
    m ? `${m} ${m === 1 ? "minute" : "minutes"}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * The note for when the computer's zone is off the calendar's right now ("Your computer is on
 * Athens time, 7 hours ahead of your calendar (New York)."), or null when their clocks agree.
 */
export function travelNote(calendarZone: string, computerZone: string, now: number): string | null {
  const gap = offsetMinutes(now, computerZone) - offsetMinutes(now, calendarZone);
  if (gap === 0) return null;
  return `Your computer is on ${zoneCity(computerZone)} time, ${formatGap(gap)} ${
    gap > 0 ? "ahead of" : "behind"
  } your calendar (${zoneCity(calendarZone)}).`;
}
