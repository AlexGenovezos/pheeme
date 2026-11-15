// The forecast for an event's location, a row in its popover. Whether the row shows is decided
// before anything loads (weather on, a place-like location, a day in the forecast), so the
// popover keeps its size: the row starts as a placeholder and fills in.
import { Cloud } from "lucide-react";
import { useEffect, useState } from "react";
import { Skeleton } from "../components/ui/Skeleton";
import { daysBetween, dateOf } from "../calendar/dates";
import {
  type CalendarEvent,
  getLocationForecast,
  type LocationForecast,
  toCommandError,
} from "../lib/tauri";
import { condition, degrees } from "./codes";
import { FORECAST_DAYS } from "./forecast";
import { useNow } from "../calendar/useNow";
import { useWeatherSettings } from "./weatherSettings";
import "./weather.css";

/** Whether a location has words that could name a town (the Rust side searches the same parts). */
export function mayNameAPlace(location: string): boolean {
  if (location.includes("://")) return false;
  return location.split(/[,;\n]/).some((part) => {
    const words = part.split(/\s+/).filter((w) => w && !/\d/.test(w));
    return words.join(" ").replace(/[^\p{L}]/gu, "").length >= 3;
  });
}

/** The event's day in `tz`: its date for an all-day event, else where its start falls. */
function eventDate(event: CalendarEvent, tz: string): string | null {
  if (event.allDay) return event.start.date;
  return event.start.ms === null ? null : dateOf(event.start.ms, tz);
}

type Result =
  | { kind: "ready"; forecast: LocationForecast | null }
  | { kind: "failed"; message: string };

export function EventWeather({ event, tz }: { event: CalendarEvent; tz: string }) {
  const enabled = useWeatherSettings((s) => s.enabled);
  const unit = useWeatherSettings((s) => s.unit);
  const now = useNow();
  const location = event.location?.trim() ?? "";
  const date = eventDate(event, tz);
  const ahead = date === null ? -1 : daysBetween(dateOf(now, tz), date);
  const shown = enabled && mayNameAPlace(location) && ahead >= 0 && ahead < FORECAST_DAYS;
  // What came back, for which location and unit; anything else is still loading.
  const key = `${unit}\n${location}`;
  const [result, setResult] = useState<{ key: string; value: Result } | null>(null);

  useEffect(() => {
    if (!shown) return;
    const run = { live: true };
    getLocationForecast(location, unit).then(
      (forecast) => run.live && setResult({ key, value: { kind: "ready", forecast } }),
      (e: unknown) =>
        run.live &&
        setResult({ key, value: { kind: "failed", message: toCommandError(e).message } }),
    );
    return () => {
      run.live = false;
    };
  }, [shown, key, location, unit]);

  const load = result?.key === key ? result.value : { kind: "loading" as const };
  if (!shown) return null;
  if (load.kind !== "ready") {
    return (
      <div className="cal-pop__row">
        <Cloud aria-hidden="true" />
        {load.kind === "loading" ? (
          <Skeleton className="weather-event__pending" />
        ) : (
          <span className="cal-pop__muted">{load.message}</span>
        )}
      </div>
    );
  }
  const { forecast } = load;
  // The day in the place's own time zone, which the forecast's dates are in.
  const placeDate = forecast?.place.timeZone ? eventDate(event, forecast.place.timeZone) : date;
  const day = forecast?.days.find((d) => d.date === placeDate);
  if (!forecast || !day) {
    return (
      <div className="cal-pop__row">
        <Cloud aria-hidden="true" />
        <span className="cal-pop__muted">
          {forecast
            ? `No forecast for ${forecast.place.name} that day`
            : "No forecast for this place"}
        </span>
      </div>
    );
  }
  const { label, Icon } = condition(day.code);
  return (
    <div className="cal-pop__row" title={`Forecast for ${forecast.place.name}`}>
      <Icon aria-hidden="true" />
      <span>
        {label}, {degrees(day.high)}{" "}
        <span className="weather-event__low">/ {degrees(day.low)}</span>
        <span className="cal-pop__muted"> in {forecast.place.name}</span>
      </span>
    </div>
  );
}
