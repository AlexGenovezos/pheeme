// Google Tasks state: every account's task lists and tasks access, the tasks of each list (read
// while the Tasks panel is open), the dated tasks of the days the calendar shows, and whether the
// panel is open (remembered across launches). Changes show at once and go straight to the Tasks
// API; one Google refuses snaps back and says why.
import { create } from "zustand";
import { dateOf, systemZone } from "../calendar/dates";
import { toast } from "../components/ui/Toast";
import { subscribeAll } from "../lib/subscriptions";
import {
  listen,
  createTask,
  createTaskList,
  deleteTask,
  deleteTaskList,
  getDatedTasks,
  getTasksAccounts,
  getTasksDueThrough,
  getTasksInList,
  moveTask,
  moveTaskToList,
  renameTaskList,
  setTaskCompleted,
  setTaskListHidden,
  type Task,
  type TaskEdit,
  type TaskRef,
  TASKS_EVENTS,
  type TasksAccount,
  tasksSyncNow,
  toCommandError,
  updateTask,
} from "../lib/tauri";
import { applyMove, listKey, type Placement, taskKey } from "./outline";

export const TASKS_PREFS_KEY = "pheeme.tasks";
export const TOGGLE_TASKS_COMMAND = "view.toggleTasks";
export const TOGGLE_TASKS_SHORTCUT = "mod+shift+t";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readPanelOpen(store: Pick<Storage, "getItem"> | undefined = storage()): boolean {
  try {
    return (
      (JSON.parse(store?.getItem(TASKS_PREFS_KEY) ?? "null") as { open?: unknown } | null)?.open ===
      true
    );
  } catch {
    return false;
  }
}

function writePanelOpen(open: boolean) {
  try {
    storage()?.setItem(TASKS_PREFS_KEY, JSON.stringify({ open }));
  } catch {
    // Storage full or blocked: the choice lasts for this session.
  }
}

interface TasksState {
  panelOpen: boolean;
  /** `null` until the first load. */
  accounts: TasksAccount[] | null;
  /** Each list's tasks in outline order, by `listKey`; absent until read. */
  lists: Record<string, Task[]>;
  /** Tasks due on the days `datedFor` covers; `null` until the first load. */
  dated: Task[] | null;
  /** `[from, to)` of the dated tasks, as `from:to`. */
  datedFor: string | null;
  /** Why the last read of the task lists failed; `null` when it worked (`accounts` keeps its old value). */
  accountsError: string | null;
  /** Why the last read of a list's tasks failed, by `listKey`; absent when it worked. */
  listErrors: Record<string, string>;
  /** Why the last read of the dated tasks failed; `null` when it worked. */
  datedError: string | null;
  /** Every account's open tasks due today or earlier (Today, the plan); `null` until the first load. */
  due: Task[] | null;
  /** Why the last read of the due tasks failed; `null` when it worked. */
  dueError: string | null;
  /** The task whose details are open in the panel (`taskKey`), or the list a new task is being added to (`listKey`). */
  editing: string | null;

  setPanelOpen(open: boolean): void;
  togglePanel(): void;
  /** Open the panel with `task`'s details (from the calendar grid). */
  reveal(task: Task): void;
  setEditing(key: string | null): void;
  loadAccounts(): Promise<void>;
  loadList(accountId: string, listId: string): Promise<void>;
  /** Read the tasks due on `[from, to)` (the days on screen). */
  loadDated(from: string, to: string): Promise<void>;
  /** Read every account's open tasks due today or earlier. */
  loadDue(): Promise<void>;
  /** Show `dated` as the tasks due in `[from, to)`: read by the calendar along with its events. */
  setDated(from: string, to: string, dated: Task[]): void;
  /** Ask Google for every account's latest tasks (the panel opened). */
  syncAll(): void;
  setListHidden(accountId: string, listId: string, hidden: boolean): Promise<void>;

  addTask(
    accountId: string,
    listId: string,
    edit: TaskEdit,
    placement?: Placement,
  ): Promise<TaskRef | null>;
  editTask(task: Task, edit: TaskEdit): Promise<boolean>;
  setCompleted(task: Task, completed: boolean): Promise<void>;
  deleteTask(task: Task): Promise<void>;
  moveTask(task: Task, placement: Placement): Promise<void>;
  moveToList(task: Task, listId: string): Promise<void>;
  createList(accountId: string, title: string): Promise<boolean>;
  renameList(accountId: string, listId: string, title: string): Promise<boolean>;
  deleteList(accountId: string, listId: string): Promise<void>;

  /** Reload on tasks sync events. Resolves to the unsubscribe function. */
  subscribe(signal?: AbortSignal): Promise<() => void>;
}

let accountsTicket = 0;
let datedTicket = 0;
let dueTicket = 0;
const listTickets = new Map<string, number>();

/**
 * An optimistic change whose write hasn't settled. Every read of a list or the dated tasks
 * re-applies the ones still pending over what the cache returned, so a reload that one write
 * triggers never undoes another change still on its way to Google.
 */
interface PendingChange {
  /** The lists (`listKey`) it changes. */
  lists: string[];
  list(key: string, tasks: Task[]): Task[];
  dated(tasks: Task[]): Task[];
  due(tasks: Task[]): Task[];
}
const pending = new Set<PendingChange>();
const overList = (key: string, tasks: Task[]) =>
  [...pending].reduce((acc, p) => (p.lists.includes(key) ? p.list(key, acc) : acc), tasks);
const overDated = (tasks: Task[]) => [...pending].reduce((acc, p) => p.dated(acc), tasks);

/** Today in the computer's time zone, as the panel shows due dates. */
export const todayDate = () => dateOf(Date.now(), systemZone());
/** Still open and due by today: a change that completes or postpones a task takes it out. */
const stillDue = (tasks: Task[]) => {
  const today = todayDate();
  return tasks.filter((t) => !t.completed && t.due !== null && t.due <= today);
};
const overDue = (tasks: Task[]) => stillDue([...pending].reduce((acc, p) => p.due(acc), tasks));

/** A write Google refused: say why (it has been undone). */
function failed(title: string, e: unknown) {
  toast({ title, description: toCommandError(e).message, tone: "danger" });
}

export const useTasksStore = create<TasksState>((set, get) => {
  /**
   * Show `change` now and keep it over every read until `write` settles; then read again what it
   * touched (the cache now has what Google confirmed, or the old state).
   */
  const optimistic = async <T>(
    change: PendingChange,
    write: () => Promise<T>,
    reloadListIds: [string, ...string[]],
    accountId: string,
  ): Promise<T> => {
    set((s) => {
      const lists = { ...s.lists };
      for (const key of change.lists) if (lists[key]) lists[key] = change.list(key, lists[key]);
      return {
        lists,
        dated: s.dated ? change.dated(s.dated) : null,
        due: s.due ? stillDue(change.due(s.due)) : null,
      };
    });
    pending.add(change);
    try {
      return await write();
    } finally {
      pending.delete(change);
      await reload(accountId, ...reloadListIds);
    }
  };
  /** Change one task wherever it shows (its list and the calendar). */
  const patchChange = (task: Task, patch: Partial<Task>): PendingChange => {
    const key = taskKey(task);
    const apply = (t: Task) => (taskKey(t) === key ? { ...t, ...patch } : t);
    return {
      lists: [listKey(task.accountId, task.listId)],
      list: (_, tasks) => tasks.map(apply),
      dated: (tasks) => tasks.map(apply),
      due: (tasks) => tasks.map(apply),
    };
  };
  const setList = (accountId: string, listId: string, tasks: Task[]) =>
    set((s) => ({ lists: { ...s.lists, [listKey(accountId, listId)]: tasks } }));
  /** Read again what a write touched (the cache now has what Google confirmed, or the old state). */
  const reload = async (accountId: string, ...listIds: string[]) => {
    await Promise.all([
      ...listIds.map((id) => get().loadList(accountId, id)),
      reloadDated(),
      get().loadDue(),
    ]);
  };
  const reloadDated = () => {
    const range = get().datedFor;
    if (!range) return Promise.resolve();
    const [from, to] = range.split(":");
    return get().loadDated(from, to);
  };

  return {
    panelOpen: readPanelOpen(),
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

    setPanelOpen: (open) => {
      if (open === get().panelOpen) return;
      // Closing from the keyboard: leave the editor first, so its blur saves what was typed.
      const focused = globalThis.document?.activeElement;
      if (!open && focused instanceof HTMLElement && focused.closest("#tasks-panel"))
        focused.blur();
      set({ panelOpen: open, ...(open ? {} : { editing: null }) });
      writePanelOpen(open);
      if (open) {
        void get().loadAccounts();
        get().syncAll();
      }
    },
    togglePanel: () => get().setPanelOpen(!get().panelOpen),
    reveal: (task) => {
      get().setPanelOpen(true);
      set({ editing: taskKey(task) });
    },
    setEditing: (editing) => set({ editing }),

    loadAccounts: async () => {
      const ticket = ++accountsTicket;
      try {
        const accounts = (await getTasksAccounts()) ?? [];
        if (ticket !== accountsTicket) return;
        set({ accounts, accountsError: null });
        if (get().panelOpen)
          await Promise.all(
            accounts.flatMap((a) => a.lists.map((l) => get().loadList(a.accountId, l.id))),
          );
      } catch (e) {
        if (ticket === accountsTicket) {
          console.warn("couldn't read task lists", e);
          set({ accountsError: toCommandError(e).message });
        }
      }
    },

    loadList: async (accountId, listId) => {
      const key = listKey(accountId, listId);
      const ticket = (listTickets.get(key) ?? 0) + 1;
      listTickets.set(key, ticket);
      try {
        const tasks = (await getTasksInList(accountId, listId)) ?? [];
        if (listTickets.get(key) === ticket) {
          setList(accountId, listId, overList(key, tasks));
          set((s) => {
            if (!(key in s.listErrors)) return s;
            const listErrors = { ...s.listErrors };
            delete listErrors[key];
            return { listErrors };
          });
        }
      } catch (e) {
        console.warn("couldn't read tasks", e);
        if (listTickets.get(key) === ticket)
          set((s) => ({ listErrors: { ...s.listErrors, [key]: toCommandError(e).message } }));
      }
    },

    loadDated: async (from, to) => {
      const ticket = ++datedTicket;
      set({ datedFor: `${from}:${to}` });
      try {
        const dated = (await getDatedTasks(from, to)) ?? [];
        if (ticket === datedTicket) set({ dated: overDated(dated), datedError: null });
      } catch (e) {
        console.warn("couldn't read dated tasks", e);
        if (ticket !== datedTicket) return;
        set({ datedError: toCommandError(e).message });
        // The grid waits for tasks before it shows; don't keep it waiting.
        if (get().dated === null) set({ dated: [] });
      }
    },

    loadDue: async () => {
      const ticket = ++dueTicket;
      try {
        const due = (await getTasksDueThrough(todayDate())) ?? [];
        if (ticket === dueTicket) set({ due: overDue(due), dueError: null });
      } catch (e) {
        console.warn("couldn't read due tasks", e);
        if (ticket === dueTicket) set({ dueError: toCommandError(e).message });
      }
    },

    setDated: (from, to, dated) => {
      // Anything still reading the old days is out of date now.
      ++datedTicket;
      set({ dated: overDated(dated), datedFor: `${from}:${to}` });
    },

    syncAll: () => {
      for (const a of get().accounts ?? [])
        if (a.access.status === "on") void tasksSyncNow(a.accountId).catch(() => {});
    },

    setListHidden: async (accountId, listId, hidden) => {
      const patch = (value: boolean) =>
        set((s) => ({
          accounts:
            s.accounts?.map((a) =>
              a.accountId !== accountId
                ? a
                : {
                    ...a,
                    lists: a.lists.map((l) => (l.id === listId ? { ...l, hidden: value } : l)),
                  },
            ) ?? null,
        }));
      patch(hidden);
      try {
        await setTaskListHidden(accountId, listId, hidden);
      } catch (e) {
        patch(!hidden);
        failed("Couldn't change which tasks show", e);
        return;
      }
      await Promise.all([reloadDated(), get().loadDue()]);
    },

    addTask: async (accountId, listId, edit, placement) => {
      try {
        const ref = await createTask(
          accountId,
          listId,
          edit,
          placement?.parent ?? null,
          placement?.previous ?? null,
        );
        await reload(accountId, listId);
        return ref;
      } catch (e) {
        failed("Couldn't add the task", e);
        return null;
      }
    },

    editTask: async (task, edit) => {
      const patch: Partial<Task> = {};
      if (edit.title != null) patch.title = edit.title;
      if (edit.notes != null) patch.notes = edit.notes || null;
      if (edit.due != null) patch.due = edit.due || null;
      return optimistic(
        patchChange(task, patch),
        async () => {
          try {
            await updateTask(task.accountId, task.listId, task.id, edit);
            return true;
          } catch (e) {
            failed("Couldn't save the task", e);
            return false;
          }
        },
        [task.listId],
        task.accountId,
      );
    },

    setCompleted: (task, completed) =>
      optimistic(
        patchChange(task, { completed, completedAt: completed ? Date.now() : null }),
        async () => {
          try {
            await setTaskCompleted(task.accountId, task.listId, task.id, completed);
          } catch (e) {
            failed(completed ? "Couldn't complete the task" : "Couldn't reopen the task", e);
          }
        },
        [task.listId],
        task.accountId,
      ),

    deleteTask: (task) => {
      const gone = (t: Task) =>
        t.accountId === task.accountId &&
        t.listId === task.listId &&
        (t.id === task.id || t.parent === task.id);
      set((s) => ({ editing: s.editing === taskKey(task) ? null : s.editing }));
      return optimistic(
        {
          lists: [listKey(task.accountId, task.listId)],
          list: (_, tasks) => tasks.filter((t) => !gone(t)),
          dated: (tasks) => tasks.filter((t) => !gone(t)),
          due: (tasks) => tasks.filter((t) => !gone(t)),
        },
        async () => {
          try {
            await deleteTask(task.accountId, task.listId, task.id);
          } catch (e) {
            failed("Couldn't delete the task", e);
          }
        },
        [task.listId],
        task.accountId,
      );
    },

    moveTask: (task, placement) =>
      optimistic(
        {
          lists: [listKey(task.accountId, task.listId)],
          list: (_, tasks) => applyMove(tasks, task, placement),
          dated: (tasks) => tasks,
          due: (tasks) => tasks,
        },
        async () => {
          try {
            await moveTask(
              task.accountId,
              task.listId,
              task.id,
              placement.parent,
              placement.previous,
            );
          } catch (e) {
            failed("Couldn't move the task", e);
          }
        },
        [task.listId],
        task.accountId,
      ),

    moveToList: (task, listId) => {
      const from = listKey(task.accountId, task.listId);
      const to = listKey(task.accountId, listId);
      const inBlock = (t: Task) => t.id === task.id || t.parent === task.id;
      // Goes to the top of the other list, as on Google's side.
      const moved = (get().lists[from] ?? []).filter(inBlock).map((t) => ({
        ...t,
        listId,
        parent: t.id === task.id ? null : t.parent,
      }));
      const ids = new Set(moved.map((t) => t.id));
      set((s) => ({ editing: s.editing === taskKey(task) ? null : s.editing }));
      return optimistic(
        {
          lists: [from, to],
          list: (key, tasks) =>
            key === from
              ? tasks.filter((t) => !inBlock(t))
              : // Once Google has it, the cache already does: don't show it twice.
                [...moved, ...tasks.filter((t) => !ids.has(t.id))],
          dated: (tasks) => tasks,
          due: (tasks) => tasks,
        },
        async () => {
          try {
            await moveTaskToList(task.accountId, task.listId, task.id, listId);
          } catch (e) {
            failed("Couldn't move the task", e);
          }
        },
        [task.listId, listId],
        task.accountId,
      );
    },

    createList: async (accountId, title) => {
      try {
        await createTaskList(accountId, title);
        return true;
      } catch (e) {
        failed("Couldn't create the list", e);
        return false;
      } finally {
        await get().loadAccounts();
      }
    },

    renameList: async (accountId, listId, title) => {
      try {
        await renameTaskList(accountId, listId, title);
        return true;
      } catch (e) {
        failed("Couldn't rename the list", e);
        return false;
      } finally {
        await get().loadAccounts();
      }
    },

    deleteList: async (accountId, listId) => {
      try {
        await deleteTaskList(accountId, listId);
      } catch (e) {
        failed("Couldn't delete the list", e);
      } finally {
        await get().loadAccounts();
        await Promise.all([reloadDated(), get().loadDue()]);
      }
    },

    subscribe: (signal) =>
      subscribeAll(
        [
          () =>
            listen(TASKS_EVENTS.updated, () => {
              void get().loadAccounts();
              void reloadDated();
              void get().loadDue();
            }),
          () =>
            listen(TASKS_EVENTS.access, () => {
              void get().loadAccounts();
              void reloadDated();
              void get().loadDue();
            }),
        ],
        signal,
      ),
  };
});
