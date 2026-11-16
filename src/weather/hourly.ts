// The hourly forecast as runs: the stretches of a day with one kind of weather worth drawing
// in the calendar's hours (sun, rain, snow, a storm, fog), in the calendar's time zone.
// Cloudy and part-cloudy hours and clear nights draw nothing, so ordinary days stay quiet.
import { useMemo } from "react";
import { wallClock } from "../calendar/dates";
import type { HourForecast } from "../lib/tauri";
import { condition, type Intensity } from "./codes";
import { useHomeForecast } from "./forecast";
import { useWeatherSettings } from "./weatherSettings";

export type RunKind = "sun" | "rain" | "snow" | "storm" | "fog";

export interface HourRun {
  kind: RunKind;
  /** Minutes since the day's midnight in the calendar's zone, end exclusive. */
  start: number;
  end: number;
  intensity: Intensity;
}

const DAY_MINUTES = 24 * 60;

/** What an hour draws, if anything. */
export function runKind(code: number, isDay: boolean): RunKind | null {
  switch (condition(code).kind) {
    case "clear":
      return isDay ? "sun" : null;
    case "drizzle":
    case "rain":
      return "rain";
    case "snow":
      return "snow";
    case "storm":
      return "storm";
    case "fog":
      return "fog";
    default:
      return null;
  }
}

/** The code's intensity, raised when more falls than it says (mm in the hour). */
function intensityOf(code: number, precipitation: number): Intensity {
  const base = condition(code).intensity;
  if (precipitation >= 4) return 3;
  if (precipitation >= 1) return Math.max(base, 2) as Intensity;
  return base;
}

/**
 * Each day's runs from `from` on, by date in `tz`: consecutive hours of one kind merged, an
 * hour that crosses midnight split across both days.
 */
export function hourRuns(
  hours: HourForecast[],
  tz: string,
  from: string,
): Record<string, HourRun[]> {
  const out: Record<string, HourRun[]> = {};
  const add = (date: string, run: HourRun) => {
    if (date < from || run.end <= run.start) return;
    const list = (out[date] ??= []);
    const last = list[list.length - 1];
    // Touching (or, where clocks go back, overlapping) the last run of the same kind: one run.
    if (last && last.kind === run.kind && run.start <= last.end && run.start >= last.start) {
      last.end = Math.max(last.end, run.end);
      last.intensity = Math.max(last.intensity, run.intensity) as Intensity;
    } else list.push(run);
  };
  for (const hour of hours) {
    const kind = runKind(hour.code, hour.isDay);
    if (!kind) continue;
    const intensity = intensityOf(hour.code, hour.precipitation);
    const { date, minutes } = wallClock(hour.at, tz);
    add(date, { kind, start: minutes, end: Math.min(minutes + 60, DAY_MINUTES), intensity });
    if (minutes + 60 > DAY_MINUTES) {
      const next = wallClock(hour.at + 60 * 60 * 1000, tz);
      add(next.date, { kind, start: 0, end: next.minutes, intensity });
    }
  }
  return out;
}

const WORDS: Record<RunKind, string> = {
  sun: "Sun",
  rain: "Rain",
  snow: "Snow",
  storm: "Storms",
  fog: "Fog",
};

/** "2 PM" or "2:30 PM" by locale, for minutes since midnight. */
function clock(minutes: number): string {
  const m = minutes % 60;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: m ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, 0, minutes % DAY_MINUTES)));
}

/** A day's runs in words: "Sun 9 AM–1 PM, rain 2 PM–5 PM". */
export function describeRuns(runs: HourRun[]): string {
  return runs
    .map((r, i) => {
      const word = i === 0 ? WORDS[r.kind] : WORDS[r.kind].toLowerCase();
      return `${word} ${clock(r.start)}–${clock(r.end)}`;
    })
    .join(", ");
}

const NONE: Record<string, HourRun[]> = {};

/** The home forecast's runs by date in `tz`, from `today` on; none with weather off. */
export function useHourRuns(tz: string, today: string): Record<string, HourRun[]> {
  const on = useWeatherSettings((s) => s.enabled && s.home !== null);
  const hours = useHomeForecast((s) => s.hours);
  return useMemo(() => (on && hours ? hourRuns(hours, tz, today) : NONE), [on, hours, tz, today]);
}
