import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalendarHandlers } from "../preview/calendar";
import { useAccountStore } from "../store/accountStore";
import { CalendarScreen } from "./CalendarScreen";
import { useCalendarStore } from "./calendarStore";
import { byName } from "../preview/handlers";

const ACCOUNTS = [{ id: "acc-personal", email: "avery@example.com" }];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const dateButton = (day: string) =>
  document.querySelector<HTMLElement>(`[data-date="${day}"] .cal-month__date`)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  const handlers = byName(createCalendarHandlers(ACCOUNTS, null, NOW));
  mockIPC((cmd, args) => handlers[cmd]?.((args ?? {}) as Record<string, unknown>), {
    shouldMockEvents: true,
  });
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useCalendarStore.setState({
    mode: "calendar",
    view: "month",
    anchor: "2026-11-11",
    accounts: null,
    events: null,
    eventsFor: null,
    loadError: null,
    open: null,
    goToOpen: false,
  });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

async function open() {
  render(<CalendarScreen />);
  await flush();
  await flush();
}

describe("MonthGrid keyboard navigation", () => {
  test("only one date button is tabbable, today until focus moves", async () => {
    await open();
    const tabbable = [...document.querySelectorAll(".cal-month__date")].filter(
      (b) => (b as HTMLElement).tabIndex === 0,
    );
    expect(tabbable).toEqual([dateButton("2026-11-11")]);
  });

  test("ArrowRight focuses the next day and ArrowDown the next week", async () => {
    await open();
    dateButton("2026-11-11").focus();
    fireEvent.keyDown(dateButton("2026-11-11"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(dateButton("2026-11-12"));
    expect(dateButton("2026-11-12").tabIndex).toBe(0);
    expect(dateButton("2026-11-11").tabIndex).toBe(-1);
    fireEvent.keyDown(dateButton("2026-11-12"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(dateButton("2026-11-19"));
  });

  test("ArrowRight on the last shown day steps the month and focuses the day", async () => {
    await open();
    const cells = [...document.querySelectorAll<HTMLElement>("[data-cal-drop='day']")];
    const last = cells[cells.length - 1].dataset.date!;
    dateButton(last).focus();
    fireEvent.keyDown(dateButton(last), { key: "ArrowRight" });
    await flush();
    await flush();
    const next = new Date(Date.UTC(+last.slice(0, 4), +last.slice(5, 7) - 1, +last.slice(8) + 1))
      .toISOString()
      .slice(0, 10);
    expect(useCalendarStore.getState().anchor).toBe(next);
    expect(document.activeElement).toBe(dateButton(next));
    expect(screen.getByRole("grid")).toBeTruthy();
  });
});

describe("Mini month keyboard navigation", () => {
  const mini = (day: string) =>
    document.querySelector<HTMLElement>(`.mini-month [data-date="${day}"] .mini-month__day`)!;
  const tabbable = () =>
    [...document.querySelectorAll<HTMLElement>(".mini-month__day")].filter((b) => b.tabIndex === 0);

  test("the day the calendar is on is the one tab stop; arrows move by day and week", async () => {
    await open();
    expect(tabbable()).toEqual([mini("2026-11-11")]);
    mini("2026-11-11").focus();
    fireEvent.keyDown(mini("2026-11-11"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(mini("2026-11-10"));
    expect(tabbable()).toEqual([mini("2026-11-10")]);
    fireEvent.keyDown(mini("2026-11-10"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(mini("2026-11-03"));
    // Moving focus doesn't move the calendar; Enter (a click) does.
    expect(useCalendarStore.getState().anchor).toBe("2026-11-11");
    fireEvent.click(mini("2026-11-03"));
    await flush();
    expect(useCalendarStore.getState().anchor).toBe("2026-11-03");
  });

  test("Page Down shows the next month in the mini month and focuses the same day there", async () => {
    await open();
    mini("2026-11-11").focus();
    fireEvent.keyDown(mini("2026-11-11"), { key: "PageDown" });
    await flush();
    expect(screen.getByRole("table", { name: "December 2026" })).toBeInTheDocument();
    expect(document.activeElement).toBe(mini("2026-12-11"));
    expect(useCalendarStore.getState().anchor).toBe("2026-11-11");
  });
});
