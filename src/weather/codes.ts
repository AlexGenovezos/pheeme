// WMO weather codes (what Open-Meteo sends) as words and an icon.
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  type LucideIcon,
  Sun,
} from "lucide-react";

const CONDITIONS: Array<[codes: number[], label: string, icon: LucideIcon]> = [
  [[0], "Clear", Sun],
  [[1], "Mostly clear", Sun],
  [[2], "Partly cloudy", CloudSun],
  [[3], "Cloudy", Cloud],
  [[45, 48], "Fog", CloudFog],
  [[51, 53, 55], "Drizzle", CloudDrizzle],
  [[56, 57], "Freezing drizzle", CloudDrizzle],
  [[61, 63], "Rain", CloudRain],
  [[65], "Heavy rain", CloudRain],
  [[66, 67], "Freezing rain", CloudRain],
  [[80, 81], "Showers", CloudRain],
  [[82], "Heavy showers", CloudRain],
  [[71, 73, 77], "Snow", CloudSnow],
  [[75], "Heavy snow", CloudSnow],
  [[85, 86], "Snow showers", CloudSnow],
  [[95], "Thunderstorms", CloudLightning],
  [[96, 99], "Thunderstorms with hail", CloudLightning],
];

/** The words and icon for a weather code; an unknown code reads as cloudy. */
export function condition(code: number): { label: string; Icon: LucideIcon } {
  const found = CONDITIONS.find(([codes]) => codes.includes(code));
  return found ? { label: found[1], Icon: found[2] } : { label: "Cloudy", Icon: Cloud };
}

/** A whole-degree temperature: "61°". */
export const degrees = (t: number) => `${Math.round(t)}°`;
