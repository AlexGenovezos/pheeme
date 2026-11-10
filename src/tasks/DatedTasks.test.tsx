import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CalendarScreen } from "../calendar/CalendarScreen";
import { useCalendarStore } from "../calendar/calendarStore";
import { createCalendarHandlers } from "../preview/calendar";
import { createTasksHandlers } from "../preview/tasks";
import { useAccountStore } from "../store/accountStore";
import { TasksPanelHost } from "./TasksPanel";
import { useTasksStore } from "./tasksStore";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

function renderCalendar() {
  const handlers = {
    ...createCalendarHandlers(ACCOUNTS, null, NOW),
    ...createTasksHandlers(ACCOUNTS, null, NOW),
  } as Record<string, (args?: Record<string, unknown>) => unknown>;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
  render(
    <>
      <CalendarScreen />
      <TasksPanelHost />
    </>,
  );
}

const chip = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`^Task: ${title}`) }).closest(".task-chip")!;

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
  useTasksStore.setState({
    panelOpen: false,
    accounts: null,
    lists: {},
    dated: null,
    datedFor: null,
    editing: null,
  });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

describe("dated tasks on the calendar", () => {
  test("the week's all-day band shows its dated tasks; ticking one crosses it out", async () => {
    renderCalendar();
    await settle();

    const band = screen.getByRole("row", { name: "All-day events" });
    // Sunday-start week Nov 8–14: the fixture's tasks are due Mon 9 (done), Tue 10, Wed 11,
    // Thu 12 and Fri 13.
    expect(
      within(band)
        .getAllByRole("button", { name: /^Task: / })
        .map((b) => b.textContent),
    ).toEqual([
      "Pay the electricity bill",
      "Pick up dry cleaning",
      "Send the lease back",
      "Review the Q4 roadmap",
      "Plan the Lisbon trip",
    ]);
    expect(chip("Pay the electricity bill")).toHaveClass("task-chip--done");
    expect(chip("Send the lease back")).not.toHaveClass("task-chip--done");

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark done: Send the lease back" }));
    expect(chip("Send the lease back")).toHaveClass("task-chip--done");
    await settle();
    expect(calls.find((c) => c.cmd === "set_task_completed")?.args).toMatchObject({
      accountId: "acc-personal",
      listId: "my-tasks",
      completed: true,
    });
    expect(chip("Send the lease back")).toHaveClass("task-chip--done");
  });

  test("the sidebar lists each account's task lists; unticking one takes its tasks off the grid", async () => {
    renderCalendar();
    await settle();

    const personal = screen.getByRole("list", { name: "Task lists of avery@example.com" });
    expect(
      within(personal)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Tasks: My Tasks", "Tasks: Errands"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tasks: Errands" }));
    await settle();
    expect(calls.find((c) => c.cmd === "set_task_list_hidden")?.args).toMatchObject({
      listId: "errands",
      hidden: true,
    });
    expect(screen.queryByRole("button", { name: /^Task: Pick up dry cleaning/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Tasks: Errands" })).not.toBeChecked();
  });

  test("month cells show dated tasks too, and a task's title opens it in the Tasks panel", async () => {
    useCalendarStore.setState({ view: "month" });
    renderCalendar();
    await settle();

    expect(screen.getByRole("button", { name: /^Task: Plan the Lisbon trip/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Task: Plan the Lisbon trip/ }));
    await settle();
    const panel = screen.getByRole("complementary", { name: "Tasks" });
    const editor = within(panel).getByRole("form", { name: "Edit task: Plan the Lisbon trip" });
    expect(within(editor).getByRole("textbox", { name: "Title" })).toHaveFocus();
  });
});
