import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { zonedMs } from "../calendar/dates";
import type { HourForecast } from "../lib/tauri";
import { describeRuns, hourRuns, runKind } from "./hourly";
import { HourWeather } from "./HourWeather";
import { PLAY_MS, useWeatherMotion } from "./motion";
import { useWeatherSettings } from "./weatherSettings";

const NY = "America/New_York";

/** Hours of `date` in `tz` from `from` (inclusive) to `to` (exclusive), all `code`. */
function hours(
  date: string,
  from: number,
  to: number,
  code: number,
  tz = NY,
  extra: Partial<HourForecast> = {},
): HourForecast[] {
  return Array.from({ length: to - from }, (_, i) => ({
    at: zonedMs(date, (from + i) * 60, tz),
    code,
    precipitation: 0,
    isDay: true,
    ...extra,
  }));
}

describe("hour runs", () => {
  test("consecutive hours of one kind are one run; cloudy hours and clear nights draw nothing", () => {
    const runs = hourRuns(
      [
        ...hours("2026-11-17", 6, 9, 0, NY, { isDay: false }),
        ...hours("2026-11-17", 9, 13, 0),
        ...hours("2026-11-17", 13, 14, 3),
        ...hours("2026-11-17", 14, 15, 61),
        ...hours("2026-11-17", 15, 17, 63),
      ],
      NY,
      "2026-11-17",
    );
    expect(runs["2026-11-17"]).toEqual([
      { kind: "sun", start: 9 * 60, end: 13 * 60, intensity: 2 },
      { kind: "rain", start: 14 * 60, end: 17 * 60, intensity: 2 },
    ]);
  });

  test("a single shower hour is kept, heavier when more falls than its code says", () => {
    const runs = hourRuns(
      hours("2026-11-17", 15, 16, 80, NY, { precipitation: 5 }),
      NY,
      "2026-11-17",
    );
    expect(runs["2026-11-17"]).toEqual([
      { kind: "rain", start: 15 * 60, end: 16 * 60, intensity: 3 },
    ]);
  });

  test("hours are placed in the calendar's zone, split at its midnight, and past days left out", () => {
    // 21:00–23:00 in New York is 02:00–04:00 the next day in London, and an hour starting at
    // 23:30 in Kolkata runs into the next day there.
    const london = hourRuns(hours("2026-11-17", 21, 23, 73), "Europe/London", "2026-11-17");
    expect(london).toEqual({
      "2026-11-18": [{ kind: "snow", start: 2 * 60, end: 4 * 60, intensity: 2 }],
    });
    const late = [
      {
        at: zonedMs("2026-11-17", 23 * 60 + 30, "Asia/Kolkata"),
        code: 95,
        precipitation: 0,
        isDay: false,
      },
    ];
    expect(hourRuns(late, "Asia/Kolkata", "2026-11-17")).toEqual({
      "2026-11-17": [{ kind: "storm", start: 23 * 60 + 30, end: 24 * 60, intensity: 2 }],
      "2026-11-18": [{ kind: "storm", start: 0, end: 30, intensity: 2 }],
    });
    expect(hourRuns(late, "Asia/Kolkata", "2026-11-18")).toEqual({
      "2026-11-18": [{ kind: "storm", start: 0, end: 30, intensity: 2 }],
    });
  });

  test("kinds and words", () => {
    expect([0, 2, 3, 45, 51, 71, 95].map((c) => runKind(c, true))).toEqual([
      "sun",
      null,
      null,
      "fog",
      "rain",
      "snow",
      "storm",
    ]);
    expect(
      describeRuns([
        { kind: "sun", start: 540, end: 780, intensity: 2 },
        { kind: "rain", start: 840, end: 1020, intensity: 1 },
      ]),
    ).toMatch(/^Sun 9.*AM–1.*PM, rain 2.*PM–5.*PM$/);
  });
});

describe("bands", () => {
  test("each run is a band in its hours, each drawn on its pane, and nothing for a day without runs", () => {
    const { container, rerender } = render(
      <HourWeather
        date="2026-11-17"
        playing={false}
        runs={[
          { kind: "sun", start: 540, end: 780, intensity: 2 },
          { kind: "rain", start: 840, end: 1020, intensity: 3 },
        ]}
      />,
    );
    const bands = container.querySelectorAll<HTMLElement>(".wx-hours");
    expect(bands).toHaveLength(2);
    expect(bands[1].style.top).toBe("calc(var(--cal-hour-h) * 14)");
    expect(bands[1].style.height).toBe("calc(var(--cal-hour-h) * 3)");
    for (const band of bands) expect(band.querySelector("canvas.wx-hours__pane")).not.toBeNull();
    expect(container.querySelector(".wx-hours--playing")).toBeNull();
    rerender(<HourWeather date="2026-11-17" playing={false} runs={undefined} />);
    expect(container.querySelector(".wx-hours")).toBeNull();
  });
});

describe("motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useWeatherSettings.setState({ animate: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const week = ["2026-11-16", "2026-11-17", "2026-11-18"];

  test("a new set of days plays once, then everything holds still with no timer left", () => {
    const { result, rerender } = renderHook(({ days }) => useWeatherMotion(days), {
      initialProps: { days: week },
    });
    expect([...result.current.playing]).toEqual(week);
    act(() => vi.advanceTimersByTime(PLAY_MS));
    expect(result.current.playing.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The same days again (a re-render) don't play; the next week does.
    rerender({ days: [...week] });
    expect(result.current.playing.size).toBe(0);
    rerender({ days: ["2026-11-23"] });
    expect([...result.current.playing]).toEqual(["2026-11-23"]);
  });

  test("moving into a day plays it for a while, even if the pointer stays", () => {
    const { result } = renderHook(() => useWeatherMotion(week));
    act(() => vi.advanceTimersByTime(PLAY_MS));
    act(() => result.current.enter("2026-11-17"));
    expect([...result.current.playing]).toEqual(["2026-11-17"]);
    act(() => vi.advanceTimersByTime(PLAY_MS));
    expect(result.current.playing.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("leaving the window stops it at once; nothing plays in the background or with animation off", () => {
    const { result } = renderHook(() => useWeatherMotion(week));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.playing.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => result.current.enter("2026-11-17"));
    expect(result.current.playing.size).toBe(0);

    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => useWeatherSettings.setState({ animate: false }));
    act(() => result.current.enter("2026-11-17"));
    expect(result.current.playing.size).toBe(0);
  });
});
