import { call } from "./call";

/** Whether an account's tasks can be read, apart from its calendar access. */
export interface TasksAccess {
  /** `unknown` (never checked), `on`, `missing_scope` (allow calendar access), `api_disabled` (turn on the Tasks API) or `error`. */
  status: "unknown" | "on" | "missing_scope" | "api_disabled" | "error";
  /** What failed, for `error`. */
  message: string | null;
  /** The Tasks API page for the user's Google Cloud project, for `api_disabled`. */
  enableUrl: string | null;
  syncedAt: number | null;
}

export interface TaskListInfo {
  id: string;
  title: string;
  /** Unticked in the sidebar: its dated tasks stay off the calendar (local only). */
  hidden: boolean;
}

export interface TasksAccount {
  accountId: string;
  email: string;
  access: TasksAccess;
  /** In Google's order. */
  lists: TaskListInfo[];
}

export interface Task {
  accountId: string;
  listId: string;
  id: string;
  /** The parent task, for a subtask (Google Tasks nests one level deep). */
  parent: string | null;
  title: string;
  notes: string | null;
  /** `YYYY-MM-DD`; Google Tasks has no due times. */
  due: string | null;
  completed: boolean;
  /** When it was completed (UTC ms). */
  completedAt: number | null;
  /** Completed and cleared from the list's view. */
  hidden: boolean;
  updatedAt: number;
  webViewLink: string | null;
}

/** Changes to a task: an omitted (or null) field stays as it is; `""` clears notes or the due date. */
export interface TaskEdit {
  title?: string | null;
  notes?: string | null;
  /** `YYYY-MM-DD`. */
  due?: string | null;
}

/** Where a written task lives. */
export interface TaskRef {
  accountId: string;
  listId: string;
  id: string;
}

export interface TaskListRef {
  accountId: string;
  listId: string;
}

/** Every account with its tasks access and task lists (local). */
export const getTasksAccounts = () => call("tasks_accounts");
/** A list's tasks in the order the list shows them, each subtask right after its parent (local). */
export const getTasksInList = (accountId: string, listId: string) =>
  call("tasks_in_list", { accountId, listId });
/** Every account's tasks due on `[fromDate, toDate)` (`YYYY-MM-DD`) in shown lists, by date (local). */
export const getDatedTasks = (fromDate: string, toDate: string) =>
  call("dated_tasks", { fromDate, toDate });
/** Every account's open tasks due on or before `throughDate` (`YYYY-MM-DD`) in shown lists, by date (local). */
export const getTasksDueThrough = (throughDate: string) =>
  call("tasks_due_through", { throughDate });
/** Show or hide a list's dated tasks on the calendar (local). */
export const setTaskListHidden = (accountId: string, listId: string, hidden: boolean) =>
  call("set_task_list_hidden", { accountId, listId, hidden });
/** Sync the account's tasks now (after turning the Tasks API on, or "Check again"). */
export const tasksSyncNow = (accountId: string) => call("tasks_sync_now", { accountId });
/** Add a task under `parent` (top level when null), right after `previous` (first when null). */
export const createTask = (
  accountId: string,
  listId: string,
  edit: TaskEdit,
  parent: string | null = null,
  previous: string | null = null,
) => call("create_task", { accountId, listId, edit, parent, previous });
/** Change a task's title, details or due date. */
export const updateTask = (accountId: string, listId: string, taskId: string, edit: TaskEdit) =>
  call("update_task", { accountId, listId, taskId, edit });
/** Tick a task off, or back on. */
export const setTaskCompleted = (
  accountId: string,
  listId: string,
  taskId: string,
  completed: boolean,
) => call("set_task_completed", { accountId, listId, taskId, completed });
/** Delete a task with its subtasks. */
export const deleteTask = (accountId: string, listId: string, taskId: string) =>
  call("delete_task", { accountId, listId, taskId });
/** Reorder (`previous`), indent (`parent` set) or outdent (`parent` null) a task within its list. */
export const moveTask = (
  accountId: string,
  listId: string,
  taskId: string,
  parent: string | null,
  previous: string | null,
) => call("move_task", { accountId, listId, taskId, parent, previous });
/** Move a task (with its subtasks) to the top of another list of the same account. */
export const moveTaskToList = (
  accountId: string,
  listId: string,
  taskId: string,
  destinationListId: string,
) => call("move_task_to_list", { accountId, listId, taskId, destinationListId });
export const createTaskList = (accountId: string, title: string) =>
  call("create_task_list", { accountId, title });
export const renameTaskList = (accountId: string, listId: string, title: string) =>
  call("rename_task_list", { accountId, listId, title });
/** Delete a task list with all its tasks. */
export const deleteTaskList = (accountId: string, listId: string) =>
  call("delete_task_list", { accountId, listId });
