// Browser preview: Open-Meteo stand-ins. A forecast for the next 16 days from `now` (the same
// for every place; its hours put each day's rain, sun or snow in a few of them), a few towns to search, and an event's location found when it names one.
import type {
  DayForecast,
  Forecast,
  HourForecast,
  TemperatureUnit,
  WeatherPlace,
} from "../lib/tauri";
import { addDays, dateOf, systemZone, zonedMs } from "../calendar/dates";
import type { PartialHandlers } from "./handlers";

const PLACES: WeatherPlace[] = [
  {
    name: "San Francisco",
    region: "California",
    country: "United States",
    latitude: 37.77,
    longitude: -122.42,
    timeZone: "America/Los_Angeles",
  },
  {
    name: "New York",
    region: "New York",
    country: "United States",
    latitude: 40.71,
    longitude: -74.01,
    timeZone: "America/New_York",
  },
  {
    name: "London",
    region: "England",
    country: "United Kingdom",
    latitude: 51.51,
    longitude: -0.13,
    timeZone: "Europe/London",
  },
  {
    name: "Springfield",
    region: "Illinois",
    country: "United States",
    latitude: 39.8,
    longitude: -89.64,
    timeZone: "America/Chicago",
  },
];

const CODES = [0, 2, 3, 61, 1, 80, 45, 71, 95, 2, 0, 63, 3, 1, 51, 0];

/** The hours a day's weather happens in, by its code; the rest of the day is cloudy (or clear at night). */
const SPANS: Record<number, [from: number, to: number, mm: number]> = {
  0: [7, 17, 0],
  1: [9, 15, 0],
  2: [11, 14, 0],
  45: [6, 10, 0],
  51: [10, 13, 0.2],
  61: [14, 17, 0.6],
  63: [8, 12, 2],
  71: [9, 15, 1],
  80: [15, 18, 1.2],
  95: [15, 19, 6],
};

function hoursOf(day: DayForecast, zone: string): HourForecast[] {
  const span = SPANS[day.code];
  return Array.from({ length: 24 }, (_, h) => {
    const isDay = h >= 7 && h < 18;
    const inSpan = span !== undefined && h >= span[0] && h < span[1];
    // A sunny day's span is clear; a part-cloudy day clears around noon; else the day's code.
    const code = inSpan ? (day.code === 2 ? 1 : day.code) : isDay ? 3 : 0;
    return {
      at: zonedMs(day.date, h * 60, zone),
      code,
      precipitation: inSpan ? span[2] : 0,
      isDay,
    };
  });
}

function forecast(unit: TemperatureUnit, now: number): Forecast {
  const days = dailyForecast(unit, now);
  const zone = systemZone();
  return { days, hours: days.flatMap((d) => hoursOf(d, zone)) };
}

function dailyForecast(unit: TemperatureUnit, now: number): DayForecast[] {
  const today = dateOf(now, systemZone());
  return CODES.map((code, i) => {
    const highC = 12 + ((i * 7) % 9) - (code >= 71 && code < 80 ? 10 : 0);
    const lowC = highC - 6 - (i % 3);
    const t = (c: number) => (unit === "fahrenheit" ? (c * 9) / 5 + 32 : c);
    return { date: addDays(today, i), code, high: t(highC), low: t(lowC) };
  });
}

export function createWeatherHandlers(now = Date.now()) {
  const unitOf = (args: { unit: TemperatureUnit }) =>
    args.unit === "fahrenheit" ? "fahrenheit" : "celsius";
  return {
    weather_search_places: (args) => {
      const query = String(args.query ?? "")
        .trim()
        .toLowerCase();
      return query.length < 2 ? [] : PLACES.filter((p) => p.name.toLowerCase().startsWith(query));
    },
    weather_forecast: (args) => forecast(unitOf(args), now),
    weather_for_location: (args) => {
      const location = String(args.location ?? "").toLowerCase();
      const place = PLACES.find((p) => location.includes(p.name.toLowerCase()));
      return place ? { place, days: dailyForecast(unitOf(args), now) } : null;
    },
  } satisfies PartialHandlers;
}
