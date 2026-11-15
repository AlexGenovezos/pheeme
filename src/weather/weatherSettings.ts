// Weather in Calendar mode: on or off (off by default), the home location the day headers'
// forecast is for, and the temperature unit. Kept in localStorage; nothing else needs them.
import { create } from "zustand";
import type { TemperatureUnit, WeatherPlace } from "../lib/tauri";

export const WEATHER_KEY = "pheeme.weather";

/** Where Fahrenheit is the everyday unit. */
const FAHRENHEIT_REGIONS = new Set(["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"]);

/** Fahrenheit where the computer's language says it's the everyday unit, else Celsius. */
export function localUnit(language = navigator.language): TemperatureUnit {
  try {
    const region = new Intl.Locale(language).maximize().region;
    return region && FAHRENHEIT_REGIONS.has(region) ? "fahrenheit" : "celsius";
  } catch {
    return "celsius";
  }
}

interface Stored {
  enabled: boolean;
  /** The drawings move (in the popover, and on the day pointed at); off, they hold still. */
  animate: boolean;
  home: WeatherPlace | null;
  unit: TemperatureUnit;
}

function read(): Stored {
  const fallback: Stored = { enabled: false, animate: true, home: null, unit: localUnit() };
  try {
    const raw = localStorage.getItem(WEATHER_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<Stored>;
    return {
      enabled: stored.enabled === true,
      animate: stored.animate !== false,
      home: stored.home && typeof stored.home.latitude === "number" ? stored.home : fallback.home,
      unit: stored.unit === "fahrenheit" || stored.unit === "celsius" ? stored.unit : fallback.unit,
    };
  } catch {
    return fallback;
  }
}

interface WeatherSettings extends Stored {
  setEnabled(enabled: boolean): void;
  setAnimate(animate: boolean): void;
  setHome(home: WeatherPlace | null): void;
  setUnit(unit: TemperatureUnit): void;
}

export const useWeatherSettings = create<WeatherSettings>((set, get) => {
  const save = (patch: Partial<Stored>) => {
    set(patch);
    const { enabled, animate, home, unit } = get();
    try {
      localStorage.setItem(WEATHER_KEY, JSON.stringify({ enabled, animate, home, unit }));
    } catch {
      // Storage full or blocked: the choice lasts for this session.
    }
  };
  return {
    ...read(),
    setEnabled: (enabled) => save({ enabled }),
    setAnimate: (animate) => save({ animate }),
    setHome: (home) => save({ home }),
    setUnit: (unit) => save({ unit }),
  };
});

/** "Springfield, Illinois, United States", leaving out a part that repeats the one before. */
export function placeLabel(place: WeatherPlace): string {
  const parts = [place.name, place.region, place.country].filter(
    (p, i, all): p is string => !!p && p !== all[i - 1],
  );
  return parts.join(", ");
}
