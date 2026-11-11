/** Google Tasks for browser preview: task lists for two accounts, with subtasks and tasks due this week (`src-tauri/src/tasks/` in the app). */

import { emit } from "@tauri-apps/api/event";
import {
  TASKS_EVENTS,
  type Task,
  type TaskEdit,
  type TaskListInfo,
  type TaskListRef,
  type TaskRef,
  type TasksAccess,
  type TasksAccount,
} from "../lib/tauri";

type Args = Record<string, unknown> | undefined;

/** A fixture task: the DTO plus its place among its siblings. */
type Row = Task & { order: number };

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * `access`: the second account's tasks access (`?tasks=api_disabled`, `missing_scope`,
 * `unknown` or `error`; `on` by default). `now` anchors the due dates.
 */
export function createTasksHandlers(
  accounts: { id: string; email: string }[],
  access: string | null,
  now = Date.now(),
) {
  const statuses = new Map<string, TasksAccess["status"]>(
    accounts.map((a, i) => [a.id, (i === 1 && access ? access : "on") as TasksAccess["status"]]),
  );
  const [first, second] = accounts;
  const lists = new Map<string, TaskListInfo[]>();
  if (first)
    lists.set(first.id, [
      { id: "my-tasks", title: "My Tasks", hidden: false },
      { id: "errands", title: "Errands", hidden: false },
    ]);
  if (second) lists.set(second.id, [{ id: "work", title: "Work", hidden: false }]);

  // Monday of the week containing `now`.
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const dueOn = (dayOffset: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    return isoDate(d);
  };

  const rows: Row[] = [];
  let nextId = 1;
  const add = (
    account: { id: string },
    listId: string,
    title: string,
    extra: Partial<Row> = {},
  ): Row => {
    const parent = extra.parent ?? null;
    const row: Row = {
      accountId: account.id,
      listId,
      id: `task-${nextId++}`,
      parent,
      title,
      notes: null,
      due: null,
      completed: false,
      completedAt: null,
      hidden: false,
      updatedAt: now - 60 * 60_000,
      webViewLink: null,
      order: rows.filter(
        (r) => r.accountId === account.id && r.listId === listId && r.parent === parent,
      ).length,
      ...extra,
    };
    rows.push(row);
    return row;
  };
  if (first) {
    add(first, "my-tasks", "Send the lease back", { due: dueOn(2), notes: "Sign page 4" });
    const trip = add(first, "my-tasks", "Plan the Lisbon trip", { due: dueOn(4) });
    add(first, "my-tasks", "Book flights", { parent: trip.id });
    add(first, "my-tasks", "Find a hotel", {
      parent: trip.id,
      completed: true,
      completedAt: now - 2 * 60 * 60_000,
    });
    add(first, "my-tasks", "Renew passport");
    add(first, "my-tasks", "Pay the electricity bill", {
      due: dueOn(0),
      completed: true,
      completedAt: now - 24 * 60 * 60_000,
    });
    add(first, "errands", "Pick up dry cleaning", { due: dueOn(1) });
    add(first, "errands", "Buy a birthday card");
  }
  if (second) {
    add(second, "work", "Review the Q4 roadmap", { due: dueOn(3) });
    add(second, "work", "Write up the design review notes");
  }

  const missingTask = () => ({ code: "not_found", message: "That task isn't available any more." });
  const missingList = () => ({
    code: "not_found",
    message: "That task list isn't available any more.",
  });
  const invalid = (message: string) => ({ code: "invalid_input", message });
  const changed = (accountId: string) =>
    void emit(TASKS_EVENTS.updated, { accountId }).catch(() => {});

  const listOf = (accountId: string, listId: string) =>
    lists.get(accountId)?.find((l) => l.id === listId);
  const requireList = (args: Args, key = "listId") => {
    const accountId = String(args?.accountId);
    const list = listOf(accountId, String(args?.[key]));
    if (!list) throw missingList();
    return list;
  };
  const find = (accountId: string, listId: string, id: unknown) =>
    rows.find((r) => r.accountId === accountId && r.listId === listId && r.id === String(id));
  const requireTask = (args: Args) => {
    const t = find(String(args?.accountId), String(args?.listId), args?.taskId);
    if (!t) throw missingTask();
    return t;
  };
  const siblings = (accountId: string, listId: string, parent: string | null, except?: Row) =>
    rows
      .filter(
        (r) =>
          r.accountId === accountId && r.listId === listId && r.parent === parent && r !== except,
      )
      .sort((a, b) => a.order - b.order);
  /** Puts `t` under `parent`, right after `previous` (first when null), and renumbers. */
  const place = (t: Row, parent: string | null, previous: string | null) => {
    const order = siblings(t.accountId, t.listId, parent, t);
    const at = previous ? order.findIndex((r) => r.id === previous) + 1 : 0;
    order.splice(at, 0, t);
    t.parent = parent;
    order.forEach((r, i) => (r.order = i));
    t.updatedAt = Date.now();
  };
  const checkPlacement = (
    accountId: string,
    listId: string,
    moving: Row | null,
    parent: string | null,
    previous: string | null,
  ) => {
    if (parent) {
      if (moving?.id === parent) throw invalid("A task can't be its own subtask.");
      const p = find(accountId, listId, parent);
      if (!p) throw missingTask();
      if (p.parent) throw invalid("Subtasks can't have subtasks of their own.");
      if (moving && rows.some((r) => r.parent === moving.id))
        throw invalid("A task with subtasks can't become a subtask.");
    }
    if (previous) {
      const prev = find(accountId, listId, previous);
      if (!prev) throw missingTask();
      if (prev === moving || prev.parent !== parent)
        throw invalid("That task isn't next to this one.");
    }
  };
  const applyEdit = (t: Row, edit: TaskEdit) => {
    if (edit.due != null && edit.due !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(edit.due))
      throw invalid("The due date must be a date like 2026-11-12.");
    if (edit.title != null) t.title = edit.title;
    if (edit.notes != null) t.notes = edit.notes || null;
    if (edit.due != null) t.due = edit.due || null;
    t.updatedAt = Date.now();
  };
  const ref = (t: Row): TaskRef => ({ accountId: t.accountId, listId: t.listId, id: t.id });
  const dto = (row: Row): Task => {
    const t: Task & { order?: number } = { ...row };
    delete t.order;
    return t;
  };
  /** A list's tasks: top-level by order, each followed by its subtasks. */
  const outline = (accountId: string, listId: string): Task[] =>
    siblings(accountId, listId, null).flatMap((t) => [
      dto(t),
      ...siblings(accountId, listId, t.id).map(dto),
    ]);
  const accessOf = (accountId: string): TasksAccess => {
    const status = statuses.get(accountId) ?? "unknown";
    return {
      status,
      message: status === "error" ? "Gmail API error 500: Backend Error" : null,
      enableUrl:
        status === "api_disabled"
          ? "https://console.cloud.google.com/apis/library/tasks.googleapis.com"
          : null,
      syncedAt: status === "on" ? now - 60_000 : null,
    };
  };
  const listTitle = (title: unknown) => {
    const t = String(title ?? "").trim();
    if (!t) throw invalid("A list needs a name.");
    return t;
  };

  return {
    tasks_accounts: (): TasksAccount[] =>
      accounts.map((a) => ({
        accountId: a.id,
        email: a.email,
        access: accessOf(a.id),
        lists: statuses.get(a.id) === "on" ? (lists.get(a.id) ?? []).map((l) => ({ ...l })) : [],
      })),
    tasks_in_list: (args: Args): Task[] =>
      statuses.get(String(args?.accountId)) === "on"
        ? outline(String(args?.accountId), String(args?.listId))
        : [],
    dated_tasks: (args: Args): Task[] => {
      const from = String(args?.fromDate);
      const to = String(args?.toDate);
      return rows
        .filter(
          (r) =>
            statuses.get(r.accountId) === "on" &&
            r.due !== null &&
            r.due >= from &&
            r.due < to &&
            !listOf(r.accountId, r.listId)?.hidden,
        )
        .sort((a, b) => a.due!.localeCompare(b.due!) || a.accountId.localeCompare(b.accountId))
        .map(dto);
    },
    set_task_list_hidden: (args: Args) => {
      const list = requireList(args);
      list.hidden = Boolean(args?.hidden);
      changed(String(args?.accountId));
    },
    tasks_sync_now: (args: Args): TasksAccess => {
      const accountId = String(args?.accountId);
      // After turning the API on (or allowing access), checking again works.
      statuses.set(accountId, "on");
      void emit(TASKS_EVENTS.access, { accountId, status: "on" }).catch(() => {});
      return accessOf(accountId);
    },
    create_task: (args: Args): TaskRef => {
      const accountId = String(args?.accountId);
      const list = requireList(args);
      const parent = args?.parent ? String(args.parent) : null;
      const previous = args?.previous ? String(args.previous) : null;
      checkPlacement(accountId, list.id, null, parent, previous);
      const t = add({ id: accountId }, list.id, "", { parent });
      applyEdit(t, (args?.edit ?? {}) as TaskEdit);
      place(t, parent, previous);
      changed(accountId);
      return ref(t);
    },
    update_task: (args: Args): TaskRef => {
      const t = requireTask(args);
      applyEdit(t, (args?.edit ?? {}) as TaskEdit);
      changed(t.accountId);
      return ref(t);
    },
    set_task_completed: (args: Args): TaskRef => {
      const t = requireTask(args);
      t.completed = Boolean(args?.completed);
      t.completedAt = t.completed ? Date.now() : null;
      t.updatedAt = Date.now();
      changed(t.accountId);
      return ref(t);
    },
    delete_task: (args: Args) => {
      const t = requireTask(args);
      for (const r of rows.filter((r) => r === t || (r.listId === t.listId && r.parent === t.id)))
        rows.splice(rows.indexOf(r), 1);
      changed(t.accountId);
    },
    move_task: (args: Args): TaskRef => {
      const t = requireTask(args);
      const parent = args?.parent ? String(args.parent) : null;
      const previous = args?.previous ? String(args.previous) : null;
      checkPlacement(t.accountId, t.listId, t, parent, previous);
      place(t, parent, previous);
      changed(t.accountId);
      return ref(t);
    },
    move_task_to_list: (args: Args): TaskRef => {
      const t = requireTask(args);
      const destination = requireList(args, "destinationListId");
      if (destination.id === t.listId) throw invalid("The task is already in that list.");
      const subtasks = rows.filter((r) => r.listId === t.listId && r.parent === t.id);
      t.listId = destination.id;
      for (const s of subtasks) s.listId = destination.id;
      place(t, null, null);
      changed(t.accountId);
      return ref(t);
    },
    create_task_list: (args: Args): TaskListRef => {
      const accountId = String(args?.accountId);
      const title = listTitle(args?.title);
      const id = `list-${nextId++}`;
      const accountLists = lists.get(accountId) ?? [];
      accountLists.push({ id, title, hidden: false });
      lists.set(accountId, accountLists);
      changed(accountId);
      return { accountId, listId: id };
    },
    rename_task_list: (args: Args): TaskListRef => {
      const list = requireList(args);
      list.title = listTitle(args?.title);
      changed(String(args?.accountId));
      return { accountId: String(args?.accountId), listId: list.id };
    },
    delete_task_list: (args: Args) => {
      const accountId = String(args?.accountId);
      const list = requireList(args);
      lists.set(
        accountId,
        (lists.get(accountId) ?? []).filter((l) => l !== list),
      );
      for (const r of rows.filter((r) => r.accountId === accountId && r.listId === list.id))
        rows.splice(rows.indexOf(r), 1);
      changed(accountId);
    },
  };
}
