import { describe, expect, test } from "vitest";
import type { Task, TaskListRef, TaskRef, TasksAccess, TasksAccount } from "../lib/tauri";
import { createTasksHandlers } from "./tasks";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time.
const NOW = new Date(2026, 10, 11, 12).getTime();
const A = "acc-personal";

const titles = (tasks: Task[]) => tasks.map((t) => (t.parent ? `  ${t.title}` : t.title));
const list = (h: ReturnType<typeof createTasksHandlers>, listId = "my-tasks", accountId = A) =>
  h.tasks_in_list({ accountId, listId }) as Task[];
const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected an error");
};

describe("tasks preview", () => {
  test("lists both accounts' lists, with subtasks after their parent and tasks due this week", () => {
    const h = createTasksHandlers(ACCOUNTS, null, NOW);
    const accounts = h.tasks_accounts() as TasksAccount[];
    expect(accounts.map((a) => a.lists.map((l) => l.title))).toEqual([
      ["My Tasks", "Errands"],
      ["Work"],
    ]);
    expect(titles(list(h))).toEqual([
      "Send the lease back",
      "Plan the Lisbon trip",
      "  Book flights",
      "  Find a hotel",
      "Renew passport",
      "Pay the electricity bill",
    ]);
    const week = h.dated_tasks({ fromDate: "2026-11-09", toDate: "2026-11-16" }) as Task[];
    expect(week.map((t) => t.due)).toEqual([...week.map((t) => t.due)].sort());
    expect(new Set(week.map((t) => t.accountId)).size).toBe(2);
    expect(week.some((t) => t.completed)).toBe(true);
  });

  test("the Tasks API can be off for one account until it checks again", () => {
    const h = createTasksHandlers(ACCOUNTS, "api_disabled", NOW);
    const work = (h.tasks_accounts() as TasksAccount[])[1];
    expect(work.access.status).toBe("api_disabled");
    expect(work.access.enableUrl).toContain("tasks.googleapis.com");
    expect(work.lists).toEqual([]);
    expect((h.tasks_sync_now({ accountId: "acc-work" }) as TasksAccess).status).toBe("on");
    expect(list(h, "work", "acc-work").length).toBe(2);
  });

  test("adds, edits, completes, reorders, indents and deletes tasks", () => {
    const h = createTasksHandlers(ACCOUNTS, null, NOW);
    const [lease, trip] = list(h);
    const added = h.create_task({
      accountId: A,
      listId: "my-tasks",
      edit: { title: "Call Sam", due: "2026-11-13" },
      parent: null,
      previous: lease.id,
    }) as TaskRef;
    expect(titles(list(h)).slice(0, 3)).toEqual([
      "Send the lease back",
      "Call Sam",
      "Plan the Lisbon trip",
    ]);

    h.update_task({ accountId: A, listId: "my-tasks", taskId: added.id, edit: { due: "" } });
    h.set_task_completed({ accountId: A, listId: "my-tasks", taskId: added.id, completed: true });
    const call = list(h).find((t) => t.id === added.id)!;
    expect(call.due).toBeNull();
    expect(call.completed).toBe(true);

    h.move_task({
      accountId: A,
      listId: "my-tasks",
      taskId: added.id,
      parent: trip.id,
      previous: null,
    });
    expect(titles(list(h)).slice(0, 3)).toEqual([
      "Send the lease back",
      "Plan the Lisbon trip",
      "  Call Sam",
    ]);
    expect(
      thrown(() =>
        h.move_task({
          accountId: A,
          listId: "my-tasks",
          taskId: trip.id,
          parent: lease.id,
          previous: null,
        }),
      ).code,
    ).toBe("invalid_input");

    h.delete_task({ accountId: A, listId: "my-tasks", taskId: trip.id });
    expect(titles(list(h))).toEqual([
      "Send the lease back",
      "Renew passport",
      "Pay the electricity bill",
    ]);
    expect(
      thrown(() => h.update_task({ accountId: A, listId: "my-tasks", taskId: trip.id, edit: {} }))
        .code,
    ).toBe("not_found");
  });

  test("moves tasks between lists and creates, renames and deletes lists", () => {
    const h = createTasksHandlers(ACCOUNTS, null, NOW);
    const trip = list(h)[1];
    h.move_task_to_list({
      accountId: A,
      listId: "my-tasks",
      taskId: trip.id,
      destinationListId: "errands",
    });
    expect(titles(list(h, "errands")).slice(0, 3)).toEqual([
      "Plan the Lisbon trip",
      "  Book flights",
      "  Find a hotel",
    ]);
    expect(list(h).some((t) => t.id === trip.id)).toBe(false);

    const created = h.create_task_list({ accountId: A, title: " Groceries " }) as TaskListRef;
    h.rename_task_list({ accountId: A, listId: created.listId, title: "Food" });
    h.set_task_list_hidden({ accountId: A, listId: "errands", hidden: true });
    const lists = (h.tasks_accounts() as TasksAccount[])[0].lists;
    expect(lists.map((l) => [l.title, l.hidden])).toEqual([
      ["My Tasks", false],
      ["Errands", true],
      ["Food", false],
    ]);
    const week = h.dated_tasks({ fromDate: "2026-11-09", toDate: "2026-11-16" }) as Task[];
    expect(week.some((t) => t.listId === "errands")).toBe(false);

    h.delete_task_list({ accountId: A, listId: "errands" });
    expect((h.tasks_accounts() as TasksAccount[])[0].lists.map((l) => l.title)).toEqual([
      "My Tasks",
      "Food",
    ]);
    expect(list(h, "errands")).toEqual([]);
  });
});
