// The forecast at the top of a day: the drawn weather (it moves while pointed at, when animation is on), the high and the
// low. With weather on, every day keeps the same slot from the first frame, empty for days
// outside the forecast.
import type { CSSProperties } from "react";
import { Skeleton } from "../components/ui/Skeleton";
import { cx } from "../lib/utils";
import { condition, degrees } from "./codes";
import { inForecastRange, useHomeForecast } from "./forecast";
import { WeatherArt } from "./WeatherArt";
import { useWeatherSettings } from "./weatherSettings";
import "./weather.css";

/** What fits: high and low, the high alone, or only the drawing (the words are in its tooltip). */
export type DayWeatherFit = "full" | "high" | "icon";

/** What fits in a day `width` px wide, given the px the full and high-only forms need. */
export function weatherFit(width: number, fullPx: number, highPx: number): DayWeatherFit {
  return width >= fullPx ? "full" : width >= highPx ? "high" : "icon";
}

export function DayWeather({
  date,
  fit = "full",
  inMonth = false,
  style,
}: {
  date: string;
  fit?: DayWeatherFit;
  /** Sits in a month cell's date row, at its right. */
  inMonth?: boolean;
  style?: CSSProperties;
}) {
  const className = cx(
    "weather-day",
    fit !== "full" && `weather-day--${fit}`,
    inMonth && "weather-day--month",
  );
  const on = useWeatherSettings((s) => s.enabled && s.home !== null);
  const days = useHomeForecast((s) => s.days);
  const animate = useWeatherSettings((s) => s.animate);
  if (!on) return null;
  const day = days?.[date];
  if (!day) {
    return (
      <span className={className} style={style} aria-hidden="true">
        {days === null && inForecastRange(date) && (
          <Skeleton shape="block" className="weather-day__pending" />
        )}
      </span>
    );
  }
  const { label, kind, intensity } = condition(day.code);
  const words = `${label}, high ${degrees(day.high)}, low ${degrees(day.low)}`;
  return (
    <span className={className} style={style} title={words} aria-label={words} role="img">
      <WeatherArt
        kind={kind}
        intensity={intensity}
        seed={date}
        motion={animate ? "hover" : "still"}
        className="weather-day__art"
      />
      <span className="weather-day__high">{degrees(day.high)}</span>
      <span className="weather-day__low">{degrees(day.low)}</span>
    </span>
  );
}
