// The forecast for an event's location, a row in its popover. Whether the row shows is decided
// before anything loads (weather on, a place-like location, a day in the forecast), so the
// popover keeps its size: the row starts as a placeholder and fills in.
import { Pause, Play } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { daysBetween, dateOf, formatDay, isValidZone } from "../calendar/dates";
import { cx } from "../lib/utils";
import {
  type CalendarEvent,
  getLocationForecast,
  type LocationForecast,
  toCommandError,
} from "../lib/tauri";
import { condition, degrees } from "./codes";
import { FORECAST_DAYS } from "./forecast";
import { WeatherArt } from "./WeatherArt";
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
  const animate = useWeatherSettings((s) => s.animate);
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
  if (load.kind === "loading") {
    return (
      <Card
        art={<Skeleton shape="block" className="weather-event__art" />}
        head={<Skeleton className="weather-event__line" width="40%" />}
        place={<Skeleton className="weather-event__line" width="65%" />}
      />
    );
  }
  const forecast = load.kind === "ready" ? load.forecast : null;
  // The day in the place's own time zone, which the forecast's dates are in.
  const placeZone = forecast?.place.timeZone;
  const placeDate = isValidZone(placeZone) ? eventDate(event, placeZone) : date;
  const day = forecast?.days.find((d) => d.date === placeDate);
  if (!day) {
    const why =
      load.kind === "failed"
        ? load.message
        : forecast
          ? `None yet for ${forecast.place.name} that day`
          : "Pheeme can't tell which town this is";
    return (
      <Card
        art={<WeatherArt kind="cloudy" seed={location} className="weather-event__art" />}
        head="No forecast"
        place={why}
        muted
      />
    );
  }
  const { label, kind, intensity } = condition(day.code);
  return (
    <Card
      art={
        <WeatherArt
          kind={kind}
          intensity={intensity}
          seed={day.date}
          motion={animate ? "live" : "still"}
          className="weather-event__art"
        />
      }
      head={
        <>
          {label}{" "}
          <span className="weather-event__temps">
            {degrees(day.high)} <span className="weather-event__low">/ {degrees(day.low)}</span>
          </span>
        </>
      }
      place={`${forecast!.place.name} · ${formatDay(placeDate!, { weekday: "long" })}`}
    />
  );
}

/** Stops or starts the drawings moving (the same switch as Settings › Calendar). */
function AnimateToggle() {
  const animate = useWeatherSettings((s) => s.animate);
  const setAnimate = useWeatherSettings((s) => s.setAnimate);
  return (
    <IconButton
      size="sm"
      className="weather-event__toggle"
      label={animate ? "Stop weather animation" : "Animate weather"}
      aria-pressed={animate}
      icon={animate ? <Pause /> : <Play />}
      onClick={() => setAnimate(!animate)}
    />
  );
}

/** The same box in every state, so the popover doesn't move when the forecast arrives. */
function Card({
  art,
  head,
  place,
  muted = false,
}: {
  art: ReactNode;
  head: ReactNode;
  place: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={cx("weather-event", muted && "weather-event--muted")} aria-label="Weather">
      {art}
      <div className="weather-event__text">
        <div className="weather-event__head">{head}</div>
        <div className="weather-event__place">{place}</div>
      </div>
      <AnimateToggle />
    </div>
  );
}
