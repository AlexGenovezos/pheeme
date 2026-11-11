import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalendarHandlers } from "../preview/calendar";
import { useAccountStore } from "../store/accountStore";
import { useCalendarStore } from "./calendarStore";
import { SidebarAgenda } from "./SidebarAgenda";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, 11:30 local time: Team planning (11-12) is on, nothing else timed today.
const NOW = new Date(2026, 10, 11, 11, 30).getTime();

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useCalendarStore.setState({ mode: "calendar", view: "week", anchor: "2026-11-01", open: null });
  const handlers = createCalendarHandlers(ACCOUNTS, null, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC((cmd, args) => handlers[cmd]?.((args ?? {}) as Record<string, unknown>), {
    shouldMockEvents: true,
  });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

async function renderAgenda() {
  await act(() => useCalendarStore.getState().loadAccounts());
  render(<SidebarAgenda />);
  await flush();
  await flush();
}

describe("SidebarAgenda", () => {
  test("shows a skeleton row per day until the events are read", () => {
    useCalendarStore.setState({ accounts: [] });
    const { container } = render(<SidebarAgenda />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "TodayNov 11",
      "TomorrowNov 12",
      "FridayNov 13",
    ]);
    expect(container.querySelectorAll(".cal-agenda__row[aria-hidden]")).toHaveLength(3);
    expect(screen.queryByText("Nothing planned")).not.toBeInTheDocument();
  });

  test("lists what's left of today and the next two days, all-day first, in time order", async () => {
    await renderAgenda();
    const [today, tomorrow, friday] = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.parentElement as HTMLElement);

    // Today: the all-day event, then the meeting that hasn't ended yet.
    const todayItems = within(today)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(todayItems[0]).toBe("Design Summit");
    expect(todayItems.some((t) => t?.includes("Team planning"))).toBe(true);

    // Tomorrow's timed events in start order.
    const times = within(tomorrow)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("cal-agenda__row"))
      .map((b) => b.querySelector(".cal-agenda__title")?.textContent);
    expect(times.indexOf("Lunch with Dana")).toBeLessThan(times.indexOf("1:1 Alex"));

    expect(within(friday).getByRole("heading")).toHaveTextContent("Friday");
  });

  test("marks today's next event as up next", async () => {
    vi.setSystemTime(new Date(2026, 10, 11, 9).getTime());
    await renderAgenda();
    const today = screen.getAllByRole("heading", { level: 2 })[0].parentElement as HTMLElement;
    const next = within(today).getByText("Up next").closest("button") as HTMLElement;
    expect(next).toHaveTextContent("Team planning");
  });

  test("clicking an event goes to its day and opens it", async () => {
    await renderAgenda();
    const tomorrow = screen.getAllByRole("heading", { level: 2 })[1].parentElement as HTMLElement;
    const lunch = within(tomorrow).getByText("Lunch with Dana").closest("button") as HTMLElement;
    fireEvent.click(lunch);
    const state = useCalendarStore.getState();
    expect(state.anchor).toBe("2026-11-12");
    expect(state.open?.event.summary).toBe("Lunch with Dana");
  });
});
