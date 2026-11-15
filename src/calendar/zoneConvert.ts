// The command palette's time zone converter: "3pm PT in Athens", "15:00 London to Tokyo", "noon in
// New York", "now in Tokyo". The time is read with chrono-node, the zones by IANA city name (any
// case) or a few common abbreviations; with no zone before "in", the time is the calendar's.
import * as chrono from "chrono-node";
import { formatDay, formatTime, wallClock, zonedMs } from "./dates";
import { dayShift, formatOffset, offsetMinutes, zoneCity, zoneIds, zoneRegion } from "./zones";

/** The abbreviations people write, each read as the zone that uses it (PST in July is still PT). */
const ABBREVIATIONS: Record<string, string> = {
  utc: "UTC",
  gmt: "UTC",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  mt: "America/Denver",
  ct: "America/Chicago",
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  cet: "Europe/Berlin",
  cest: "Europe/Berlin",
  bst: "Europe/London",
  ist: "Asia/Kolkata",
  jst: "Asia/Tokyo",
  aest: "Australia/Sydney",
};

export interface NamedZone {
  zone: string;
  /** As the answer says it: the abbreviation typed ("PT"), else the city ("New York"). */
  name: string;
}

let cities: Map<string, string> | null = null;
/** Every zone by its city ("new york") and its id ("america/new_york", "america/new york"). */
function cityIndex(): Map<string, string> {
  if (cities) return cities;
  cities = new Map();
  for (const id of zoneIds()) {
    for (const key of [zoneCity(id), id, id.replace(/_/g, " ")].map((k) => k.toLowerCase()))
      if (!cities.has(key)) cities.set(key, id);
  }
  return cities;
}

/** The zone `text` names ("PT", "athens", "New York time", "Asia/Tokyo"), or null. */
export function findZone(text: string): NamedZone | null {
  const key = text
    .trim()
    .replace(/\s+time$/i, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!key) return null;
  const abbreviation = ABBREVIATIONS[key];
  if (abbreviation) return { zone: abbreviation, name: key.toUpperCase() };
  const zone = cityIndex().get(key) ?? cityIndex().get(key.replace(/_/g, " "));
  return zone ? { zone, name: zoneCity(zone) } : null;
}

export interface ZoneOption {
  zone: string;
  /** "Kolkata · Asia · UTC+5:30": the city, its region and its offset now. */
  label: string;
}

/**
 * Zones matching what's typed in a zone picker: every word somewhere in the city, region, id or
 * offset now ("kolk", "europe ath", "utc+5:30"), an abbreviation ("PT") first, then cities that
 * start with the text. At most `limit`.
 */
export function searchZones(query: string, now: number, limit = 50): ZoneOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const exact = findZone(q)?.zone;
  const found = zoneIds()
    .map((zone) => {
      const city = zoneCity(zone);
      const region = zoneRegion(zone);
      const offset = formatOffset(offsetMinutes(now, zone));
      const text = `${city} ${region} ${zone} ${offset}`.toLowerCase();
      if (zone !== exact && !words.every((w) => text.includes(w))) return null;
      const c = city.toLowerCase();
      const rank = zone === exact ? 0 : c.startsWith(q) ? 1 : c.includes(q) ? 2 : 3;
      return { zone, rank, city, label: [city, region, offset].filter(Boolean).join(" · ") };
    })
    .filter((z) => z !== null)
    .sort((a, b) => a.rank - b.rank || a.city.localeCompare(b.city));
  return found.slice(0, limit).map(({ zone, label }) => ({ zone, label }));
}

export interface Conversion {
  /** The instant converted. */
  ms: number;
  from: NamedZone;
  to: NamedZone;
  /** "3:00 PM PT is 12:00 AM in Athens (+1 day)": the palette's row, and what Enter copies. */
  text: string;
}

/** "in", "to", or an arrow between the time and the zone wanted; the last one counts. */
const TARGET_RE = /^(.*\S)\s+(?:in|to|into|->|→)\s+(\S.*)$/i;
/** A zone written before "in" can be up to this many words ("Ho Chi Minh"). */
const MAX_ZONE_WORDS = 3;

/** The time `text` names, as wall clock in `zone`, read as of `now`; null unless it's only a time. */
function readTime(text: string, zone: string, now: number): number | null {
  const t = text.trim();
  if (/^(?:now|right now)$/i.test(t)) return now;
  const ref = { instant: new Date(now), timezone: offsetMinutes(now, zone) };
  let results = chrono.parse(t, ref);
  // A weekday alone ("Friday 3pm") means the next one, but a time alone is today's.
  const first = results[0]?.start;
  if (first?.isCertain("weekday") && !first.isCertain("day"))
    results = chrono.parse(t, ref, { forwardDate: true });
  const r = results[0];
  // All of it must be the time: "3pm HST" leaves "HST" over, a zone we don't know.
  if (results.length !== 1 || r.index !== 0 || r.text.length !== t.length) return null;
  const c = r.start;
  if (!c.isCertain("hour") || c.isCertain("timezoneOffset")) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;
  return zonedMs(date, (c.get("hour") ?? 0) * 60 + (c.get("minute") ?? 0), zone);
}

/**
 * The palette query as a conversion, or null when it isn't one. `calendarZone` is the zone a time
 * with no zone of its own is in.
 */
export function parseConversion(
  query: string,
  { now, calendarZone }: { now: number; calendarZone: string },
): Conversion | null {
  const m = TARGET_RE.exec(query.trim());
  if (!m) return null;
  const to = findZone(m[2]);
  if (!to) return null;
  const words = m[1].split(/\s+/);
  let from: NamedZone = { zone: calendarZone, name: zoneCity(calendarZone) };
  let timeText = m[1];
  for (let k = Math.min(MAX_ZONE_WORDS, words.length - 1); k >= 1; k--) {
    const found = findZone(words.slice(-k).join(" "));
    if (found) {
      from = found;
      timeText = words.slice(0, -k).join(" ");
      break;
    }
  }
  const ms = readTime(timeText, from.zone, now);
  if (ms === null) return null;
  return { ms, from, to, text: describeConversion(ms, from, to, now) };
}

/** "3:00 PM PT is 12:00 AM in Athens (+1 day)", with the day when it isn't today in `from`. */
function describeConversion(ms: number, from: NamedZone, to: NamedZone, now: number): string {
  const fromDate = wallClock(ms, from.zone).date;
  const day =
    fromDate === wallClock(now, from.zone).date
      ? ""
      : `${formatDay(fromDate, { weekday: "short", month: "short", day: "numeric" })}, `;
  const shift = dayShift(fromDate, wallClock(ms, to.zone).date);
  return `${day}${formatTime(ms, from.zone)} ${from.name} is ${formatTime(ms, to.zone)} in ${
    to.name
  }${shift ? ` (${shift})` : ""}`;
}
