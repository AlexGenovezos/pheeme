// Google Tasks state: every account's task lists and tasks access, the tasks of each list (read
// while the Tasks panel is open), the dated tasks of the days the calendar shows, and whether the
// panel is open (remembered across launches). Changes show at once and go straight to the Tasks
// API; one Google refuses snaps back and says why.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { subscribeAll } from "../lib/subscriptions";
import {
  createTask,
  createTaskList,
  deleteTask,
  deleteTaskList,
  getDatedTasks,
  getTasksAccounts,
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
const listTickets = new Map<string, number>();

/** A write Google refused: say why (it has been undone). */
function failed(title: string, e: unknown) {
  toast({ title, description: toCommandError(e).message, tone: "danger" });
}

export const useTasksStore = create<TasksState>((set, get) => {
  /** Change one task wherever it shows (its list and the calendar). */
  const patchTask = (task: Task, patch: Partial<Task>) => {
    const key = taskKey(task);
    const apply = (t: Task) => (taskKey(t) === key ? { ...t, ...patch } : t);
    set((s) => {
      const lk = listKey(task.accountId, task.listId);
      const list = s.lists[lk];
      return {
        lists: list ? { ...s.lists, [lk]: list.map(apply) } : s.lists,
        dated: s.dated?.map(apply) ?? null,
      };
    });
  };
  const setList = (accountId: string, listId: string, tasks: Task[]) =>
    set((s) => ({ lists: { ...s.lists, [listKey(accountId, listId)]: tasks } }));
  /** Read again what a write touched (the cache now has what Google confirmed, or the old state). */
  const reload = async (accountId: string, ...listIds: string[]) => {
    await Promise.all([...listIds.map((id) => get().loadList(accountId, id)), reloadDated()]);
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
        set({ accounts });
        if (get().panelOpen)
          await Promise.all(
            accounts.flatMap((a) => a.lists.map((l) => get().loadList(a.accountId, l.id))),
          );
      } catch (e) {
        if (ticket === accountsTicket) {
          console.warn("couldn't read task lists", e);
          if (get().accounts === null) set({ accounts: [] });
        }
      }
    },

    loadList: async (accountId, listId) => {
      const key = listKey(accountId, listId);
      const ticket = (listTickets.get(key) ?? 0) + 1;
      listTickets.set(key, ticket);
      try {
        const tasks = (await getTasksInList(accountId, listId)) ?? [];
        if (listTickets.get(key) === ticket) setList(accountId, listId, tasks);
      } catch (e) {
        console.warn("couldn't read tasks", e);
      }
    },

    loadDated: async (from, to) => {
      const ticket = ++datedTicket;
      set({ datedFor: `${from}:${to}` });
      try {
        const dated = (await getDatedTasks(from, to)) ?? [];
        if (ticket === datedTicket) set({ dated });
      } catch (e) {
        console.warn("couldn't read dated tasks", e);
        // The grid waits for tasks before it shows; don't keep it waiting.
        if (ticket === datedTicket && get().dated === null) set({ dated: [] });
      }
    },

    setDated: (from, to, dated) => {
      // Anything still reading the old days is out of date now.
      ++datedTicket;
      set({ dated, datedFor: `${from}:${to}` });
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
      await reloadDated();
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
      patchTask(task, patch);
      try {
        await updateTask(task.accountId, task.listId, task.id, edit);
        return true;
      } catch (e) {
        failed("Couldn't save the task", e);
        return false;
      } finally {
        await reload(task.accountId, task.listId);
      }
    },

    setCompleted: async (task, completed) => {
      patchTask(task, { completed, completedAt: completed ? Date.now() : null });
      try {
        await setTaskCompleted(task.accountId, task.listId, task.id, completed);
      } catch (e) {
        failed(completed ? "Couldn't complete the task" : "Couldn't reopen the task", e);
      } finally {
        await reload(task.accountId, task.listId);
      }
    },

    deleteTask: async (task) => {
      const lk = listKey(task.accountId, task.listId);
      const gone = (t: Task) =>
        t.accountId === task.accountId &&
        t.listId === task.listId &&
        (t.id === task.id || t.parent === task.id);
      set((s) => ({
        lists: s.lists[lk] ? { ...s.lists, [lk]: s.lists[lk].filter((t) => !gone(t)) } : s.lists,
        dated: s.dated?.filter((t) => !gone(t)) ?? null,
        editing: s.editing === taskKey(task) ? null : s.editing,
      }));
      try {
        await deleteTask(task.accountId, task.listId, task.id);
      } catch (e) {
        failed("Couldn't delete the task", e);
      } finally {
        await reload(task.accountId, task.listId);
      }
    },

    moveTask: async (task, placement) => {
      const lk = listKey(task.accountId, task.listId);
      const list = get().lists[lk];
      if (list) setList(task.accountId, task.listId, applyMove(list, task, placement));
      try {
        await moveTask(task.accountId, task.listId, task.id, placement.parent, placement.previous);
      } catch (e) {
        failed("Couldn't move the task", e);
      } finally {
        await reload(task.accountId, task.listId);
      }
    },

    moveToList: async (task, listId) => {
      const from = listKey(task.accountId, task.listId);
      const to = listKey(task.accountId, listId);
      const s = get();
      const block = (s.lists[from] ?? []).filter((t) => t.id === task.id || t.parent === task.id);
      // Goes to the top of the other list, as on Google's side.
      set({
        lists: {
          ...s.lists,
          [from]: (s.lists[from] ?? []).filter((t) => !block.includes(t)),
          ...(s.lists[to]
            ? {
                [to]: [
                  ...block.map((t) => ({
                    ...t,
                    listId,
                    parent: t.id === task.id ? null : t.parent,
                  })),
                  ...s.lists[to],
                ],
              }
            : {}),
        },
        editing: s.editing === taskKey(task) ? null : s.editing,
      });
      try {
        await moveTaskToList(task.accountId, task.listId, task.id, listId);
      } catch (e) {
        failed("Couldn't move the task", e);
      } finally {
        await reload(task.accountId, task.listId, listId);
      }
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
        await reloadDated();
      }
    },

    subscribe: (signal) =>
      subscribeAll(
        [
          () =>
            listen(TASKS_EVENTS.updated, () => {
              void get().loadAccounts();
              void reloadDated();
            }),
          () =>
            listen(TASKS_EVENTS.access, () => {
              void get().loadAccounts();
              void reloadDated();
            }),
        ],
        signal,
      ),
  };
});
