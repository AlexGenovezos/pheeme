// Plan today: once a day, every open task due today or earlier gets a decision, one at a time,
// overdue ones first. Each decision (Today, Tomorrow, Pick a day, Book a time, Done, Drop) is a
// button with a single key and writes through the tasks store at once, then the next task shows.
// It opens on its own the first time the window is used each day, only with something to decide.
import { forwardRef, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { displayZone, useCalendarStore, weekStartOf } from "../calendar/calendarStore";
import { addDays, dateOf, formatTime } from "../calendar/dates";
import { Button } from "../components/ui/Button";
import { DateField, formatDateValue } from "../components/ui/DateField";
import { Kbd } from "../components/ui/Kbd";
import { toast } from "../components/ui/Toast";
import { trapTab, useDialogFocus } from "../components/ui/useDialogFocus";
import { sameShortcut, stepFromEvent } from "../keyboard/bindings";
import { registry } from "../keyboard/registry";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { createSubscriptionScope } from "../lib/subscriptions";
import { listen, type Task, TASKS_EVENTS } from "../lib/tauri";
import { cx } from "../lib/utils";
import { taskTitle } from "./outline";
import { lateness, planQueue, readPlanned, shouldAutoOpen, taskForBlock } from "./plan";
import { bookTask, PLAN_TODAY_COMMAND, usePlanStore } from "./planStore";
import { todayDate, useTasksStore } from "./tasksStore";
import "../components/ui/Surface.css";
import "./tasks.css";

type Decision = "today" | "tomorrow" | "pickDay" | "book" | "done" | "drop";

/** The decisions, as commands (their keys can be rebound) and buttons, in button order. */
const DECISIONS: { id: string; decision: Decision; label: string }[] = [
  { id: "plan.today", decision: "today", label: "Today" },
  { id: "plan.tomorrow", decision: "tomorrow", label: "Tomorrow" },
  { id: "plan.pickDay", decision: "pickDay", label: "Pick a day" },
  { id: "plan.book", decision: "book", label: "Book a time" },
  { id: "plan.done", decision: "done", label: "Done" },
  { id: "plan.drop", decision: "drop", label: "Drop" },
];

const plan = usePlanStore.getState;
const tasksStore = useTasksStore.getState;

/** Opens the plan on its own when it should, and shows it while it's open. Always mounted. */
export function PlanTodayHost() {
  const open = usePlanStore((s) => s.open);
  const loaded = useTasksStore((s) => s.due !== null);
  useCommands([
    {
      id: PLAN_TODAY_COMMAND,
      title: "Plan today",
      group: "Tasks",
      keywords: ["tasks", "overdue", "due", "today", "plan", "review"],
      global: true,
      run: () => void plan().openPlan(),
    },
  ]);

  // At launch, once the due tasks are read and again after the first tasks sync (the cache may
  // have been empty or a day behind); then whenever the window comes back (past midnight, that's a
  // new day to plan). Not on every change: a task synced in mid-day doesn't pop it up.
  useEffect(() => {
    if (loaded) autoOpen();
  }, [loaded]);
  useEffect(() => {
    let synced = false;
    const scope = createSubscriptionScope();
    scope
      .add(() =>
        listen(TASKS_EVENTS.updated, () => {
          if (synced) return;
          synced = true;
          void tasksStore().loadDue().then(autoOpen);
        }),
      )
      .catch((err: unknown) => console.warn("plan today listener failed", err));
    return scope.dispose;
  }, []);
  useEffect(() => {
    const onFocus = () => {
      if (readPlanned() === todayDate()) return;
      void tasksStore().loadDue().then(autoOpen);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return open ? createPortal(<PlanToday />, document.body) : null;
}

function autoOpen() {
  const { due } = tasksStore();
  const today = todayDate();
  if (due && !plan().open && shouldAutoOpen(readPlanned(), today, planQueue(due, today)))
    void plan().openPlan();
}

function PlanToday() {
  const ref = useRef<HTMLDivElement>(null);
  const queue = usePlanStore((s) => s.queue);
  const index = usePlanStore((s) => s.index);
  const task: Task | undefined = queue[index];
  const [picking, setPicking] = useState<"pickDay" | "book" | null>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(ref);
  const close = () => plan().close();

  useEffect(() => {
    if (picking) pickRef.current?.focus();
  }, [picking]);

  const decide = (decision: Decision, date?: string) => {
    if (!task) return;
    if ((decision === "pickDay" || decision === "book") && !date) {
      setPicking(decision);
      return;
    }
    const today = todayDate();
    const store = tasksStore();
    const moveTo = (day: string) => {
      if (task.due !== day) void store.editTask(task, { due: day });
    };
    if (decision === "today") moveTo(today);
    else if (decision === "tomorrow") moveTo(addDays(today, 1));
    else if (decision === "pickDay") moveTo(date!);
    else if (decision === "book") void bookTask(task, date!);
    else if (decision === "done") void store.setCompleted(task, true);
    else drop(task);
    // The date field goes away: keep the keys on the dialog.
    if (picking) ref.current?.focus();
    setPicking(null);
    plan().next();
  };

  useCommands(
    DECISIONS.map((d) => ({
      id: d.id,
      title: `Plan today: ${d.label}`,
      group: "Tasks",
      hidden: true,
      run: () => decide(d.decision),
    })),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys belong to the dialog (the app's shortcuts are suspended while it's open).
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (picking) {
        setPicking(null);
        ref.current?.focus();
      } else close();
      return;
    }
    if (e.key === "Tab") return trapTab(e, ref.current);
    if (!task) {
      if (e.key === "Enter") {
        e.preventDefault();
        close();
      }
      return;
    }
    // Held down, a key would decide on task after task: that's the pile growing again.
    if (e.repeat) return;
    const step = stepFromEvent(e);
    const hit = DECISIONS.find((d) => sameShortcut(step, registry.shortcutFor(d.id) ?? null));
    if (!hit) return;
    e.preventDefault();
    decide(hit.decision);
  };

  return (
    <div
      className="plan-scrim dialog-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={ref}
        className="plan dialog-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Plan today"
        tabIndex={-1}
        data-owns-keys=""
        onKeyDown={onKeyDown}
      >
        <header className="plan__head">
          <h2 className="plan__heading">Plan today</h2>
          {task && (
            <span className="plan__progress">
              {index + 1} of {queue.length}
            </span>
          )}
        </header>
        {task ? (
          <>
            <TaskCard task={task} />
            <div className="plan__pick">
              {picking && (
                <>
                  <span className="plan__pick-label">
                    {picking === "book" ? "Book on" : "Move to"}
                  </span>
                  <PickDay ref={pickRef} kind={picking} onPick={(date) => decide(picking, date)} />
                </>
              )}
            </div>
            <div className="plan__decisions" role="group" aria-label="Decide">
              {DECISIONS.map((d) => (
                <DecisionButton
                  key={d.id}
                  id={d.id}
                  label={d.label}
                  pressed={picking === d.decision}
                  onClick={() => decide(d.decision)}
                />
              ))}
            </div>
            <footer className="plan__foot">
              <Button size="sm" variant="ghost" onClick={close}>
                Stop for today
              </Button>
            </footer>
          </>
        ) : (
          <Planned onClose={close} />
        )}
      </div>
    </div>
  );
}

/** Drop: delete it, with Undo on the toast to make it again in the same list. */
function drop(task: Task) {
  void tasksStore().deleteTask(task);
  toast({
    title: "Task dropped",
    action: {
      label: "Undo",
      run: () =>
        void tasksStore().addTask(task.accountId, task.listId, {
          title: task.title,
          ...(task.notes ? { notes: task.notes } : {}),
          due: task.due,
        }),
    },
    duration: 8000,
  });
}

/** The task to decide on: title, how late it is with its list (and account), and its notes. */
function TaskCard({ task }: { task: Task }) {
  const accounts = useTasksStore((s) => s.accounts);
  const account = accounts?.find((a) => a.accountId === task.accountId);
  const list = account?.lists.find((l) => l.id === task.listId)?.title;
  const today = todayDate();
  const overdue = task.due !== null && task.due < today;
  return (
    <div className="plan__task">
      <h3 className="plan__title">{taskTitle(task)}</h3>
      <p className="plan__meta">
        <span className={cx("plan__late", overdue && "plan__late--overdue")}>
          {lateness(task.due ?? today, today)}
        </span>
        {list && <span> · {list}</span>}
        {account && (accounts?.length ?? 0) > 1 && <span> · {account.email}</span>}
      </p>
      <p className="plan__notes">{task.notes}</p>
    </div>
  );
}

/** The day for Pick a day (from tomorrow) or Book a time (from today), open on the first one. */
const PickDay = forwardRef<
  HTMLButtonElement,
  { kind: "pickDay" | "book"; onPick(date: string): void }
>(function PickDay({ kind, onPick }, ref) {
  const today = todayDate();
  // Booking is for today or later; picking another day starts tomorrow (Today has its own key).
  const min = kind === "book" ? today : addDays(today, 1);
  const weekStart = useCalendarStore((s) => weekStartOf(s.accounts));
  return (
    <DateField
      ref={ref}
      className="plan__date"
      aria-label={kind === "book" ? "Book on" : "Move to"}
      value=""
      placeholder={formatDateValue(min)}
      min={min}
      weekStart={weekStart}
      defaultOpen
      onChange={onPick}
    />
  );
});

function DecisionButton({
  id,
  label,
  pressed,
  onClick,
}: {
  id: string;
  label: string;
  pressed: boolean;
  onClick(): void;
}) {
  const key = useKeybinding(id);
  return (
    <Button
      className="plan__decision"
      data-command={id}
      aria-pressed={pressed || undefined}
      onClick={onClick}
    >
      {label}
      {key && <Kbd shortcut={key} className="plan__key" />}
    </Button>
  );
}

/** The end: what is due today now, with the time Google has booked for any of them. */
function Planned({ onClose }: { onClose(): void }) {
  const due = useTasksStore((s) => s.due);
  const events = useCalendarStore((s) => s.events);
  const tz = displayZone(useCalendarStore((s) => s.accounts));
  const today = todayDate();
  const rows = useMemo(
    () =>
      planQueue(due ?? [], today)
        .filter((t) => t.due === today)
        .map((t) => {
          const block = events?.find(
            (e) =>
              e.taskLink &&
              e.start.ms != null &&
              dateOf(e.start.ms, tz) === today &&
              taskForBlock(e.taskLink, [t]),
          );
          return { task: t, at: block?.start.ms != null ? formatTime(block.start.ms, tz) : null };
        }),
    [due, events, tz, today],
  );
  return (
    <>
      <div className="plan__task">
        <h3 className="plan__title">Planned</h3>
        <p className="plan__meta">{rows.length > 0 ? "Due today:" : "Nothing due today"}</p>
      </div>
      <ul className="plan__planned" aria-label="Due today">
        {rows.map(({ task, at }) => (
          <li key={`${task.accountId}\n${task.listId}\n${task.id}`}>
            {taskTitle(task)}
            {at && <span className="plan__at"> · {at}</span>}
          </li>
        ))}
      </ul>
      <footer className="plan__foot">
        <Button size="sm" variant="primary" data-autofocus onClick={onClose}>
          Close
        </Button>
      </footer>
    </>
  );
}
