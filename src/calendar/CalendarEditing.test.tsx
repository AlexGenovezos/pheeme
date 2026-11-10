import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { registry } from "../keyboard/registry";
import { createCalendarHandlers } from "../preview/calendar";
import { useAccountStore } from "../store/accountStore";
import { CalendarScreen } from "./CalendarScreen";
import { useCalendarStore } from "./calendarStore";
import { systemZone, zonedMs } from "./dates";
import { useEditStore } from "./editStore";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();
const tz = systemZone();

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const key = (k: string) =>
  act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: k })));

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

function backend(fail?: Record<string, unknown>) {
  const handlers = createCalendarHandlers(ACCOUNTS, null, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (fail?.[cmd]) throw fail[cmd];
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
}

async function open() {
  render(<CalendarScreen />);
  await settle();
}

/** The open dialog with this name (the event popover, quick create, editor or a prompt). */
const dialog = (name: string | RegExp) => screen.getByRole("dialog", { name });

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
  useEditStore.setState({
    draft: null,
    editor: null,
    prompt: null,
    moving: null,
    removed: [],
    search: null,
  });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  Reflect.deleteProperty(document, "elementsFromPoint");
  clearMocks();
  vi.useRealTimers();
});

describe("creating events", () => {
  test("a click on the grid places an hour; the quick-create popover saves it", async () => {
    backend();
    await open();

    const monday = screen.getByRole("gridcell", { name: "Monday, November 9" });
    // jsdom has no layout, so the press lands at the top of the day.
    fireEvent.pointerDown(monday, { button: 0, clientX: 10, clientY: 0 });
    fireEvent.pointerUp(window);
    await flush();

    const quick = dialog("New event");
    expect(screen.getByRole("button", { name: /^\(No title\), 12:00 AM – 1:00 AM/ })).toHaveClass(
      "cal-event--draft",
    );
    fireEvent.change(within(quick).getByRole("textbox", { name: "Title" }), {
      target: { value: "Dentist" },
    });
    fireEvent.submit(quick);
    await settle();

    expect(sent("create_calendar_event")).toEqual([
      {
        accountId: "acc-personal",
        calendarId: "avery@example.com",
        sendUpdates: "none",
        edit: expect.objectContaining({
          summary: "Dentist",
          start: { ms: zonedMs("2026-11-09", 0, tz), timeZone: tz },
          end: { ms: zonedMs("2026-11-09", 60, tz), timeZone: tz },
        }),
      },
    ]);
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Dentist, 12:00 AM – 1:00 AM/ }),
    ).toBeInTheDocument();
  });

  test("`c` opens quick create; More options keeps the title, and guests get asked about", async () => {
    backend();
    await open();

    key("c");
    await flush();
    const quick = dialog("New event");
    fireEvent.change(within(quick).getByRole("textbox", { name: "Title" }), {
      target: { value: "Offsite" },
    });
    fireEvent.click(within(quick).getByRole("button", { name: "More options" }));
    await flush();

    const editor = dialog("New event");
    expect(within(editor).getByRole("textbox", { name: "Title" })).toHaveValue("Offsite");
    const guests = within(editor).getByRole("combobox", { name: "Guests" });
    fireEvent.change(guests, { target: { value: "dana@example.com" } });
    fireEvent.keyDown(guests, { key: "Enter" });
    fireEvent.submit(editor.querySelector("form")!);
    await flush();

    fireEvent.click(
      within(dialog("Send invitation emails to guests?")).getByRole("button", { name: "Send" }),
    );
    await settle();
    expect(sent("create_calendar_event")[0]).toMatchObject({
      sendUpdates: "all",
      edit: { summary: "Offsite", attendees: [{ email: "dana@example.com", optional: false }] },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("changing events", () => {
  test("`e` edits the open event; a save sends only what changed and asks about guests", async () => {
    backend();
    await open();

    fireEvent.click(screen.getByRole("button", { name: /^Team planning,/ }));
    await flush();
    key("e");
    await settle();

    const editor = dialog("Edit event");
    fireEvent.change(within(editor).getByRole("textbox", { name: "Title" }), {
      target: { value: "Team planning (Q1)" },
    });
    fireEvent.submit(editor.querySelector("form")!);
    await flush();
    fireEvent.click(
      within(dialog("Send update emails to guests?")).getByRole("button", { name: "Don't send" }),
    );
    await settle();

    expect(sent("update_calendar_event")).toEqual([
      {
        accountId: "acc-personal",
        calendarId: "team",
        eventId: "planning",
        scope: "this",
        edit: { summary: "Team planning (Q1)" },
        sendUpdates: "none",
      },
    ]);
    expect(screen.getByRole("button", { name: /^Team planning \(Q1\),/ })).toBeInTheDocument();
  });

  test("dragging an event to another day moves it there", async () => {
    backend();
    await open();

    const friday = screen.getByRole("gridcell", { name: "Friday, November 13" });
    const thursday = screen.getByRole("gridcell", { name: "Thursday, November 12" });
    let over = thursday;
    document.elementsFromPoint = () => [over];
    const lunch = screen.getByRole("button", { name: /^Lunch with Dana,/ });
    fireEvent.pointerDown(lunch, { button: 0, clientX: 10, clientY: 0 });
    over = friday;
    fireEvent.pointerMove(window, { clientX: 200, clientY: 0 });
    fireEvent.pointerUp(window);
    fireEvent.click(lunch);
    await settle();

    // The click that ends a drag doesn't open the event.
    expect(screen.queryByRole("dialog", { name: "Lunch with Dana" })).toBeNull();
    expect(sent("update_calendar_event")[0]).toMatchObject({
      eventId: "lunch",
      scope: "this",
      edit: {
        start: { ms: zonedMs("2026-11-13", 12 * 60, tz) },
        end: { ms: zonedMs("2026-11-13", 13 * 60, tz) },
      },
    });
    expect(within(friday).getByRole("button", { name: /^Lunch with Dana,/ })).toBeInTheDocument();
  });

  test("a change made elsewhere first says so and reads the calendar again", async () => {
    backend({ update_calendar_event: { code: "conflict", message: "412" } });
    await open();

    const friday = screen.getByRole("gridcell", { name: "Friday, November 13" });
    let over = screen.getByRole("gridcell", { name: "Thursday, November 12" });
    document.elementsFromPoint = () => [over];
    fireEvent.pointerDown(screen.getByRole("button", { name: /^Lunch with Dana,/ }), {
      button: 0,
    });
    over = friday;
    fireEvent.pointerMove(window, { clientX: 200, clientY: 0 });
    fireEvent.pointerUp(window);
    await settle();

    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      "This event was changed somewhere else",
    ]);
    expect(sent("calendar_sync_now")).toEqual([{ accountId: "acc-personal" }]);
    // Snapped back.
    expect(within(friday).queryByRole("button", { name: /^Lunch with Dana,/ })).toBeNull();
  });

  test("deleting a repeating event asks which events", async () => {
    backend();
    await open();

    fireEvent.click(screen.getByRole("button", { name: /^Standup \(moved\),/ }));
    await flush();
    fireEvent.click(
      within(dialog("Standup (moved)")).getByRole("button", { name: "Delete event" }),
    );
    await flush();
    const prompt = dialog("Delete repeating event");
    fireEvent.click(within(prompt).getByRole("radio", { name: "This and following events" }));
    fireEvent.click(within(prompt).getByRole("button", { name: "OK" }));
    await settle();

    expect(sent("delete_calendar_event")).toEqual([
      {
        accountId: "acc-personal",
        calendarId: "avery@example.com",
        eventId: "standup_20261109",
        scope: "following",
        sendUpdates: "none",
      },
    ]);
    expect(screen.queryByRole("button", { name: /^Standup/ })).toBeNull();
  });

  test("events on read-only calendars and others' invites can't be changed", async () => {
    backend();
    await open();

    const holiday = screen.getByRole("button", { name: /^Veterans Day,/ });
    expect(holiday).not.toHaveClass("cal-event--editable");
    fireEvent.click(holiday);
    await flush();
    const pop = dialog("Veterans Day");
    expect(within(pop).queryByRole("button", { name: "Edit event" })).toBeNull();
    expect(within(pop).queryByRole("button", { name: "Delete event" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Design review,/ }));
    await flush();
    const invite = dialog("Design review");
    expect(within(invite).queryByRole("button", { name: "Edit event" })).toBeNull();
    // A guest can still take it off their own calendar.
    expect(within(invite).getByRole("button", { name: "Delete event" })).toBeInTheDocument();
  });

  test("copy to another account's calendar", async () => {
    backend();
    await open();

    fireEvent.click(screen.getByRole("button", { name: /^Lunch with Dana,/ }));
    await flush();
    fireEvent.click(within(dialog("Lunch with Dana")).getByRole("button", { name: "Options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to avery@example.org" }));
    await settle();

    expect(sent("copy_calendar_event")).toEqual([
      {
        accountId: "acc-personal",
        calendarId: "avery@example.com",
        eventId: "lunch",
        toAccountId: "acc-work",
        toCalendarId: "avery@example.org",
      },
    ]);
    expect(screen.getAllByRole("button", { name: /^Lunch with Dana,/ })).toHaveLength(2);
  });
});

describe("search", () => {
  test("`/` searches cached events; picking one opens it on its day", async () => {
    backend();
    await open();

    key("/");
    await flush();
    const input = screen.getByRole("combobox", { name: "Search events" });
    fireEvent.change(input, { target: { value: "lunch tartine" } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await flush();

    const results = screen.getByRole("listbox", { name: "Matching events" });
    expect(within(results).getAllByRole("option")).toHaveLength(1);
    expect(sent("search_calendar_events")[0]).toMatchObject({
      query: "lunch tartine",
      timeZone: tz,
    });

    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(screen.queryByRole("search")).toBeNull();
    expect(dialog("Lunch with Dana")).toBeInTheDocument();
  });
});
