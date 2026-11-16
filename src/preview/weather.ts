// Browser preview: Open-Meteo stand-ins. A forecast for the next 16 days from `now` (the same
// for every place), a few towns to search, and an event's location found when it names one.
import type { DayForecast, TemperatureUnit, WeatherPlace } from "../lib/tauri";
import { addDays, dateOf, systemZone } from "../calendar/dates";
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

function forecast(unit: TemperatureUnit, now: number): DayForecast[] {
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
      return place ? { place, days: forecast(unitOf(args), now) } : null;
    },
  } satisfies PartialHandlers;
}
