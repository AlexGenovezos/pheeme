// Calendar mode's other time zones: up to two zones (each with an optional short label) that the
// Day and Week gutter and the event popover show beside the calendar's own, and the travelling
// notes the user dismissed. Kept in localStorage; nothing else needs them.
import { create } from "zustand";
import { isValidZone } from "./dates";
import { zoneCity, zoneShortName } from "./zones";

export const ZONES_KEY = "pheeme.calendar-zones";
/** At most this many other zones: each takes a gutter column. */
export const MAX_OTHER_ZONES = 2;
/** A label longer than this wouldn't fit over its gutter column. */
export const MAX_LABEL_LENGTH = 8;

export interface OtherZone {
  /** IANA id, e.g. "Europe/Athens". */
  zone: string;
  /** The user's short name for it ("Home", "SF"), or "" for the zone's own. */
  label: string;
}

interface Stored {
  zones: OtherZone[];
  /** Travelling notes put away, as `travelKey`s: one returns when the zones differ again. */
  dismissed: string[];
}

/** The key a dismissed travelling note is kept under: the calendar's zone and the computer's. */
export const travelKey = (calendarZone: string, computerZone: string): string =>
  `${calendarZone}>${computerZone}`;

// Not trimmed while typed (a space may come before the next word); shown trimmed.
const cleanLabel = (label: unknown): string =>
  typeof label === "string" ? label.slice(0, MAX_LABEL_LENGTH) : "";

/** What's stored, keeping only known zones, once each, at most `MAX_OTHER_ZONES`. */
export function parseStored(raw: string | null): Stored {
  const empty: Stored = { zones: [], dismissed: [] };
  if (!raw) return empty;
  try {
    const stored = JSON.parse(raw) as Partial<Record<keyof Stored, unknown>>;
    const zones: OtherZone[] = [];
    for (const z of Array.isArray(stored.zones) ? stored.zones : []) {
      const zone = (z as Partial<OtherZone> | null)?.zone;
      if (!isValidZone(zone) || zones.some((o) => o.zone === zone)) continue;
      zones.push({ zone, label: cleanLabel((z as Partial<OtherZone>).label).trim() });
      if (zones.length === MAX_OTHER_ZONES) break;
    }
    const dismissed = Array.isArray(stored.dismissed)
      ? stored.dismissed.filter((d): d is string => typeof d === "string")
      : [];
    return { zones, dismissed };
  } catch {
    return empty;
  }
}

function read(): Stored {
  try {
    return parseStored(localStorage.getItem(ZONES_KEY));
  } catch {
    return { zones: [], dismissed: [] };
  }
}

interface ZoneSettings extends Stored {
  /** Adds `zone` at the end; nothing when it's there already or the list is full. */
  add(zone: string): void;
  remove(zone: string): void;
  setLabel(zone: string, label: string): void;
  dismissTravel(key: string): void;
}

export const useZoneSettings = create<ZoneSettings>((set, get) => {
  const save = (patch: Partial<Stored>) => {
    set(patch);
    const { zones, dismissed } = get();
    try {
      localStorage.setItem(ZONES_KEY, JSON.stringify({ zones, dismissed }));
    } catch {
      // Storage full or blocked: the choice lasts for this session.
    }
  };
  return {
    ...read(),
    add: (zone) => {
      const { zones } = get();
      if (!isValidZone(zone) || zones.length >= MAX_OTHER_ZONES) return;
      if (zones.some((z) => z.zone === zone)) return;
      save({ zones: [...zones, { zone, label: "" }] });
    },
    remove: (zone) => save({ zones: get().zones.filter((z) => z.zone !== zone) }),
    setLabel: (zone, label) =>
      save({
        zones: get().zones.map((z) => (z.zone === zone ? { ...z, label: cleanLabel(label) } : z)),
      }),
    dismissTravel: (key) => {
      const { dismissed } = get();
      if (!dismissed.includes(key)) save({ dismissed: [...dismissed, key] });
    },
  };
});

/**
 * A zone's name over its gutter column: the user's label, else its abbreviation ("PST"), else its
 * city ("Kolkata"): an offset name like "GMT+5:30" is too wide for the column and says less.
 */
export function columnLabel(z: OtherZone, ms = Date.now()): string {
  const short = zoneShortName(z.zone, ms);
  return z.label.trim() || (/^[A-Z]{2,5}$/.test(short) ? short : zoneCity(z.zone));
}

/** A zone's name in a sentence: the user's label, else its city ("Athens"). */
export const placeName = (z: OtherZone): string => z.label.trim() || zoneCity(z.zone);
