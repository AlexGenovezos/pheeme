// The Tasks panel at the right edge, in Mail and Calendar: every account's task lists, with tasks
// to add, edit (title, details, due date), tick off, delete, drag into order, indent into subtasks
// and move to another list, and lists to create, rename and delete. Completed tasks fold away
// under "Completed (N)". An account whose tasks can't be read says what it needs instead.
import { ChevronDown, ChevronRight, ListChecks, MoreHorizontal, Plus, X } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AllowButton, CheckAgain, openApiPage, TASKS_API_URL } from "../calendar/AccessControls";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { focusFromKeyboard } from "../keyboard/focus";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { showContextMenu } from "../lib/contextMenu";
import { createSubscriptionScope } from "../lib/subscriptions";
import { type Task, type TaskListInfo, type TasksAccount, tasksSyncNow } from "../lib/tauri";
import { cx } from "../lib/utils";
import { dragRegion } from "../shell/chrome";
import { useAccountStore } from "../store/accountStore";
import {
  dropPlacement,
  listKey,
  newTaskIn,
  newTaskKey,
  outlineRows,
  type Placement,
  splitCompleted,
  taskKey,
} from "./outline";
import { TaskEditor } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { TOGGLE_TASKS_COMMAND, TOGGLE_TASKS_SHORTCUT, useTasksStore } from "./tasksStore";
import { TodaySection } from "./TodaySection";
import { LoadError, SkeletonRows } from "./LoadStates";
import { PlanTodayHost } from "./PlanToday";
import "./tasks.css";

const store = useTasksStore.getState;

/** Load task lists for the connected accounts, and follow tasks sync. */
function useTasksData() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    void store().loadAccounts();
    void store().loadDue();
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
  // `tasks.focus` may have to open the panel first; the focus moves in once its tasks are drawn.
  const wantFocus = useRef(false);
  useCommands([
    {
      id: "tasks.focus",
      title: "Focus Tasks",
      group: "Navigation",
      keywords: ["tasks", "to-do", "todo", "panel", "google tasks"],
      global: true,
      run: () => {
        if (!store().panelOpen) {
          wantFocus.current = true;
          store().setPanelOpen(true);
        } else focusPanel();
      },
    },
  ]);
  useEffect(() => {
    if (!open || !wantFocus.current) return;
    let frame = 0;
    const focusWhenReady = () => {
      const panel = document.getElementById("tasks-panel");
      if (
        !panel ||
        panel.querySelector('.tasks-list[aria-hidden="true"], .task-row[aria-hidden="true"]')
      )
        return;
      wantFocus.current = false;
      unsubscribe();
      focusPanel();
    };
    const unsubscribe = useTasksStore.subscribe((state, previous) => {
      if (
        state.accounts === previous.accounts &&
        state.lists === previous.lists &&
        state.listErrors === previous.listErrors &&
        state.accountsError === previous.accountsError &&
        state.due === previous.due &&
        state.dueError === previous.dueError
      )
        return;
      // Subscribers run before React commits the rows.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(focusWhenReady);
    });
    focusWhenReady();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      wantFocus.current = false;
    };
  }, [open]);
  return (
    <>
      <PlanTodayHost />
      {open && <TasksPanel />}
      <div className="tasks-rail" {...dragRegion}>
        <IconButton
          label={open ? "Hide tasks" : "Show tasks"}
          data-command={TOGGLE_TASKS_COMMAND}
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

function focusPanel() {
  const panel = document.getElementById("tasks-panel");
  if (!panel) return;
  focusFromKeyboard(
    panel.querySelector<HTMLElement>('[aria-label^="Edit task: "]') ??
      panel.querySelector<HTMLElement>(".tasks-add") ??
      panel,
  );
}

function TasksPanel() {
  const accounts = useTasksStore((s) => s.accounts);
  const accountsError = useTasksStore((s) => s.accountsError);
  return (
    <aside
      id="tasks-panel"
      className="tasks-panel"
      aria-label="Tasks"
      tabIndex={-1}
      data-owns-keys=""
    >
      <div className="toolbar tasks-panel__head" {...dragRegion}>
        <h2 className="tasks-panel__title">Tasks</h2>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="Hide tasks" icon={<X />} onClick={() => store().setPanelOpen(false)} />
      </div>
      <div className="tasks-panel__scroll">
        <TodaySection />
        {accounts === null ? (
          accountsError ? (
            <LoadError message={accountsError} onRetry={() => void store().loadAccounts()} />
          ) : (
            <SkeletonList />
          )
        ) : (
          <>
            {accountsError && (
              <LoadError message={accountsError} onRetry={() => void store().loadAccounts()} />
            )}
            {accounts.map((a) => (
              <AccountTasks key={a.accountId} account={a} showEmail={accounts.length > 1} />
            ))}
          </>
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
          <TasksCheckAgain accountId={account.accountId} label="Check again" />
        </span>
      </div>
    );
  if (status === "error")
    return (
      <div className="tasks-access">
        <p>Couldn't update tasks: {message ?? "unknown error"}</p>
        <TasksCheckAgain accountId={account.accountId} label="Try again" />
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

function TasksCheckAgain({ accountId, label }: { accountId: string; label: string }) {
  return (
    <CheckAgain
      label={label}
      className="tasks-access__buttons"
      errorClassName="tasks-access__error"
      sync={() => tasksSyncNow(accountId)}
      reload={() => void store().loadAccounts()}
    />
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

const lastSubtask = (open: Task[], parent: string) =>
  open.filter((t) => t.parent === parent).pop()?.id ?? null;

function ListSection({ account, list }: { account: TasksAccount; list: TaskListInfo }) {
  const { accountId } = account;
  const tasks = useTasksStore((s) => s.lists[listKey(accountId, list.id)]);
  const listError = useTasksStore((s) => s.listErrors[listKey(accountId, list.id)]);
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
  const rows = useMemo(
    () => outlineRows(open, accountId, list.id, newTaskIn(editing, accountId, list.id)),
    [open, editing, accountId, list.id],
  );

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
      {listError && (
        <LoadError message={listError} onRetry={() => void store().loadList(accountId, list.id)} />
      )}
      {tasks === undefined ? (
        !listError && <SkeletonRows />
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
          {open.length === 0 && !adding && !listError && (
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
