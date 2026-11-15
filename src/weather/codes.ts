// WMO weather codes (what Open-Meteo sends) as words and the scene WeatherArt draws.

export type WeatherKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

const CONDITIONS: Array<[codes: number[], label: string, kind: WeatherKind]> = [
  [[0], "Clear", "clear"],
  [[1], "Mostly clear", "clear"],
  [[2], "Partly cloudy", "partly"],
  [[3], "Cloudy", "cloudy"],
  [[45, 48], "Fog", "fog"],
  [[51, 53, 55], "Drizzle", "drizzle"],
  [[56, 57], "Freezing drizzle", "drizzle"],
  [[61, 63], "Rain", "rain"],
  [[65], "Heavy rain", "rain"],
  [[66, 67], "Freezing rain", "rain"],
  [[80, 81], "Showers", "rain"],
  [[82], "Heavy showers", "rain"],
  [[71, 73, 77], "Snow", "snow"],
  [[75], "Heavy snow", "snow"],
  [[85, 86], "Snow showers", "snow"],
  [[95], "Thunderstorms", "storm"],
  [[96, 99], "Thunderstorms with hail", "storm"],
];

/** The words and scene for a weather code; an unknown code reads as cloudy. */
export function condition(code: number): { label: string; kind: WeatherKind } {
  const found = CONDITIONS.find(([codes]) => codes.includes(code));
  return found ? { label: found[1], kind: found[2] } : { label: "Cloudy", kind: "cloudy" };
}

/** A whole-degree temperature: "61°". */
export const degrees = (t: number) => `${Math.round(t)}°`;
