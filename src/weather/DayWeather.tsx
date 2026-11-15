// The forecast at the top of a day: an icon, the high and the low. With weather on, every day
// keeps the same slot from the first frame, empty for days outside the forecast.
import type { CSSProperties } from "react";
import { Skeleton } from "../components/ui/Skeleton";
import { cx } from "../lib/utils";
import { condition, degrees } from "./codes";
import { inForecastRange, useHomeForecast } from "./forecast";
import { useWeatherSettings } from "./weatherSettings";
import "./weather.css";

export function DayWeather({
  date,
  variant = "full",
  style,
}: {
  date: string;
  /** `compact` leaves out the low, `icon` both temperatures; `month` sits in a month cell's date row. */
  variant?: "full" | "compact" | "icon" | "month";
  style?: CSSProperties;
}) {
  const className = cx(
    "weather-day",
    (variant === "compact" || variant === "month") && "weather-day--compact",
    variant === "icon" && "weather-day--icon",
    variant === "month" && "weather-day--month",
  );
  const on = useWeatherSettings((s) => s.enabled && s.home !== null);
  const days = useHomeForecast((s) => s.days);
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
  const { label, Icon } = condition(day.code);
  const words = `${label}, high ${degrees(day.high)}, low ${degrees(day.low)}`;
  return (
    <span className={className} style={style} title={words} aria-label={words} role="img">
      <Icon aria-hidden="true" className="weather-day__icon" />
      <span className="weather-day__high">{degrees(day.high)}</span>
      <span className="weather-day__low">{degrees(day.low)}</span>
    </span>
  );
}
