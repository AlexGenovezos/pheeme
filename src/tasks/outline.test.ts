import { describe, expect, test } from "vitest";
import type { Task } from "../lib/tauri";
import { layoutTasks } from "./gridLayout";
import {
  applyMove,
  dropPlacement,
  dueLabel,
  indentPlacement,
  newTaskIn,
  newTaskKey,
  outdentPlacement,
  splitCompleted,
  stepPlacement,
} from "./outline";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  accountId: "a",
  listId: "l",
  id,
  parent: null,
  title: id,
  notes: null,
  due: null,
  completed: false,
  completedAt: null,
  hidden: false,
  updatedAt: 0,
  webViewLink: null,
  ...extra,
});

// A, B (with subtasks B1, B2), C
const A = task("A");
const B = task("B");
const B1 = task("B1", { parent: "B" });
const B2 = task("B2", { parent: "B" });
const C = task("C");
const LIST = [A, B, B1, B2, C];
const ids = (tasks: Task[]) => tasks.map((t) => (t.parent ? `${t.parent}>${t.id}` : t.id));

describe("splitCompleted", () => {
  test("a completed parent takes its subtasks; cleared tasks are left out; newest done first", () => {
    const list = [
      task("A", { completed: true, completedAt: 1 }),
      task("A1", { parent: "A" }),
      task("B"),
      task("B1", { parent: "B", completed: true, completedAt: 5 }),
      task("C", { completed: true, completedAt: 3, hidden: true }),
    ];
    const { open, completed } = splitCompleted(list);
    expect(open.map((t) => t.id)).toEqual(["B"]);
    expect(completed.map((t) => t.id)).toEqual(["B1", "A", "A1"]);
  });
});

describe("applyMove", () => {
  test("moves a task with its subtasks after another task and its subtasks", () => {
    expect(ids(applyMove(LIST, B, { parent: null, previous: C.id }))).toEqual([
      "A",
      "C",
      "B",
      "B>B1",
      "B>B2",
    ]);
    expect(ids(applyMove(LIST, C, { parent: null, previous: B.id }))).toEqual(ids(LIST));
    expect(ids(applyMove(LIST, C, { parent: null, previous: null }))[0]).toBe("C");
  });

  test("makes a subtask: first under its parent, or after a sibling", () => {
    expect(ids(applyMove(LIST, C, { parent: "B", previous: null }))).toEqual([
      "A",
      "B",
      "B>C",
      "B>B1",
      "B>B2",
    ]);
    expect(ids(applyMove(LIST, A, { parent: "B", previous: "B2" }))).toEqual([
      "B",
      "B>B1",
      "B>B2",
      "B>A",
      "C",
    ]);
  });
});

describe("indent, outdent and steps", () => {
  test("indent goes under the task above, after its subtasks", () => {
    expect(indentPlacement(LIST, C)).toEqual({ parent: "B", previous: "B2" });
    expect(indentPlacement(LIST, B)).toBeNull(); // has subtasks
    expect(indentPlacement(LIST, A)).toBeNull(); // nothing above
    expect(indentPlacement(LIST, B1)).toBeNull(); // already a subtask
  });

  test("outdent lifts a subtask to right after its parent", () => {
    expect(outdentPlacement(B2)).toEqual({ parent: null, previous: "B" });
    expect(outdentPlacement(A)).toBeNull();
  });

  test("steps move among siblings only", () => {
    expect(stepPlacement(LIST, C, -1)).toEqual({ parent: null, previous: "A" });
    expect(stepPlacement(LIST, B, -1)).toEqual({ parent: null, previous: null });
    expect(stepPlacement(LIST, A, -1)).toBeNull();
    expect(stepPlacement(LIST, A, 1)).toEqual({ parent: null, previous: "B" });
    expect(stepPlacement(LIST, C, 1)).toBeNull();
    expect(stepPlacement(LIST, B2, -1)).toEqual({ parent: "B", previous: null });
  });
});

describe("dropPlacement", () => {
  test("above or below a task among its siblings", () => {
    expect(dropPlacement(LIST, C, A, "before")).toEqual({ parent: null, previous: null });
    expect(dropPlacement(LIST, A, C, "after")).toEqual({ parent: null, previous: "C" });
    expect(dropPlacement(LIST, C, B1, "after")).toEqual({ parent: "B", previous: "B1" });
  });

  test("below a task with subtasks makes it the first subtask, unless it has its own", () => {
    expect(dropPlacement(LIST, A, B, "after")).toEqual({ parent: "B", previous: null });
    const parentA = [A, task("A1", { parent: "A" }), B, B1, B2, C];
    expect(dropPlacement(parentA, A, B, "after")).toEqual({ parent: null, previous: "B" });
    // Onto a subtask: a task with subtasks goes beside the parent instead.
    expect(dropPlacement(parentA, A, B1, "before")).toEqual({ parent: null, previous: "B" });
  });

  test("drops that wouldn't move it, or onto itself or its subtasks, do nothing", () => {
    expect(dropPlacement(LIST, B, B, "after")).toBeNull();
    expect(dropPlacement(LIST, B, B1, "after")).toBeNull();
    expect(dropPlacement(LIST, C, B2, "after")).toEqual({ parent: "B", previous: "B2" });
    expect(dropPlacement(LIST, A, B, "before")).toBeNull();
    expect(dropPlacement(LIST, B, A, "after")).toBeNull();
  });
});

test("dueLabel says today, tomorrow and yesterday, else the date", () => {
  expect(dueLabel("2026-11-10", "2026-11-10")).toBe("Today");
  expect(dueLabel("2026-11-11", "2026-11-10")).toBe("Tomorrow");
  expect(dueLabel("2026-11-09", "2026-11-10")).toBe("Yesterday");
  expect(dueLabel("2026-11-13", "2026-11-10")).toMatch(/Fri.*Nov.*13/);
  expect(dueLabel("2027-01-04", "2026-11-10")).toMatch(/2027/);
});

test("a new task's key carries its list and placement", () => {
  const key = newTaskKey("a", "l", { parent: "B", previous: "B2" });
  expect(newTaskIn(key, "a", "l")).toEqual({ parent: "B", previous: "B2" });
  expect(newTaskIn(key, "a", "other")).toBeNull();
  expect(newTaskIn(newTaskKey("a", "l", { parent: null, previous: null }), "a", "l")).toEqual({
    parent: null,
    previous: null,
  });
  expect(newTaskIn("a\nl\nA", "a", "l")).toBeNull();
});

test("layoutTasks puts each task in its day's first free row", () => {
  const days = ["2026-11-09", "2026-11-10", "2026-11-11"];
  // An event bar over the first two days in row 0, and one in row 1 on the first day.
  const taken = [
    { start: 0, span: 2, row: 0 },
    { start: 0, span: 1, row: 1 },
  ];
  const tasks = [
    task("x", { due: "2026-11-09" }),
    task("y", { due: "2026-11-10" }),
    task("z", { due: "2026-11-10" }),
    task("w", { due: "2026-11-11" }),
    task("off", { due: "2026-11-20" }),
    task("none"),
  ];
  expect(layoutTasks(tasks, days, taken).map((s) => [s.task.id, s.start, s.row])).toEqual([
    ["x", 0, 2],
    ["y", 1, 1],
    ["z", 1, 2],
    ["w", 2, 0],
  ]);
});
