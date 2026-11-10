import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { createTasksHandlers } from "../preview/tasks";
import { useAccountStore } from "../store/accountStore";
import { ContextMenuHost } from "../shell/ContextMenuHost";
import { TasksPanelHost } from "./TasksPanel";
import { readPanelOpen, TASKS_PREFS_KEY, useTasksStore } from "./tasksStore";

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

function backend(access: string | null = null) {
  const handlers = createTasksHandlers(ACCOUNTS, access, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (fail.has(cmd)) throw { code: "gmail_api", message: "Google said no." };
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
}

const last = <T,>(items: T[]) => items[items.length - 1];
const writes = () =>
  calls.filter((c) => !["tasks_accounts", "tasks_in_list", "dated_tasks"].includes(c.cmd));
const list = (name: string) => screen.getByRole("region", { name });
const rows = (name: string) =>
  within(screen.getByRole("list", { name: `${name} tasks` }))
    .queryAllByRole("button", { name: /^Edit task: / })
    .map((b) => b.getAttribute("aria-label")!.replace("Edit task: ", ""));

async function openPanel(access: string | null = null) {
  backend(access);
  render(
    <>
      <TasksPanelHost />
      <ContextMenuHost />
    </>,
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show tasks" }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  calls = [];
  fail = new Set();
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useToastStore.setState({ toasts: [] });
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

describe("Tasks panel", () => {
  test("opens from the rail, lists every account's lists, and remembers being open", async () => {
    await openPanel();
    expect(screen.getByRole("complementary", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide tasks", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Errands" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    // Subtasks sit under their parent; completed ones fold away.
    expect(rows("My Tasks")).toEqual([
      "Send the lease back",
      "Plan the Lisbon trip",
      "Book flights",
      "Renew passport",
    ]);
    expect(within(list("My Tasks")).getByRole("button", { name: "Completed (2)" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(readPanelOpen()).toBe(true);
    expect(JSON.parse(localStorage.getItem(TASKS_PREFS_KEY)!)).toEqual({ open: true });
    // Opening asks Google for the latest.
    expect(calls.filter((c) => c.cmd === "tasks_sync_now")).toHaveLength(2);
  });

  test("ticking a task off moves it under Completed, and back", async () => {
    await openPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark done: Renew passport" }));
    await settle();
    expect(last(writes())).toMatchObject({
      cmd: "set_task_completed",
      args: { listId: "my-tasks", completed: true },
    });
    expect(rows("My Tasks")).not.toContain("Renew passport");
    const toggle = within(list("My Tasks")).getByRole("button", { name: "Completed (3)" });
    fireEvent.click(toggle);
    const done = screen.getByRole("list", { name: "My Tasks completed tasks" });
    fireEvent.click(within(done).getByRole("checkbox", { name: "Mark not done: Renew passport" }));
    await settle();
    expect(rows("My Tasks")).toContain("Renew passport");
  });

  test("adds tasks one after another with Enter, and edits a task's details and date", async () => {
    await openPanel();
    fireEvent.click(within(list("Errands")).getByRole("button", { name: "Add a task" }));
    const title = () => within(list("Errands")).getByRole("textbox", { name: "Title" });
    fireEvent.change(title(), { target: { value: "Return the library books" } });
    fireEvent.submit(title());
    await settle();
    fireEvent.change(title(), { target: { value: "Buy stamps" } });
    fireEvent.submit(title());
    await settle();
    fireEvent.keyDown(title(), { key: "Escape" });
    await settle();
    expect(rows("Errands")).toEqual([
      "Return the library books",
      "Buy stamps",
      "Pick up dry cleaning",
      "Buy a birthday card",
    ]);
    const creates = writes().filter((c) => c.cmd === "create_task");
    expect(creates).toHaveLength(2);
    // The second goes right after the first.
    expect(creates[0].args.previous).toBeNull();
    expect(creates[1].args.previous).toEqual(expect.stringMatching(/^task-/));

    fireEvent.click(screen.getByRole("button", { name: "Edit task: Buy a birthday card" }));
    const editor = screen.getByRole("form", { name: "Edit task: Buy a birthday card" });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Details" }), {
      target: { value: "For Sam" },
    });
    fireEvent.change(within(editor).getByLabelText("Due date"), {
      target: { value: "2026-11-12" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await settle();
    expect(last(writes())).toMatchObject({
      cmd: "update_task",
      args: { edit: { notes: "For Sam", due: "2026-11-12" } },
    });
    const row = screen.getByRole("button", { name: "Edit task: Buy a birthday card" });
    expect(row).toHaveTextContent("For Sam");
    expect(row).toHaveTextContent("Tomorrow");
  });

  test("indents, outdents and reorders with the keyboard, and drags into place", async () => {
    await openPanel();
    const renew = () => screen.getByRole("button", { name: "Edit task: Renew passport" });
    fireEvent.keyDown(renew(), { key: "]", ctrlKey: true });
    await settle();
    expect(last(writes())).toMatchObject({
      cmd: "move_task",
      args: { parent: expect.stringMatching(/^task-/), previous: expect.stringMatching(/^task-/) },
    });
    expect(renew().closest("li")).toHaveClass("task-row--sub");
    fireEvent.keyDown(renew(), { key: "[", ctrlKey: true });
    await settle();
    expect(renew().closest("li")).not.toHaveClass("task-row--sub");
    fireEvent.keyDown(renew(), { key: "ArrowUp", ctrlKey: true });
    await settle();
    expect(rows("My Tasks")).toEqual([
      "Send the lease back",
      "Renew passport",
      "Plan the Lisbon trip",
      "Book flights",
    ]);

    // Drag "Send the lease back" by its grip below "Book flights" (jsdom rects are 0: the lower half).
    const from = screen
      .getByRole("button", { name: "Edit task: Send the lease back" })
      .closest("li")!;
    const onto = screen.getByRole("button", { name: "Edit task: Book flights" }).closest("li")!;
    const grip = from.querySelector(".task-row__grip")!;
    document.elementFromPoint = () => onto;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 });
    expect(from).toHaveClass("task-row--dragging");
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 10 });
    expect(onto).toHaveClass("task-row--drop-after");
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 10 });
    await settle();
    expect(rows("My Tasks")).toEqual([
      "Renew passport",
      "Plan the Lisbon trip",
      "Book flights",
      "Send the lease back",
    ]);
    expect(
      screen.getByRole("button", { name: "Edit task: Send the lease back" }).closest("li"),
    ).toHaveClass("task-row--sub");
  });

  test("closing the panel from the keyboard keeps what was being typed", async () => {
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Renew passport" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Renew both passports" } });
    act(() => useTasksStore.getState().togglePanel());
    await settle();
    expect(screen.queryByRole("complementary", { name: "Tasks" })).toBeNull();
    expect(last(writes())).toMatchObject({
      cmd: "update_task",
      args: { edit: { title: "Renew both passports" } },
    });
  });

  test("a change Google refuses snaps back and says why", async () => {
    await openPanel();
    fail.add("set_task_completed");
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark done: Renew passport" }));
    await settle();
    expect(rows("My Tasks")).toContain("Renew passport");
    expect(last(useToastStore.getState().toasts)).toMatchObject({
      title: "Couldn't complete the task",
      description: "Google said no.",
      tone: "danger",
    });
  });

  test("creates, renames and deletes lists, and moves a task to another list", async () => {
    await openPanel();
    const personal = screen.getByRole("region", { name: "avery@example.com" });
    fireEvent.click(within(personal).getByRole("button", { name: "Create new list" }));
    const name = within(personal).getByRole("textbox", { name: "New list name" });
    fireEvent.change(name, { target: { value: "Groceries" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await settle();
    expect(screen.getByRole("heading", { name: "Groceries" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "List options: Errands" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename list" }));
    const rename = screen.getByRole("textbox", { name: "List name" });
    fireEvent.change(rename, { target: { value: "Chores" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await settle();
    expect(screen.getByRole("heading", { name: "Chores" })).toBeInTheDocument();

    const store = useTasksStore.getState();
    const passport = store.lists["acc-personal\nmy-tasks"].find(
      (t) => t.title === "Renew passport",
    )!;
    await act(() => useTasksStore.getState().moveToList(passport, "errands"));
    await settle();
    expect(rows("Chores")[0]).toBe("Renew passport");
    expect(rows("My Tasks")).not.toContain("Renew passport");

    fireEvent.click(screen.getByRole("button", { name: "List options: Chores" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete list" }));
    const confirm = screen.getByRole("group", { name: "Delete list" });
    expect(confirm).toHaveTextContent("Delete “Chores” and its 3 tasks?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete list" }));
    await settle();
    expect(screen.queryByRole("heading", { name: "Chores" })).not.toBeInTheDocument();
  });

  test("an account whose Tasks API is off says how to turn it on, and checking again shows its lists", async () => {
    await openPanel("api_disabled");
    const work = screen.getByRole("region", { name: "avery@example.org" });
    expect(work).toHaveTextContent("The Google Tasks API is off");
    expect(within(work).getByRole("button", { name: "Turn on the Tasks API" })).toBeInTheDocument();
    fireEvent.click(within(work).getByRole("button", { name: "Check again" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
  });

  test("an account that hasn't allowed access gets the Allow button", async () => {
    await openPanel("missing_scope");
    const work = screen.getByRole("region", { name: "avery@example.org" });
    expect(within(work).getByRole("button", { name: "Allow calendar access" })).toBeInTheDocument();
  });

  test("live: a change synced from Google shows without reopening", async () => {
    await openPanel();
    // As if a sync brought it in: the backend changes, then says so.
    await act(async () => {
      await (
        await import("@tauri-apps/api/core")
      ).invoke("create_task", {
        accountId: "acc-work",
        listId: "work",
        edit: { title: "Synced from my phone" },
        parent: null,
        previous: null,
      });
    });
    await settle();
    expect(rows("Work")[0]).toBe("Synced from my phone");
  });
});
