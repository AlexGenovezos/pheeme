import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import { useToastStore } from "../components/ui/Toast";
import { createTasksHandlers } from "../preview/tasks";
import { useAccountStore } from "../store/accountStore";
import { ContextMenuHost } from "../shell/ContextMenuHost";
import { TasksPanelHost } from "./TasksPanel";
import { readPanelOpen, TASKS_PREFS_KEY, useTasksStore } from "./tasksStore";
import { byName } from "../preview/handlers";

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
/** Commands whose answer waits until the test releases it. */
let hold: Set<string>;
let held: Array<() => void>;
/** Answers that replace the fixtures', by command. */
let answers: Map<string, unknown>;

function backend(access: string | null = null) {
  const handlers = byName(createTasksHandlers(ACCOUNTS, access, NOW));
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (fail.has(cmd)) throw { code: "gmail_api", message: "Google said no." };
      const answer = () => (answers.has(cmd) ? answers.get(cmd) : handlers[cmd]?.(a));
      if (hold.has(cmd)) return new Promise((resolve) => held.push(() => resolve(answer())));
      return answer();
    },
    { shouldMockEvents: true },
  );
}

const last = <T,>(items: T[]) => items[items.length - 1];
const writes = () =>
  calls.filter(
    (c) => !["tasks_accounts", "tasks_in_list", "dated_tasks", "tasks_due_through"].includes(c.cmd),
  );
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
  hold = new Set();
  held = [];
  answers = new Map();
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useToastStore.setState({ toasts: [] });
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

  test("two changes at once: the first one's reload never undoes the second while it's saving", async () => {
    await openPanel();
    hold.add("set_task_completed");
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark done: Renew passport" }));
    fireEvent.click(
      within(list("My Tasks")).getByRole("checkbox", { name: "Mark done: Send the lease back" }),
    );
    await settle();
    expect(held).toHaveLength(2);
    // The first write lands and its reload reads a cache where the second is still open.
    held.shift()!();
    await settle();
    expect(rows("My Tasks")).not.toContain("Renew passport");
    expect(rows("My Tasks")).not.toContain("Send the lease back");
    held.shift()!();
    await settle();
    expect(rows("My Tasks")).not.toContain("Send the lease back");
    expect(rows("My Tasks")).not.toContain("Renew passport");
  });

  test("two quick moves: the first one's reload keeps the second in place", async () => {
    await openPanel();
    hold.add("move_task");
    const renew = () => screen.getByRole("button", { name: "Edit task: Renew passport" });
    fireEvent.keyDown(renew(), { key: "ArrowUp", ctrlKey: true });
    await settle();
    fireEvent.keyDown(renew(), { key: "ArrowUp", ctrlKey: true });
    await settle();
    const moved = ["Renew passport", "Send the lease back", "Plan the Lisbon trip", "Book flights"];
    expect(rows("My Tasks")).toEqual(moved);
    held.shift()!();
    await settle();
    expect(rows("My Tasks")).toEqual(moved);
    held.shift()!();
    await settle();
    expect(rows("My Tasks")).toEqual(moved);
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
    fireEvent.click(within(editor).getByRole("combobox", { name: "Due date" }));
    fireEvent.click(screen.getByRole("gridcell", { name: "Thursday, November 12, 2026" }));
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
    const from = within(list("My Tasks"))
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
      within(list("My Tasks"))
        .getByRole("button", { name: "Edit task: Send the lease back" })
        .closest("li"),
    ).toHaveClass("task-row--sub");
  });

  test("Shift+F10 on a task row opens its menu", async () => {
    await openPanel();
    const row = screen
      .getByRole("button", { name: "Edit task: Renew passport" })
      .closest(".task-row")!;
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  test("tasks.focus opens a closed panel and moves focus into it", async () => {
    backend();
    render(<TasksPanelHost />);
    await settle();
    expect(screen.queryByRole("complementary", { name: "Tasks" })).toBeNull();
    act(() => void registry.run("tasks.focus"));
    await settle();
    const panel = screen.getByRole("complementary", { name: "Tasks" });
    // The first task, once its list has been read, not the Add button that was there before it.
    expect(document.activeElement).toHaveAccessibleName(/^Edit task: /);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => void registry.run("tasks.focus"));
    expect(panel.contains(document.activeElement)).toBe(true);
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

  test("a new task Google refuses keeps its editor open with what was typed, and saves on retry", async () => {
    await openPanel();
    fail.add("create_task");
    fireEvent.click(within(list("Errands")).getByRole("button", { name: "Add a task" }));
    const editor = () => within(list("Errands")).getByRole("form", { name: "New task" });
    fireEvent.change(within(editor()).getByRole("textbox", { name: "Title" }), {
      target: { value: "Return the library books" },
    });
    fireEvent.change(within(editor()).getByRole("textbox", { name: "Details" }), {
      target: { value: "Two of them" },
    });
    fireEvent.submit(within(editor()).getByRole("textbox", { name: "Title" }));
    await settle();
    expect(last(useToastStore.getState().toasts)).toMatchObject({ title: "Couldn't add the task" });
    expect(within(editor()).getByRole("textbox", { name: "Title" })).toHaveValue(
      "Return the library books",
    );
    expect(within(editor()).getByRole("textbox", { name: "Details" })).toHaveValue("Two of them");

    fail.delete("create_task");
    fireEvent.keyDown(within(editor()).getByRole("textbox", { name: "Title" }), { key: "Escape" });
    await settle();
    expect(rows("Errands")[0]).toBe("Return the library books");
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

  test("a failed read of the task lists shows the error with Try again, not an empty panel", async () => {
    fail.add("tasks_accounts");
    await openPanel();
    const panel = screen.getByRole("complementary", { name: "Tasks" });
    expect(within(panel).getByRole("alert")).toHaveTextContent("Google said no.");
    expect(useTasksStore.getState().accounts).toBeNull();
    expect(useTasksStore.getState().accountsError).toBe("Google said no.");

    fail.delete("tasks_accounts");
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    await settle();
    expect(useTasksStore.getState().accountsError).toBeNull();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(rows("Work").length).toBeGreaterThan(0);
  });

  test("a failed reload keeps the accounts it had", async () => {
    await openPanel();
    const before = useTasksStore.getState().accounts;
    expect(before).not.toBeNull();
    fail.add("tasks_accounts");
    await act(() => useTasksStore.getState().loadAccounts());
    expect(useTasksStore.getState().accounts).toBe(before);
    expect(useTasksStore.getState().accountsError).toBe("Google said no.");
    // The error shows above the lists it kept.
    expect(screen.getByRole("alert")).toHaveTextContent("Google said no.");
    expect(rows("My Tasks")).toContain("Renew passport");
  });

  test("a failed reload of a list keeps its tasks and shows the error with Try again", async () => {
    await openPanel();
    fail.add("tasks_in_list");
    const { accountId } = useTasksStore.getState().accounts![0]!;
    const listId = useTasksStore.getState().accounts![0]!.lists[0]!.id;
    await act(() => useTasksStore.getState().loadList(accountId, listId));
    const section = list("My Tasks");
    expect(within(section).getByRole("alert")).toHaveTextContent("Google said no.");
    expect(rows("My Tasks")).toContain("Renew passport");
    fail.delete("tasks_in_list");
    fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
    await settle();
    expect(within(list("My Tasks")).queryByRole("alert")).toBeNull();
  });

  test("a list that failed to load shows the error instead of No tasks yet, and Try again reads it", async () => {
    fail.add("tasks_in_list");
    await openPanel();
    const section = list("Work");
    expect(within(section).getByRole("alert")).toHaveTextContent("Google said no.");
    expect(within(section).queryByText("No tasks yet")).toBeNull();

    fail.delete("tasks_in_list");
    fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
    await settle();
    expect(within(list("Work")).queryByRole("alert")).toBeNull();
    expect(rows("Work").length).toBeGreaterThan(0);
    expect(Object.keys(useTasksStore.getState().listErrors).some((k) => k.includes("work"))).toBe(
      false,
    );
  });

  test("a failed dated read sets datedError and the next good one clears it", async () => {
    backend();
    fail.add("dated_tasks");
    await act(() => useTasksStore.getState().loadDated("2026-11-08", "2026-11-15"));
    expect(useTasksStore.getState().datedError).toBe("Google said no.");
    fail.delete("dated_tasks");
    await act(() => useTasksStore.getState().loadDated("2026-11-08", "2026-11-15"));
    expect(useTasksStore.getState().datedError).toBeNull();
  });

  test("Today lists every account's overdue tasks first, then today's", async () => {
    await openPanel();
    const today = list("Today");
    expect(rows("Today")).toEqual([
      "Send the Acme invoice",
      "Pick up dry cleaning",
      "Send the lease back",
      "Draft the newsletter",
    ]);
    expect(today).toHaveTextContent("4");
    const overdue = within(today)
      .getByRole("button", { name: "Edit task: Pick up dry cleaning" })
      .querySelector(".task-row__due");
    expect(overdue).toHaveClass("task-row__due--overdue");
    expect(
      within(today)
        .getByRole("button", { name: "Edit task: Send the lease back" })
        .querySelector(".task-row__due"),
    ).not.toHaveClass("task-row__due--overdue");
    expect(within(today).getByRole("button", { name: "Plan today" })).toHaveAttribute(
      "data-command",
      "tasks.planToday",
    );
  });

  test("Today keeps its shape while loading, and says Nothing due today only once it's empty", async () => {
    hold.add("tasks_due_through");
    answers.set("tasks_due_through", []);
    await openPanel();
    const today = list("Today");
    expect(today.querySelectorAll('.task-row[aria-hidden="true"]')).toHaveLength(2);
    expect(within(today).getByRole("button", { name: "Plan today" })).toBeInTheDocument();
    expect(today).not.toHaveTextContent("Nothing due today");

    for (const release of held.splice(0)) release();
    await settle();
    expect(today.querySelectorAll(".task-row")).toHaveLength(0);
    expect(today).toHaveTextContent("Nothing due today");
  });

  test("ticking a task off in Today completes it and takes it out of Today", async () => {
    await openPanel();
    fireEvent.click(
      within(list("Today")).getByRole("checkbox", { name: "Mark done: Pick up dry cleaning" }),
    );
    expect(rows("Today")).not.toContain("Pick up dry cleaning");
    await settle();
    expect(last(writes())).toMatchObject({
      cmd: "set_task_completed",
      args: { listId: "errands", completed: true },
    });
    expect(rows("Today")).not.toContain("Pick up dry cleaning");
    expect(rows("Today")).toContain("Send the lease back");
  });

  test("a task edited from Today opens its editor there", async () => {
    await openPanel();
    fireEvent.click(
      within(list("Today")).getByRole("button", { name: "Edit task: Send the lease back" }),
    );
    expect(
      within(list("Today")).getByRole("form", { name: "Edit task: Send the lease back" }),
    ).toBeInTheDocument();
    expect(within(list("My Tasks")).queryByRole("form")).toBeNull();
    fireEvent.keyDown(within(list("Today")).getByRole("textbox", { name: "Title" }), {
      key: "Escape",
    });
    await settle();
    expect(within(list("Today")).queryByRole("form")).toBeNull();
  });
});
