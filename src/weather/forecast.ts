// The home location's daily forecast, for the day headers. Read when Calendar mode shows with
// weather on, and again once it's an hour old (the Rust side keeps it for that hour too).
import { useEffect } from "react";
import { create } from "zustand";
import { addDays, dateOf, systemZone } from "../calendar/dates";
import { type DayForecast, getWeatherForecast } from "../lib/tauri";
import { useWeatherSettings } from "./weatherSettings";

const HOUR_MS = 60 * 60 * 1000;
/** After a failed read, try again this much sooner than an hour. */
const RETRY_MS = 5 * 60 * 1000;
/** How often the calendar checks whether the forecast is due a refresh. */
const CHECK_MS = 10 * 60 * 1000;
/** Open-Meteo's forecast covers today and the 15 days after it. */
export const FORECAST_DAYS = 16;

interface HomeForecast {
  /** The home location and unit the days are for. */
  key: string | null;
  /** By date; `null` until the first read for `key` has finished (`{}` if it failed). */
  days: Record<string, DayForecast> | null;
  at: number;
  /** The key a read is under way for. */
  reading: string | null;
}

export const useHomeForecast = create<HomeForecast>(() => ({
  key: null,
  days: null,
  at: 0,
  reading: null,
}));

/** Reads the forecast when the settings changed or it's an hour old. */
export function refreshHomeForecast() {
  const { enabled, home, unit } = useWeatherSettings.getState();
  if (!enabled || !home) return;
  const key = `${home.latitude},${home.longitude},${unit}`;
  const s = useHomeForecast.getState();
  if (s.key === key && s.days && Date.now() - s.at < HOUR_MS) return;
  if (s.reading === key) return;
  useHomeForecast.setState(
    s.key === key ? { reading: key } : { key, days: null, at: 0, reading: key },
  );
  const done = () => {
    if (useHomeForecast.getState().reading === key) useHomeForecast.setState({ reading: null });
    return useHomeForecast.getState().key === key;
  };
  getWeatherForecast(home.latitude, home.longitude, unit).then(
    (days) => {
      if (!done()) return;
      useHomeForecast.setState({
        days: Object.fromEntries(days.map((d) => [d.date, d])),
        at: Date.now(),
      });
    },
    () => {
      if (!done()) return;
      // Loaded, with nothing: the headers drop their placeholders; a later check tries again.
      useHomeForecast.setState((st) => ({
        days: st.days ?? {},
        at: Date.now() - HOUR_MS + RETRY_MS,
      }));
    },
  );
}

/** Keeps the home forecast fresh while the calendar is on screen. */
export function useWeatherRefresh() {
  const enabled = useWeatherSettings((s) => s.enabled);
  const home = useWeatherSettings((s) => s.home);
  const unit = useWeatherSettings((s) => s.unit);
  useEffect(() => {
    if (!enabled || !home) return;
    refreshHomeForecast();
    const timer = setInterval(refreshHomeForecast, CHECK_MS);
    return () => clearInterval(timer);
  }, [enabled, home, unit]);
}

/** Whether a forecast can exist for `date`: today through the last forecast day. */
export function inForecastRange(date: string, now = Date.now()): boolean {
  const today = dateOf(now, systemZone());
  // A day either side: the home location's "today" can differ from this computer's.
  return date >= addDays(today, -1) && date <= addDays(today, FORECAST_DAYS);
}
