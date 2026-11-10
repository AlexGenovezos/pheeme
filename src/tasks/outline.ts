// A task list as the panel shows it: open tasks in Google's order with each subtask under its
// parent, then the completed ones. And where a task lands when it's dragged, indented, outdented
// or moved up and down, in the terms the Tasks API takes (`parent`, `previous`).
import { addDays, formatDay } from "../calendar/dates";
import type { Task } from "../lib/tauri";

/** Identifies a task across accounts and lists. */
export const taskKey = (t: { accountId: string; listId: string; id: string }) =>
  `${t.accountId}\n${t.listId}\n${t.id}`;

/** Identifies a list across accounts. */
export const listKey = (accountId: string, listId: string) => `${accountId}\n${listId}`;

export const taskTitle = (t: Task) => t.title.trim() || "(No title)";

/**
 * Splits a list (in the order `tasks_in_list` gives it) into the open outline and the completed
 * tasks, most recently completed first. A completed parent takes its subtasks with it, as in Google
 * Tasks; tasks cleared from the list (`hidden`) aren't shown at all.
 */
export function splitCompleted(tasks: Task[]): { open: Task[]; completed: Task[] } {
  const done = new Set(tasks.filter((t) => t.completed).map((t) => t.id));
  const open: Task[] = [];
  const completed: Task[] = [];
  for (const t of tasks) {
    if (t.hidden) continue;
    if (t.completed || (t.parent && done.has(t.parent))) completed.push(t);
    else open.push(t);
  }
  completed.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return { open, completed };
}

/** Where a task goes: under `parent` (top level when null), right after `previous` (first when null). */
export interface Placement {
  parent: string | null;
  previous: string | null;
}

const hasChildren = (tasks: Task[], id: string) => tasks.some((t) => t.parent === id);

/** The sibling just before `t` under the same parent in `tasks`, if any. */
function siblingBefore(tasks: Task[], t: Task): Task | null {
  const siblings = tasks.filter((s) => s.parent === t.parent);
  const i = siblings.findIndex((s) => s.id === t.id);
  return i > 0 ? siblings[i - 1] : null;
}

function siblingAfter(tasks: Task[], t: Task): Task | null {
  const siblings = tasks.filter((s) => s.parent === t.parent);
  const i = siblings.findIndex((s) => s.id === t.id);
  return i >= 0 && i < siblings.length - 1 ? siblings[i + 1] : null;
}

/**
 * The list after moving `task` (with its subtasks) to `placement`: what the panel shows while
 * Google confirms the move. `tasks` is in outline order.
 */
export function applyMove(tasks: Task[], task: Task, { parent, previous }: Placement): Task[] {
  const block = tasks.filter((t) => t.id === task.id || t.parent === task.id);
  const rest = tasks.filter((t) => t.id !== task.id && t.parent !== task.id);
  const moved = block.map((t) => (t.id === task.id ? { ...t, parent } : t));
  let at: number;
  if (previous) {
    const p = rest.findIndex((t) => t.id === previous);
    if (p < 0) return tasks;
    // After `previous` and its subtasks.
    at = p + 1;
    while (at < rest.length && rest[at].parent === previous) at++;
  } else if (parent) {
    const p = rest.findIndex((t) => t.id === parent);
    if (p < 0) return tasks;
    at = p + 1;
  } else {
    at = 0;
  }
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** Make `task` a subtask of the task above it (at the end of its subtasks). */
export function indentPlacement(open: Task[], task: Task): Placement | null {
  if (task.parent || hasChildren(open, task.id)) return null;
  const above = siblingBefore(open, task);
  if (!above) return null;
  const children = open.filter((t) => t.parent === above.id);
  return { parent: above.id, previous: children[children.length - 1]?.id ?? null };
}

/** Lift a subtask out to sit right after its parent. */
export function outdentPlacement(task: Task): Placement | null {
  if (!task.parent) return null;
  return { parent: null, previous: task.parent };
}

/** One place up or down among its siblings. */
export function stepPlacement(open: Task[], task: Task, dir: -1 | 1): Placement | null {
  if (dir === 1) {
    const next = siblingAfter(open, task);
    return next ? { parent: task.parent, previous: next.id } : null;
  }
  const prev = siblingBefore(open, task);
  if (!prev) return null;
  const before = siblingBefore(open, prev);
  return { parent: task.parent, previous: before?.id ?? null };
}

/**
 * Where `dragged` lands when dropped on the upper or lower half of `target`. Dropping below a
 * task with subtasks makes it that task's first subtask; a task with subtasks of its own stays at
 * the top level. Null when the drop wouldn't move it.
 */
export function dropPlacement(
  open: Task[],
  dragged: Task,
  target: Task,
  half: "before" | "after",
): Placement | null {
  if (dragged.id === target.id || target.parent === dragged.id) return null;
  const draggedHasChildren = hasChildren(open, dragged.id);
  let placement: Placement;
  if (half === "after" && !target.parent && hasChildren(open, target.id)) {
    placement = draggedHasChildren
      ? { parent: null, previous: target.id }
      : { parent: target.id, previous: null };
  } else if (half === "after") {
    placement = { parent: target.parent, previous: target.id };
  } else {
    const before = siblingBefore(open, target);
    placement = { parent: target.parent, previous: before?.id ?? null };
    if (before?.id === dragged.id) return null;
  }
  // A task with subtasks can't become a subtask: it goes beside the target's parent instead.
  if (placement.parent && draggedHasChildren)
    placement = { parent: null, previous: placement.parent };
  if (
    placement.parent === dragged.parent &&
    placement.previous === siblingBefore(open, dragged)?.id
  )
    return null;
  if (placement.previous === dragged.id) return null;
  return placement;
}

/** "Today", "Tomorrow", "Yesterday", "Wed, Nov 12" (with the year when it isn't this year). */
export function dueLabel(due: string, today: string): string {
  if (due === today) return "Today";
  if (due === addDays(today, 1)) return "Tomorrow";
  if (due === addDays(today, -1)) return "Yesterday";
  return formatDay(due, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(due.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/** The `editing` key of a new task being typed into a list at `placement`. */
export const newTaskKey = (accountId: string, listId: string, p: Placement) =>
  `new\n${accountId}\n${listId}\n${p.parent ?? ""}\n${p.previous ?? ""}`;

/** The placement of the new task `key` describes, if it's one for this list. */
export function newTaskIn(key: string | null, accountId: string, listId: string): Placement | null {
  const parts = key?.split("\n");
  if (!parts || parts[0] !== "new" || parts[1] !== accountId || parts[2] !== listId) return null;
  return { parent: parts[3] || null, previous: parts[4] || null };
}
