import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalendarHandlers } from "../preview/calendar";
import { useAccountStore } from "../store/accountStore";
import { CalendarScreen } from "./CalendarScreen";
import { useCalendarStore } from "./calendarStore";

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
  const handlers = createCalendarHandlers(ACCOUNTS, null, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
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
