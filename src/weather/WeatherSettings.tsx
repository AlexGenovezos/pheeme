// Settings › Calendar › Weather: the switch, the home location (typed, or found from the
// calendar's time zone) and the temperature unit.
import { LocateFixed, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { displayZone, useCalendarStore } from "../calendar/calendarStore";
import { IconButton } from "../components/ui/IconButton";
import { Listbox, PickerPopover } from "../components/ui/Picker";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import {
  getCalendarAccounts,
  searchWeatherPlaces,
  type TemperatureUnit,
  toCommandError,
  type WeatherPlace,
} from "../lib/tauri";
import { placeLabel, useWeatherSettings } from "./weatherSettings";
import "./weather.css";

/** Wait this long after the last key before searching. */
const SEARCH_DELAY_MS = 300;

/**
 * The town a time zone is named after, when Open-Meteo knows one there: "America/New_York" is
 * New York. Zones like "Etc/UTC" or "Asia/Kolkata" for Delhi don't name the user's town; the
 * user types it instead.
 */
export async function placeFromZone(tz: string): Promise<WeatherPlace | null> {
  const city = tz.includes("/") ? tz.split("/").pop()!.replace(/_/g, " ") : "";
  if (city.length < 2 || tz.startsWith("Etc/")) return null;
  const places = await searchWeatherPlaces(city);
  return places.find((p) => p.timeZone === tz) ?? null;
}

/** Sets home from the calendar's time zone; says so when it can't. */
async function detectHome(): Promise<boolean> {
  try {
    // Before Calendar mode has opened, its accounts (and their time zone) aren't read yet.
    const accounts = useCalendarStore.getState().accounts ?? (await getCalendarAccounts());
    const tz = displayZone(accounts);
    const place = await placeFromZone(tz);
    if (place) {
      useWeatherSettings.getState().setHome(place);
      return true;
    }
    toast({
      title: "Couldn't tell your town from your time zone",
      description: `${tz} doesn't name it. Type your town in Settings › Calendar.`,
    });
  } catch (raw) {
    toast({
      title: "Couldn't look up your town",
      description: toCommandError(raw).message,
      tone: "danger",
    });
  }
  return false;
}

export function ShowWeatherControl() {
  const enabled = useWeatherSettings((s) => s.enabled);
  const setEnabled = useWeatherSettings((s) => s.setEnabled);
  return (
    <Switch
      label="Show weather"
      checked={enabled}
      onChange={(on) => {
        setEnabled(on);
        // First time on: find home from the time zone, so the forecast shows straight away.
        if (on && !useWeatherSettings.getState().home) void detectHome();
      }}
    />
  );
}

export function AnimateWeatherControl() {
  const animate = useWeatherSettings((s) => s.animate);
  const setAnimate = useWeatherSettings((s) => s.setAnimate);
  return <Switch label="Animate weather" checked={animate} onChange={setAnimate} />;
}

export function HomeLocationControl() {
  const home = useWeatherSettings((s) => s.home);
  const setHome = useWeatherSettings((s) => s.setHome);
  const [text, setText] = useState<string | null>(null);
  // The last search's answer, for the text it was for: other text has no results yet.
  const [found, setFound] = useState<{ query: string; places: WeatherPlace[] } | null>(null);
  const [active, setActive] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const field = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const editing = text !== null;
  const query = text?.trim() ?? "";
  const results = query.length >= 2 && found?.query === query ? found.places : null;

  // Search as the user types, once they pause.
  useEffect(() => {
    if (query.length < 2) return;
    const run = { live: true };
    const timer = setTimeout(() => {
      searchWeatherPlaces(query).then(
        (places) => {
          if (!run.live) return;
          setFound({ query, places });
          setActive(0);
        },
        () => run.live && setFound({ query, places: [] }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      run.live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const stopEditing = () => setText(null);
  const choose = (place: WeatherPlace | undefined) => {
    if (!place) return;
    setHome(place);
    stopEditing();
  };
  const open = editing && results !== null;
  const options = (results ?? []).map((p, i) => ({ id: `${listId}-${i}`, label: placeLabel(p) }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && open) setActive((a) => Math.min(a + 1, options.length - 1));
    else if (e.key === "ArrowUp" && open) setActive((a) => Math.max(a - 1, 0));
    else if (e.key === "Enter" && open) choose(results?.[active]);
    // Escape puts the chosen place back, and doesn't close Settings.
    else if (e.key === "Escape" && editing) stopEditing();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <span ref={field} className="weather-home">
        <TextInput
          leading={<Search aria-hidden="true" />}
          role="combobox"
          aria-label="Home location"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && options[active] ? options[active].id : undefined}
          placeholder="Type a town"
          value={text ?? (home ? placeLabel(home) : "")}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onBlur={stopEditing}
          onKeyDown={onKeyDown}
        />
      </span>
      <IconButton
        label="Find from my time zone"
        icon={<LocateFixed />}
        disabled={detecting}
        onClick={() => {
          setDetecting(true);
          void detectHome().finally(() => setDetecting(false));
        }}
      />
      {open && (
        <PickerPopover anchor={field} onClose={stopEditing} className="ui-picker--list" matchWidth>
          {options.length > 0 ? (
            <Listbox
              id={listId}
              label="Towns"
              options={options}
              active={active}
              onActive={setActive}
              onPick={(i) => choose(results?.[i])}
            />
          ) : (
            <p className="weather-home__none">No town by that name</p>
          )}
        </PickerPopover>
      )}
    </>
  );
}

const UNIT_LABELS: Record<TemperatureUnit, string> = { fahrenheit: "°F", celsius: "°C" };

export function TemperatureUnitControl() {
  const unit = useWeatherSettings((s) => s.unit);
  const setUnit = useWeatherSettings((s) => s.setUnit);
  return (
    <SegmentedControl
      label="Temperature unit"
      value={unit}
      options={(["fahrenheit", "celsius"] as const).map((value) => ({
        value,
        label: UNIT_LABELS[value],
      }))}
      onChange={setUnit}
    />
  );
}
