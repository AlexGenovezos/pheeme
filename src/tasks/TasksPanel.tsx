// The Tasks panel at the right edge, in Mail and Calendar: every account's task lists, with tasks
// to add, edit (title, details, due date), tick off, delete, drag into order, indent into subtasks
// and move to another list, and lists to create, rename and delete. Completed tasks fold away
// under "Completed (N)". An account whose tasks can't be read says what it needs instead.
import {
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListChecks,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AllowButton, openApiPage, TASKS_API_URL } from "../calendar/AccessControls";
import { dateOf, systemZone } from "../calendar/dates";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { useKeybinding } from "../keyboard/useCommands";
import {
  type ContextMenuItem,
  openContextMenuFromEvent,
  showContextMenu,
} from "../lib/contextMenu";
import { createSubscriptionScope } from "../lib/subscriptions";
import {
  type Task,
  type TaskEdit,
  type TaskListInfo,
  type TasksAccount,
  tasksSyncNow,
  toCommandError,
} from "../lib/tauri";
import { cx } from "../lib/utils";
import { dragRegion } from "../shell/chrome";
import { useAccountStore } from "../store/accountStore";
import {
  applyMove,
  dropPlacement,
  dueLabel,
  indentPlacement,
  listKey,
  newTaskIn,
  newTaskKey,
  outdentPlacement,
  type Placement,
  splitCompleted,
  stepPlacement,
  taskKey,
  taskTitle,
} from "./outline";
import { TOGGLE_TASKS_COMMAND, TOGGLE_TASKS_SHORTCUT, useTasksStore } from "./tasksStore";
import "./tasks.css";

const store = useTasksStore.getState;
const today = () => dateOf(Date.now(), systemZone());

/** Load task lists for the connected accounts, and follow tasks sync. */
function useTasksData() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    void store().loadAccounts();
  }, [accountIds]);
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope
      .add((signal) => store().subscribe(signal))
      .catch((err: unknown) => console.warn("tasks event listener failed", err));
    // Open from the last session: fetch the latest from Google once.
    if (store().panelOpen)
      void store()
        .loadAccounts()
        .then(() => store().syncAll());
    return scope.dispose;
  }, []);
}

/** The panel (when open) and the rail with its toggle, at the right edge of the window. */
export function TasksPanelHost() {
  useTasksData();
  const open = useTasksStore((s) => s.panelOpen);
  const shortcut = useKeybinding(TOGGLE_TASKS_COMMAND, TOGGLE_TASKS_SHORTCUT);
  return (
    <>
      {open && <TasksPanel />}
      <div className="tasks-rail" {...dragRegion}>
        <IconButton
          label={open ? "Hide tasks" : "Show tasks"}
          shortcut={shortcut}
          aria-pressed={open}
          aria-controls={open ? "tasks-panel" : undefined}
          icon={<ListChecks />}
          onClick={() => store().togglePanel()}
        />
      </div>
    </>
  );
}

function TasksPanel() {
  const accounts = useTasksStore((s) => s.accounts);
  return (
    <aside id="tasks-panel" className="tasks-panel" aria-label="Tasks" data-owns-keys="">
      <div className="toolbar tasks-panel__head" {...dragRegion}>
        <h2 className="tasks-panel__title">Tasks</h2>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="Hide tasks" icon={<X />} onClick={() => store().setPanelOpen(false)} />
      </div>
      <div className="tasks-panel__scroll">
        {accounts === null ? (
          <SkeletonList />
        ) : (
          accounts.map((a) => (
            <AccountTasks key={a.accountId} account={a} showEmail={accounts.length > 1} />
          ))
        )}
      </div>
    </aside>
  );
}

function SkeletonList() {
  return (
    <div className="tasks-list" aria-hidden="true">
      <div className="tasks-list__head">
        <Skeleton width="40%" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="task-row">
          <Skeleton shape="circle" className="task-row__skeleton-check" />
          <Skeleton width={`${70 - i * 15}%`} />
        </div>
      ))}
    </div>
  );
}

function AccountTasks({ account, showEmail }: { account: TasksAccount; showEmail: boolean }) {
  const on = account.access.status === "on";
  return (
    <section className="tasks-account" aria-label={account.email}>
      {showEmail && (
        <h3 className="tasks-account__email" title={account.email}>
          {account.email}
        </h3>
      )}
      {on ? (
        <>
          {account.lists.map((l) => (
            <ListSection key={l.id} account={account} list={l} />
          ))}
          <NewList accountId={account.accountId} />
        </>
      ) : (
        <AccessGuide account={account} />
      )}
    </section>
  );
}

/** What an account needs before its tasks show: access, the Tasks API, or another try. */
function AccessGuide({ account }: { account: TasksAccount }) {
  const { status, message, enableUrl } = account.access;
  if (status === "api_disabled")
    return (
      <div className="tasks-access">
        <p>
          The Google Tasks API is off in your Google Cloud project. Turn it on (check it's the
          project you made for Pheeme, then click Enable), then check again.
        </p>
        <span className="tasks-access__buttons">
          <Button size="sm" onClick={() => openApiPage(enableUrl ?? TASKS_API_URL)}>
            Turn on the Tasks API
          </Button>
          <CheckAgain accountId={account.accountId} label="Check again" />
        </span>
      </div>
    );
  if (status === "error")
    return (
      <div className="tasks-access">
        <p>Couldn't update tasks: {message ?? "unknown error"}</p>
        <CheckAgain accountId={account.accountId} label="Try again" />
      </div>
    );
  return (
    <div className="tasks-access">
      <p>
        Allow access to see and change this account's tasks. Google asks once for your calendar and
        tasks together.
      </p>
      <AllowButton account={account} />
    </div>
  );
}

function CheckAgain({ accountId, label }: { accountId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await tasksSyncNow(accountId);
    } catch (e) {
      setError(toCommandError(e).message);
    } finally {
      setBusy(false);
      void store().loadAccounts();
    }
  };
  return (
    <span className="tasks-access__buttons">
      <Button size="sm" disabled={busy} onClick={() => void check()}>
        {busy ? "Checking…" : label}
      </Button>
      {error && (
        <span className="tasks-access__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** "Create new list": a button that turns into a name field. */
function NewList({ accountId }: { accountId: string }) {
  const [naming, setNaming] = useState(false);
  if (!naming)
    return (
      <button type="button" className="tasks-new-list" onClick={() => setNaming(true)}>
        <Plus aria-hidden="true" />
        Create new list
      </button>
    );
  return (
    <NameField
      label="New list name"
      initial=""
      onDone={async (title) => {
        setNaming(false);
        if (title) await store().createList(accountId, title);
      }}
    />
  );
}

/** A one-line name field: Enter or leaving it saves, Escape cancels (`onDone(null)`). */
function NameField({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  onDone(title: string | null): void | Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    void onDone(title);
  };
  return (
    <input
      autoFocus
      className="tasks-name-field"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value.trim() || null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** An item in the list as drawn: a task, or the field for a new one. */
type Row = { kind: "task"; task: Task } | { kind: "new"; placement: Placement };

const NEW_ID = "\u0000new";

const lastSubtask = (open: Task[], parent: string) =>
  open.filter((t) => t.parent === parent).pop()?.id ?? null;

function ListSection({ account, list }: { account: TasksAccount; list: TaskListInfo }) {
  const { accountId } = account;
  const tasks = useTasksStore((s) => s.lists[listKey(accountId, list.id)]);
  const editing = useTasksStore((s) => s.editing);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [dragged, setDragged] = useState<Task | null>(null);
  const [drop, setDrop] = useState<{ id: string; half: "before" | "after" } | null>(null);
  const { open, completed } = useMemo(() => splitCompleted(tasks ?? []), [tasks]);
  const adding = newTaskIn(editing, accountId, list.id);
  // A completed task opened from the calendar shows its editor, so Completed opens for it.
  const completedShown = showCompleted || completed.some((t) => taskKey(t) === editing);
  const otherLists = account.lists.filter((l) => l.id !== list.id);

  // Where the new-task field sits: placed like a task, so it shows where the task will land.
  const rows: Row[] = useMemo(() => {
    const placement = newTaskIn(editing, accountId, list.id);
    if (!placement) return open.map((task) => ({ kind: "task", task }));
    const marker: Task = {
      accountId,
      listId: list.id,
      id: NEW_ID,
      parent: placement.parent,
      title: "",
      notes: null,
      due: null,
      completed: false,
      completedAt: null,
      hidden: false,
      updatedAt: 0,
      webViewLink: null,
    };
    return applyMove([...open, marker], marker, placement).map((t) =>
      t.id === NEW_ID ? { kind: "new", placement } : { kind: "task", task: t },
    );
  }, [open, editing, accountId, list.id]);

  const startAdding = (placement: Placement = { parent: null, previous: null }) =>
    store().setEditing(newTaskKey(accountId, list.id, placement));

  const listMenu = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      [
        { id: "rename", label: "Rename list", onSelect: () => setRenaming(true) },
        { type: "separator" },
        {
          id: "delete",
          label: "Delete list",
          danger: true,
          onSelect: () => setConfirmDelete(true),
        },
      ],
      { x: r.left, y: r.bottom },
    );
  };

  // Dragging by the grip uses pointer events, not HTML5 drag and drop: the desktop app keeps the
  // webview's native file drop on (compose attachments), which swallows HTML5 drags on Windows.
  const sectionRef = useRef<HTMLElement>(null);
  const startDrag = (task: Task) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    try {
      // Keeps the moves and the release coming to the grip wherever the pointer goes.
      grip.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events): the drag still works over the list.
    }
    setDragged(task);
    let landing: Placement | null = null;
    const over = (ev: PointerEvent) => {
      const li = document
        .elementFromPoint?.(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("li[data-task-id]");
      const target =
        li && sectionRef.current?.contains(li) && open.find((t) => t.id === li.dataset.taskId);
      if (!li || !target) return { drop: null, placement: null };
      const r = li.getBoundingClientRect();
      const half: "before" | "after" = ev.clientY < r.top + r.height / 2 ? "before" : "after";
      const placement = dropPlacement(open, task, target, half);
      return { drop: placement ? { id: target.id, half } : null, placement };
    };
    const move = (ev: PointerEvent) => {
      const at = over(ev);
      landing = at.placement;
      setDrop(at.drop);
    };
    const end = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      grip.removeEventListener("lostpointercapture", end);
      setDragged(null);
      setDrop(null);
      if (ev.type === "pointerup" && landing) void store().moveTask(task, landing);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("lostpointercapture", end);
  };

  const titleId = `tasks-list-${accountId}-${list.id}`;
  return (
    <section ref={sectionRef} className="tasks-list" aria-labelledby={titleId}>
      <div className="tasks-list__head">
        {renaming ? (
          <NameField
            label="List name"
            initial={list.title}
            onDone={async (title) => {
              setRenaming(false);
              if (title && title !== list.title)
                await store().renameList(accountId, list.id, title);
            }}
          />
        ) : (
          <h4 id={titleId} className="tasks-list__title" title={list.title}>
            {list.title}
          </h4>
        )}
        <IconButton
          size="sm"
          label={`List options: ${list.title}`}
          icon={<MoreHorizontal />}
          onClick={listMenu}
        />
      </div>
      {confirmDelete && (
        <div className="tasks-confirm" role="group" aria-label="Delete list">
          <p>
            Delete “{list.title}”
            {tasks && tasks.length > 0
              ? ` and its ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`
              : ""}
            ? This deletes it in Google Tasks too.
          </p>
          <span className="tasks-access__buttons">
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                void store().deleteList(accountId, list.id);
              }}
            >
              Delete list
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </span>
        </div>
      )}
      <button type="button" className="tasks-add" onClick={() => startAdding()}>
        <Plus aria-hidden="true" />
        Add a task
      </button>
      {tasks === undefined ? (
        [0, 1].map((i) => (
          <div key={i} className="task-row" aria-hidden="true">
            <Skeleton shape="circle" className="task-row__skeleton-check" />
            <Skeleton width={`${60 - i * 20}%`} />
          </div>
        ))
      ) : (
        <ul className="tasks-list__items" aria-label={`${list.title} tasks`}>
          {rows.map((row) =>
            row.kind === "new" ? (
              <li
                key={newTaskKey(accountId, list.id, row.placement)}
                className={cx(row.placement.parent && "task-row--sub")}
              >
                <TaskEditor accountId={accountId} listId={list.id} placement={row.placement} />
              </li>
            ) : (
              <li
                key={row.task.id}
                className={cx(
                  row.task.parent && "task-row--sub",
                  drop?.id === row.task.id && `task-row--drop-${drop.half}`,
                  dragged?.id === row.task.id && "task-row--dragging",
                )}
                data-task-id={row.task.id}
              >
                {editing === taskKey(row.task) ? (
                  <TaskEditor accountId={accountId} listId={list.id} task={row.task} />
                ) : (
                  <TaskRow
                    task={row.task}
                    open={open}
                    otherLists={otherLists}
                    onGripPointerDown={startDrag(row.task)}
                    onAddSubtask={() =>
                      startAdding({
                        parent: row.task.id,
                        previous: lastSubtask(open, row.task.id),
                      })
                    }
                  />
                )}
              </li>
            ),
          )}
          {open.length === 0 && !adding && (
            <li className="tasks-list__empty">
              {completed.length > 0 ? "All tasks complete" : "No tasks yet"}
            </li>
          )}
        </ul>
      )}
      {completed.length > 0 && (
        <>
          <button
            type="button"
            className="tasks-completed"
            aria-expanded={completedShown}
            onClick={() => setShowCompleted(!completedShown)}
          >
            {completedShown ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
            Completed ({completed.length})
          </button>
          {completedShown && (
            <ul className="tasks-list__items" aria-label={`${list.title} completed tasks`}>
              {completed.map((t) => (
                <li key={t.id}>
                  {editing === taskKey(t) ? (
                    <TaskEditor accountId={accountId} listId={list.id} task={t} />
                  ) : (
                    <TaskRow task={t} open={open} otherLists={otherLists} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function TaskRow({
  task,
  open,
  otherLists,
  onAddSubtask,
  onGripPointerDown,
}: {
  task: Task;
  /** The list's open tasks, for indenting and moving. */
  open: Task[];
  otherLists: TaskListInfo[];
  onAddSubtask?: () => void;
  /** Starts dragging the task into another place. */
  onGripPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const title = taskTitle(task);
  const now = today();
  const move = (p: Placement | null) => p && void store().moveTask(task, p);
  const indent = task.completed ? null : indentPlacement(open, task);
  const outdent = task.completed ? null : outdentPlacement(task);
  const up = task.completed ? null : stepPlacement(open, task, -1);
  const down = task.completed ? null : stepPlacement(open, task, 1);

  const items: ContextMenuItem[] = [
    ...(task.completed
      ? []
      : ([
          ...(onAddSubtask && !task.parent
            ? [{ id: "subtask", label: "Add a subtask", onSelect: onAddSubtask }]
            : []),
          { id: "indent", label: "Indent", disabled: !indent, onSelect: () => move(indent) },
          { id: "outdent", label: "Outdent", disabled: !outdent, onSelect: () => move(outdent) },
          { id: "up", label: "Move up", disabled: !up, onSelect: () => move(up) },
          { id: "down", label: "Move down", disabled: !down, onSelect: () => move(down) },
        ] satisfies ContextMenuItem[])),
    ...(otherLists.length > 0 && !task.parent
      ? ([
          { type: "separator" },
          ...otherLists.map((l) => ({
            id: `move-${l.id}`,
            label: `Move to ${l.title}`,
            onSelect: () => void store().moveToList(task, l.id),
          })),
        ] satisfies ContextMenuItem[])
      : []),
    { type: "separator" },
    { id: "delete", label: "Delete", danger: true, onSelect: () => void store().deleteTask(task) },
  ];

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    let placement: Placement | null = null;
    if (mod && e.key === "]") placement = indent;
    else if (mod && e.key === "[") placement = outdent;
    else if (mod && e.key === "ArrowUp") placement = up;
    else if (mod && e.key === "ArrowDown") placement = down;
    else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      void store().deleteTask(task);
      return;
    } else return;
    e.preventDefault();
    move(placement);
  };

  return (
    <div
      className={cx("task-row", task.completed && "task-row--done")}
      onContextMenu={(e) => openContextMenuFromEvent(e, items)}
      onKeyDown={onKeyDown}
    >
      {!task.completed && (
        <span className="task-row__grip" aria-hidden="true" onPointerDown={onGripPointerDown}>
          <GripVertical />
        </span>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={task.completed}
        aria-label={task.completed ? `Mark not done: ${title}` : `Mark done: ${title}`}
        className="task-check"
        onClick={() => void store().setCompleted(task, !task.completed)}
      >
        <span className="task-check__ring">
          <Check aria-hidden="true" />
        </span>
      </button>
      <button
        type="button"
        className="task-row__main"
        aria-label={`Edit task: ${title}`}
        onClick={() => store().setEditing(taskKey(task))}
      >
        <span className="task-row__title">{title}</span>
        {task.notes && <span className="task-row__notes">{task.notes}</span>}
        {task.due && (
          <span
            className={cx(
              "task-row__due",
              !task.completed && task.due < now && "task-row__due--overdue",
            )}
          >
            {dueLabel(task.due, now)}
          </span>
        )}
      </button>
      <IconButton
        size="sm"
        className="task-row__menu"
        label={`Task options: ${title}`}
        icon={<MoreHorizontal />}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void showContextMenu(items, { x: r.left, y: r.bottom });
        }}
      />
    </div>
  );
}

/**
 * A task's title, details and due date, edited in place. Enter in the title or leaving the editor
 * saves (a new task's Enter opens another one under it); Escape saves and closes, as in Google
 * Tasks. An empty new task is dropped.
 */
function TaskEditor({
  accountId,
  listId,
  task,
  placement,
}: {
  accountId: string;
  listId: string;
  task?: Task;
  placement?: Placement;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [due, setDue] = useState(task?.due ?? "");
  const done = useRef(false);
  const dateRef = useRef<HTMLInputElement>(null);

  const save = async (another: boolean) => {
    if (done.current) return;
    done.current = true;
    const close = () => {
      if (useTasksStore.getState().editing === current) store().setEditing(null);
    };
    if (task) {
      const edit: TaskEdit = {};
      if (title !== task.title) edit.title = title;
      if (notes !== (task.notes ?? "")) edit.notes = notes;
      if (due !== (task.due ?? "")) edit.due = due;
      close();
      if (Object.keys(edit).length > 0) await store().editTask(task, edit);
      return;
    }
    if (!title.trim() && !notes.trim() && !due) return close();
    const edit: TaskEdit = { title: title.trim() };
    if (notes.trim()) edit.notes = notes;
    if (due) edit.due = due;
    const created = await store().addTask(accountId, listId, edit, placement);
    if (another && created && useTasksStore.getState().editing === current)
      store().setEditing(
        newTaskKey(accountId, listId, { parent: placement?.parent ?? null, previous: created.id }),
      );
    else close();
  };
  const current = task
    ? taskKey(task)
    : newTaskKey(accountId, listId, placement ?? { parent: null, previous: null });

  const onBlur = (e: FocusEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void save(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void save(false);
    }
  };

  return (
    <form
      className="task-editor"
      aria-label={task ? `Edit task: ${taskTitle(task)}` : "New task"}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save(!task);
      }}
    >
      <span className="task-check task-check--placeholder" aria-hidden="true">
        <span className="task-check__ring" />
      </span>
      <div className="task-editor__fields">
        <input
          autoFocus
          className="task-editor__title"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <textarea
          className="task-editor__notes"
          aria-label="Details"
          placeholder="Details"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <span className="task-editor__due">
          <input
            ref={dateRef}
            type="date"
            className="task-editor__date"
            aria-label="Due date"
            value={due}
            onChange={(e) => setDue(e.currentTarget.value)}
          />
          <IconButton
            size="sm"
            label="Remove due date"
            icon={<X />}
            disabled={!due}
            onClick={() => {
              setDue("");
              dateRef.current?.focus();
            }}
          />
        </span>
        {/* Enter submits from the title; the button is for pointer users. */}
        <span className="task-editor__actions">
          <Button type="submit" size="sm" variant="primary">
            {task ? "Done" : "Add"}
          </Button>
        </span>
      </div>
    </form>
  );
}
