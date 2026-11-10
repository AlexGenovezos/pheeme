import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appCommands, commandsForMode } from "../keyboard/appCommands";
import { registry } from "../keyboard/registry";
import { filterCommands } from "../palette/match";
import { useAccountStore } from "../store/accountStore";
import { createCalendarHandlers } from "../preview/calendar";
import type { CalendarAccess } from "../lib/tauri";
import { CalendarScreen } from "./CalendarScreen";
import { CALENDAR_PREFS_KEY, readPrefs, useCalendarStore } from "./calendarStore";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

function backend(access: string | null, statuses?: CalendarAccess["status"][]) {
  const handlers = createCalendarHandlers(ACCOUNTS, access, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (cmd === "calendar_accounts" && statuses) {
        const accounts = handlers.calendar_accounts() as { access: CalendarAccess }[];
        return accounts.map((acc, i) => ({
          ...acc,
          access: { ...acc.access, status: statuses[i] },
        }));
      }
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  calls = [];
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useCalendarStore.setState({
    mode: "calendar",
    view: "week",
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

describe("CalendarScreen", () => {
  test("the week shows every account's events, and unticking a calendar hides its events", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();
    await flush();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nov 8 – 14, 2026");
    expect(screen.getByRole("button", { name: /^Team planning,/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Design review, .*not answered/ })).toHaveClass(
      "cal-event--invite",
    );
    expect(screen.getByRole("button", { name: /^Vendor demo, .*declined/ })).toHaveClass(
      "cal-event--declined",
    );
    expect(screen.getByRole("button", { name: /^Design Summit, all day/ })).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "set_calendar_foreground" && c.args.on === true)).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Team" }));
    await flush();
    await flush();
    expect(calls.find((c) => c.cmd === "set_calendar_hidden")?.args).toMatchObject({
      calendarId: "team",
      hidden: true,
    });
    expect(screen.queryByRole("button", { name: /^Team planning,/ })).toBeNull();
  });

  test("the popover shows guests and answers an invite", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /^Design review,/ }));
    await flush();
    const pop = screen.getByRole("dialog", { name: "Design review" });
    expect(pop).toHaveTextContent("Organized by morgan@example.org");
    expect(within(pop).getByRole("button", { name: "Join with Google Meet" })).toBeInTheDocument();

    fireEvent.click(within(pop).getByRole("radio", { name: "Yes" }));
    await flush();
    await flush();
    expect(calls.find((c) => c.cmd === "respond_to_calendar_event")?.args).toMatchObject({
      eventId: "design-review",
      scope: "this",
      response: "accepted",
    });
    expect(within(pop).getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(pop, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Design review" })).toBeNull();
  });

  test("Edit and Delete event are in the palette only while an event is open", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();
    await flush();
    const palette = () => filterCommands(registry.list(), "").map((r) => r.command.id);

    expect(palette()).toContain("calendar.create");
    expect(palette()).not.toContain("calendar.edit");
    expect(palette()).not.toContain("calendar.delete");
    // Still registered, so the shortcuts and Settings › Keyboard keep them.
    expect(registry.list().map((c) => c.id)).toEqual(
      expect.arrayContaining(["calendar.edit", "calendar.delete"]),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Team planning,/ }));
    await flush();
    expect(palette()).toEqual(expect.arrayContaining(["calendar.edit", "calendar.delete"]));

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Team planning" }), { key: "Escape" });
    await flush();
    expect(palette()).not.toContain("calendar.edit");
  });

  test("view keys switch views and move by period, and the view is remembered", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();

    act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: "m" })));
    await flush();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("November 2026");
    expect(readPrefs().view).toBe("month");

    act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: "j" })));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("December 2026");
    act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: "t" })));
    act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: "d" })));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Wednesday, November 11, 2026",
    );
    expect(JSON.parse(localStorage.getItem(CALENDAR_PREFS_KEY)!)).toEqual({
      mode: "calendar",
      view: "day",
    });
  });

  test("Week to Month draws the whole month's events in its first frame", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();
    await flush();
    // This week's standup was moved; the month's other Mondays keep theirs.
    expect(screen.queryAllByRole("button", { name: /^Standup,/ })).toHaveLength(0);

    act(() => useCalendarStore.getState().setView("month"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("November 2026");
    // No read in between: the months around the week were already in memory.
    expect(screen.getAllByRole("button", { name: /^Standup,/ })).toHaveLength(4);
  });

  test("a day outside the months in memory shows once its events are read, not before", async () => {
    backend(null);
    render(<CalendarScreen />);
    await flush();
    await flush();

    act(() => void useCalendarStore.getState().goTo("2027-06-10"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nov 8 – 14, 2026");
    await flush();
    await flush();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Jun 6 – 12, 2027");
  });

  test("with no account allowed yet, the first-open screen asks for access", async () => {
    backend(null, ["unknown", "api_disabled"]);
    render(<CalendarScreen />);
    await flush();
    await flush();

    expect(screen.getByRole("heading", { name: "Your Google Calendar, in Pheeme" })).toBeVisible();
    expect(screen.queryByRole("grid")).toBeNull();
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("button", { name: "Allow calendar access" })).toHaveLength(1);
    expect(within(main).getByText("The Calendar API is still off.")).toBeInTheDocument();
  });
});

describe("commandsForMode", () => {
  test("Calendar drops conversation commands and the keys of mailbox ones", () => {
    const calendar = commandsForMode(appCommands(), "calendar");
    expect(calendar.some((c) => c.id.startsWith("conversation."))).toBe(false);
    expect(calendar.some((c) => c.id.startsWith("go."))).toBe(false);
    expect(calendar.find((c) => c.id === "compose.new")?.shortcut).toBeUndefined();
    expect(calendar.find((c) => c.id === "mode.mail")?.shortcut).toBe("mod+1");

    const mail = commandsForMode(appCommands(), "mail");
    expect(mail.find((c) => c.id === "go.inbox")?.shortcut).toBe("g i");
    expect(mail.find((c) => c.id === "mode.calendar")?.shortcut).toBe("mod+2");
  });
});
