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

/** Light, moderate or heavy: how much rain or snow the drawing lets fall. */
export type Intensity = 1 | 2 | 3;

const CONDITIONS: Array<[codes: number[], label: string, kind: WeatherKind, intensity: Intensity]> =
  [
    [[0], "Clear", "clear", 2],
    [[1], "Mostly clear", "clear", 2],
    [[2], "Partly cloudy", "partly", 2],
    [[3], "Cloudy", "cloudy", 2],
    [[45, 48], "Fog", "fog", 2],
    [[51], "Light drizzle", "drizzle", 1],
    [[53], "Drizzle", "drizzle", 2],
    [[55], "Heavy drizzle", "drizzle", 3],
    [[56], "Freezing drizzle", "drizzle", 1],
    [[57], "Freezing drizzle", "drizzle", 3],
    [[61], "Light rain", "rain", 1],
    [[63], "Rain", "rain", 2],
    [[65], "Heavy rain", "rain", 3],
    [[66], "Freezing rain", "rain", 1],
    [[67], "Heavy freezing rain", "rain", 3],
    [[80], "Showers", "rain", 1],
    [[81], "Showers", "rain", 2],
    [[82], "Heavy showers", "rain", 3],
    [[71], "Light snow", "snow", 1],
    [[73, 77], "Snow", "snow", 2],
    [[75], "Heavy snow", "snow", 3],
    [[85], "Snow showers", "snow", 2],
    [[86], "Heavy snow showers", "snow", 3],
    [[95], "Thunderstorms", "storm", 2],
    [[96, 99], "Thunderstorms with hail", "storm", 3],
  ];

/** The words and scene for a weather code; an unknown code reads as cloudy. */
export function condition(code: number): {
  label: string;
  kind: WeatherKind;
  intensity: Intensity;
} {
  const found = CONDITIONS.find(([codes]) => codes.includes(code));
  return found
    ? { label: found[1], kind: found[2], intensity: found[3] }
    : { label: "Cloudy", kind: "cloudy", intensity: 2 };
}

/** A whole-degree temperature: "61°". */
export const degrees = (t: number) => `${Math.round(t)}°`;
