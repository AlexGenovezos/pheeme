import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCalendarStore } from "../calendar/calendarStore";
import type { CalendarEvent, WeatherPlace } from "../lib/tauri";
import { createWeatherHandlers } from "../preview/weather";
import { DayWeather } from "./DayWeather";
import { WeatherArt } from "./WeatherArt";
import { EventWeather, mayNameAPlace } from "./EventWeather";
import { refreshHomeForecast, useHomeForecast } from "./forecast";
import { ShowWeatherControl, placeFromZone } from "./WeatherControls";
import { localUnit, placeLabel, useWeatherSettings, WEATHER_KEY } from "./weatherSettings";

// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();
const TODAY = "2026-11-11";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const SPRINGFIELD: WeatherPlace = {
  name: "Springfield",
  region: "Illinois",
  country: "United States",
  latitude: 39.8,
  longitude: -89.64,
  timeZone: "America/Chicago",
};

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let held: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  calls = [];
  held = [];
  const handlers = createWeatherHandlers(NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (held.includes(cmd)) return new Promise(() => {});
    return handlers[cmd]?.(a);
  });
  useWeatherSettings.setState({
    enabled: true,
    animate: true,
    home: SPRINGFIELD,
    unit: "fahrenheit",
  });
  useHomeForecast.setState({ key: null, days: null, at: 0, reading: null });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

function event(location: string | null, start = NOW + 2 * 86_400_000): CalendarEvent {
  return {
    accountId: "acc",
    calendarId: "primary",
    id: "lunch",
    masterId: null,
    summary: "Lunch",
    start: { ms: start, date: null, timeZone: null },
    end: { ms: start + 3_600_000, date: null, timeZone: null },
    allDay: false,
    status: "confirmed",
    selfResponse: null,
    location,
    hasConference: false,
    meeting: null,
    colorId: null,
    transparency: null,
    recurring: false,
    canEdit: true,
  };
}

describe("settings", () => {
  test("weather is off until turned on, in the unit the computer's region uses", () => {
    expect(localUnit("en-US")).toBe("fahrenheit");
    expect(localUnit("en-GB")).toBe("celsius");
    expect(localUnit("de")).toBe("celsius");
    expect(localStorage.getItem(WEATHER_KEY)).toBeNull();
  });

  test("a place reads as town, region and country, without repeats", () => {
    expect(placeLabel(SPRINGFIELD)).toBe("Springfield, Illinois, United States");
    expect(placeLabel({ ...SPRINGFIELD, name: "New York", region: "New York" })).toBe(
      "New York, United States",
    );
  });

  test("home is found from a time zone named after a town, in that zone", async () => {
    mockIPC((cmd) =>
      cmd === "weather_search_places"
        ? [
            { ...SPRINGFIELD, name: "New York", timeZone: "America/Chicago" },
            { ...SPRINGFIELD, name: "New York", timeZone: "America/New_York" },
          ]
        : undefined,
    );
    expect((await placeFromZone("America/New_York"))?.timeZone).toBe("America/New_York");
    expect(await placeFromZone("Etc/UTC")).toBeNull();
    expect(await placeFromZone("UTC")).toBeNull();
  });

  test("before Calendar mode has opened, home comes from the calendar's zone, not the computer's", async () => {
    useWeatherSettings.setState({ enabled: false, home: null });
    useCalendarStore.setState({ accounts: null });
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "calendar_accounts")
        return [{ access: { status: "on" }, timeZone: "Europe/London", weekStart: 1 }];
      return createWeatherHandlers(NOW).weather_search_places(args as Record<string, unknown>);
    });
    render(<ShowWeatherControl />);
    fireEvent.click(screen.getByRole("switch", { name: "Show weather" }));
    await flush();
    expect(calls.find((c) => c.cmd === "weather_search_places")?.args.query).toBe("London");
    expect(useWeatherSettings.getState().home?.name).toBe("London");
  });

  test("turning weather on the first time finds home from the calendar's time zone", async () => {
    useWeatherSettings.setState({ enabled: false, home: null });
    useCalendarStore.setState({
      accounts: [{ access: { status: "on" }, timeZone: "America/New_York", weekStart: 0 } as never],
    });
    render(<ShowWeatherControl />);
    fireEvent.click(screen.getByRole("switch", { name: "Show weather" }));
    await flush();
    expect(calls.find((c) => c.cmd === "weather_search_places")?.args.query).toBe("New York");
    expect(useWeatherSettings.getState()).toMatchObject({
      enabled: true,
      home: { name: "New York" },
    });
    expect(JSON.parse(localStorage.getItem(WEATHER_KEY)!)).toMatchObject({ enabled: true });
  });
});

describe("day headers", () => {
  test("show the home forecast's icon, high and low in the chosen unit", async () => {
    render(<DayWeather date={TODAY} />);
    refreshHomeForecast();
    await flush();
    const day = screen.getByRole("img");
    // The preview's first day: clear, 12-ish °C.
    expect(day).toHaveAccessibleName(/^Clear, high \d+°, low \d+°$/);
    expect(calls.filter((c) => c.cmd === "weather_forecast")[0].args).toMatchObject({
      latitude: 39.8,
      longitude: -89.64,
      unit: "fahrenheit",
    });
  });

  test("hold their place while the forecast loads, and show nothing with weather off", async () => {
    held = ["weather_forecast"];
    const { container, rerender } = render(<DayWeather date={TODAY} />);
    refreshHomeForecast();
    expect(container.querySelector(".weather-day .ui-skeleton")).not.toBeNull();
    // A day past the forecast keeps the empty slot, without a placeholder.
    rerender(<DayWeather date="2027-01-20" />);
    expect(container.querySelector(".weather-day")).not.toBeNull();
    expect(container.querySelector(".ui-skeleton")).toBeNull();
    act(() => useWeatherSettings.setState({ enabled: false }));
    expect(container.querySelector(".weather-day")).toBeNull();
  });

  test("an hour-old forecast is read again; a fresh one isn't", async () => {
    refreshHomeForecast();
    await flush();
    refreshHomeForecast();
    expect(calls.filter((c) => c.cmd === "weather_forecast")).toHaveLength(1);
    vi.setSystemTime(NOW + 61 * 60_000);
    refreshHomeForecast();
    expect(calls.filter((c) => c.cmd === "weather_forecast")).toHaveLength(2);
  });
});

describe("event popover", () => {
  test("only locations that could name a town are looked up", () => {
    expect(mayNameAPlace("Tartine, 600 Guerrero St, San Francisco, CA 94110")).toBe(true);
    expect(mayNameAPlace("Paris")).toBe(true);
    expect(mayNameAPlace("4B, 12")).toBe(false);
    expect(mayNameAPlace("https://zoom.us/j/1")).toBe(false);
  });

  test("shows the forecast for the event's town on its day", async () => {
    render(<EventWeather event={event("Tartine, 600 Guerrero St, San Francisco")} tz="UTC" />);
    await flush();
    expect(calls.find((c) => c.cmd === "weather_for_location")?.args).toEqual({
      location: "Tartine, 600 Guerrero St, San Francisco",
      unit: "fahrenheit",
    });
    // Two days ahead in the preview's forecast: cloudy.
    expect(screen.getByText(/Cloudy/)).toBeInTheDocument();
    // 2026-11-13 in San Francisco's time zone.
    expect(screen.getByText("San Francisco · Friday")).toBeInTheDocument();
    // The drawing moves in the popover.
    expect(document.querySelector(".weather-art--live")).not.toBeNull();
  });

  test("the card's pause button stops the drawings, everywhere, and play starts them", async () => {
    render(
      <>
        <EventWeather event={event("San Francisco")} tz="UTC" />
        <DayWeather date={TODAY} />
      </>,
    );
    refreshHomeForecast();
    await flush();
    expect(document.querySelector(".weather-event .weather-art--live")).not.toBeNull();
    expect(document.querySelector(".weather-day .weather-art--hover")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop weather animation" }));
    expect(document.querySelectorAll(".weather-art--still")).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(WEATHER_KEY)!)).toMatchObject({ animate: false });
    fireEvent.click(screen.getByRole("button", { name: "Animate weather" }));
    expect(document.querySelector(".weather-event .weather-art--live")).not.toBeNull();
  });

  test("a day's sky is laid out the same every time it's drawn, and differs between days", () => {
    const sky = (date: string) => {
      const { container, unmount } = render(<WeatherArt kind="rain" seed={date} />);
      const shapes = [...container.querySelectorAll("circle, line")].map((el) =>
        ["cx", "cy", "r", "x1", "y1"].map((a) => el.getAttribute(a)).join(),
      );
      unmount();
      return shapes.join("|");
    };
    expect(sky("2026-11-12")).toBe(sky("2026-11-12"));
    expect(sky("2026-11-12")).not.toBe(sky("2026-11-13"));
  });

  test("heavier rain lets more fall", () => {
    const drops = (intensity: 1 | 2 | 3) => {
      const { container, unmount } = render(
        <WeatherArt kind="rain" intensity={intensity} seed="x" />,
      );
      const n = container.querySelectorAll(".wx-drop").length;
      unmount();
      return n;
    };
    expect(drops(1)).toBeLessThan(drops(2));
    expect(drops(2)).toBeLessThan(drops(3));
  });

  test("says so when the place isn't a town it knows", async () => {
    render(<EventWeather event={event("Joe's Pizza")} tz="UTC" />);
    await flush();
    expect(screen.getByText("No forecast")).toBeInTheDocument();
    expect(screen.getByText("Pheeme can't tell which town this is")).toBeInTheDocument();
  });

  test("nothing for past events, events past the forecast, rooms, or with weather off", () => {
    const cases = [
      event("San Francisco", NOW - 2 * 86_400_000),
      event("San Francisco", NOW + 30 * 86_400_000),
      event("4B"),
    ];
    for (const e of cases) {
      const { container, unmount } = render(<EventWeather event={e} tz="UTC" />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    useWeatherSettings.setState({ enabled: false });
    const { container } = render(<EventWeather event={event("San Francisco")} tz="UTC" />);
    expect(container).toBeEmptyDOMElement();
    expect(calls.filter((c) => c.cmd === "weather_for_location")).toHaveLength(0);
  });
});
