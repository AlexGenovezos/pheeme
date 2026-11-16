import { call } from "./call";

// Weather (Calendar mode, off by default): Open-Meteo forecasts, fetched by the Rust side.
export type TemperatureUnit = "celsius" | "fahrenheit";

/** A town or city a forecast is for. */
export interface WeatherPlace {
  name: string;
  /** State, province or region. */
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  /** The place's IANA time zone, which its forecast's dates are in. */
  timeZone: string | null;
}

/** One day's forecast; `date` is `YYYY-MM-DD` in the place's time zone. */
export interface DayForecast {
  date: string;
  /** WMO weather code. */
  code: number;
  high: number;
  low: number;
}

export interface LocationForecast {
  place: WeatherPlace;
  days: DayForecast[];
}

export const searchWeatherPlaces = (query: string) => call("weather_search_places", { query });
export const getWeatherForecast = (latitude: number, longitude: number, unit: TemperatureUnit) =>
  call("weather_forecast", { latitude, longitude, unit });
/** The forecast for an event's location; null when no town can be told from it. */
export const getLocationForecast = (location: string, unit: TemperatureUnit) =>
  call("weather_for_location", { location, unit });
