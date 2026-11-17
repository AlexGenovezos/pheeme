import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { byName } from "../preview/handlers";
import { createTasksHandlers } from "../preview/tasks";
import { useAccountStore } from "../store/accountStore";
import { PLANNED_KEY } from "./plan";
import { usePlanStore } from "./planStore";
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
let fail: Set<string>;
/** Answers that replace the fixtures', by command. */
let answers: Map<string, unknown>;

function backend() {
  const handlers = byName(createTasksHandlers(ACCOUNTS, null, NOW));
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (fail.has(cmd)) throw { code: "gmail_api", message: "Google said no." };
      return answers.has(cmd) ? answers.get(cmd) : handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
}

async function start() {
  backend();
  render(<TasksPanelHost />);
  await settle();
}

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const plan = () => screen.getByRole("dialog", { name: "Plan today" });
const press = async (key: string) => {
  fireEvent.keyDown(document.activeElement ?? plan(), { key });
  await settle();
};
const lastToast = () => {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  calls = [];
  fail = new Set();
  answers = new Map();
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useToastStore.setState({ toasts: [] });
  usePlanStore.setState({ open: false, queue: [], index: 0 });
  useTasksStore.setState({
    panelOpen: false,
    accounts: null,
    lists: {},
    dated: null,
    datedFor: null,
    accountsError: null,
    listErrors: {},
    datedError: null,
    due: null,
    dueError: null,
    editing: null,
  });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

describe("Plan today", () => {
  test("opens on its own with the oldest overdue task first, once a day", async () => {
    await start();
    const dialog = plan();
    expect(within(dialog).getByRole("heading", { name: "Send the Acme invoice" })).toBeVisible();
    expect(dialog).toHaveTextContent("1 of 4");
    expect(dialog).toHaveTextContent("Due 12 days ago");
    expect(dialog).toHaveTextContent("Work");
    expect(dialog).toHaveTextContent("avery@example.org");
    expect(dialog).toHaveTextContent("Net 30, PO 4471");
    for (const name of [
      "Today",
      "Tomorrow",
      "Pick a day",
      "Book a time",
      "Done",
      "Drop",
      "Stop for today",
    ])
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    expect(localStorage.getItem(PLANNED_KEY)).toBe("2026-11-11");
  });

  test("doesn't open on its own once planned today", async () => {
    localStorage.setItem(PLANNED_KEY, "2026-11-11");
    await start();
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
  });

  test("doesn't open on its own with nothing due", async () => {
    answers.set("tasks_due_through", []);
    await start();
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
    expect(localStorage.getItem(PLANNED_KEY)).toBeNull();
  });

  test("opens after the first sync when the cache had nothing due yet", async () => {
    answers.set("tasks_due_through", []);
    await start();
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
    answers.delete("tasks_due_through");
    await act(() => emit("tasks:updated", { accountId: "acc-work" }));
    await settle();
    expect(plan()).toBeTruthy();
  });

  test("Today moves the task to today and goes on to the next", async () => {
    await start();
    await press("t");
    expect(sent("update_task")).toEqual([
      expect.objectContaining({ listId: "work", edit: { due: "2026-11-11" } }),
    ]);
    expect(plan()).toHaveTextContent("2 of 4");
    expect(within(plan()).getByRole("heading", { name: "Pick up dry cleaning" })).toBeVisible();
    expect(plan()).toHaveTextContent("Due yesterday");
  });

  test("Done completes it; a task already due today keeps its date with Today", async () => {
    await start();
    await press("d");
    expect(sent("set_task_completed")).toEqual([
      expect.objectContaining({ listId: "work", completed: true }),
    ]);
    await press("m");
    expect(sent("update_task")).toEqual([
      expect.objectContaining({ listId: "errands", edit: { due: "2026-11-12" } }),
    ]);
    expect(plan()).toHaveTextContent("Due today");
    await press("t");
    expect(sent("update_task")).toHaveLength(1);
    expect(plan()).toHaveTextContent("4 of 4");
  });

  test("Drop deletes it, and Undo puts it back with its title, notes and date", async () => {
    await start();
    await press("x");
    expect(sent("delete_task")).toEqual([expect.objectContaining({ listId: "work" })]);
    expect(plan()).toHaveTextContent("2 of 4");
    const dropped = lastToast();
    expect(dropped).toMatchObject({ title: "Task dropped", action: { label: "Undo" } });
    await act(async () => dropped.action!.run());
    await settle();
    expect(sent("create_task")).toEqual([
      expect.objectContaining({
        accountId: "acc-work",
        listId: "work",
        edit: { title: "Send the Acme invoice", notes: "Net 30, PO 4471", due: "2026-10-30" },
      }),
    ]);
  });

  test("a change Google refuses still moves on; the store says why", async () => {
    await start();
    fail.add("update_task");
    await press("m");
    expect(plan()).toHaveTextContent("2 of 4");
    expect(lastToast()).toMatchObject({ title: "Couldn't save the task", tone: "danger" });
  });

  test("Pick a day moves it to the day chosen in the date field", async () => {
    await start();
    await press("p");
    const field = within(plan()).getByRole("combobox", { name: "Move to" });
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "ArrowRight" });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(sent("update_task")).toEqual([expect.objectContaining({ edit: { due: "2026-11-13" } })]);
    expect(plan()).toHaveTextContent("2 of 4");
  });

  test("Book a time sets the day and hands off to Google Calendar", async () => {
    await start();
    await press("b");
    const field = within(plan()).getByRole("combobox", { name: "Book on" });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(sent("update_task")).toEqual([
      expect.objectContaining({ listId: "work", edit: { due: "2026-11-11" } }),
    ]);
    expect(sent("open_external")).toEqual([
      {
        url: "https://calendar.google.com/calendar/u/0/r/day/2026/11/11?authuser=avery%40example.org",
      },
    ]);
    expect(
      useToastStore.getState().toasts.find((t) => t.title === "Book it in Google Calendar"),
    ).toMatchObject({
      description:
        "Drag “Send the Acme invoice” from Tasks onto an hour. Pheeme shows it here once it's booked.",
    });
    expect(plan()).toHaveTextContent("2 of 4");
  });

  test("Escape stops for today and leaves the rest as they are", async () => {
    await start();
    await press("t");
    await press("Escape");
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
    expect(sent("update_task")).toHaveLength(1);
    expect(useTasksStore.getState().due?.map((t) => t.title)).toEqual([
      "Pick up dry cleaning",
      "Send the lease back",
      "Send the Acme invoice",
      "Draft the newsletter",
    ]);
  });

  test("the end screen shows what is due today, and Enter closes it", async () => {
    await start();
    for (const key of ["t", "d", "t", "m"]) await press(key);
    const dialog = plan();
    expect(within(dialog).getByRole("heading", { name: "Planned" })).toBeVisible();
    const today = within(dialog).getByRole("list", { name: "Due today" });
    expect(
      within(today)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Send the lease back", "Send the Acme invoice"]);
    await press("Enter");
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
  });

  test("opens again when the window comes back on a new day", async () => {
    localStorage.setItem(PLANNED_KEY, "2026-11-11");
    await start();
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();
    // Focus on the same day: nothing new.
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(screen.queryByRole("dialog", { name: "Plan today" })).toBeNull();

    vi.setSystemTime(new Date(2026, 10, 12, 9).getTime());
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(plan()).toHaveTextContent("1 of 5");
    expect(localStorage.getItem(PLANNED_KEY)).toBe("2026-11-12");
  });

  test("Plan today in the panel opens it any time", async () => {
    localStorage.setItem(PLANNED_KEY, "2026-11-11");
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Plan today" }));
    await settle();
    expect(plan()).toHaveTextContent("1 of 4");
  });
});
