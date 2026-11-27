// Today, at the top of the Tasks panel: every account's open tasks due today or earlier, overdue
// ones first (their date in red), each a normal task row, with Plan today to decide on them one at
// a time. It keeps its shape while it reads, and says "Nothing due today" only once it has.
import { useMemo } from "react";
import { systemZone } from "../calendar/dates";
import { useToday } from "../calendar/useNow";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { useKeybinding } from "../keyboard/useCommands";
import type { Task } from "../lib/tauri";
import { describeShortcut } from "../keyboard/format";
import { listKey, splitCompleted, taskKey } from "./outline";
import { planQueue } from "./plan";
import { PLAN_TODAY_COMMAND, usePlanStore } from "./planStore";
import { LoadError, SkeletonRows } from "./LoadStates";
import { TaskEditor } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { useTasksStore } from "./tasksStore";

/** The `editing` key of a task opened from Today, so its editor shows here, not in its list. */
const todayKey = (task: Task) => `today\n${taskKey(task)}`;

export function TodaySection() {
  const due = useTasksStore((s) => s.due);
  const dueError = useTasksStore((s) => s.dueError);
  const editing = useTasksStore((s) => s.editing);
  const shortcut = useKeybinding(PLAN_TODAY_COMMAND);
  const today = useToday(systemZone());
  const tasks = useMemo(() => (due ? planQueue(due, today) : null), [due, today]);
  return (
    <section className="tasks-list tasks-today" aria-label="Today">
      <div className="tasks-list__head">
        <h3 className="tasks-list__title tasks-today__title">
          Today
          <span className="tasks-today__count" aria-hidden={tasks === null || undefined}>
            {tasks === null ? <Skeleton width="1.5em" /> : tasks.length}
          </span>
        </h3>
        <Button
          size="sm"
          variant="ghost"
          data-command={PLAN_TODAY_COMMAND}
          title={shortcut ? `Plan today (${describeShortcut(shortcut)})` : undefined}
          onClick={() => void usePlanStore.getState().openPlan()}
        >
          Plan today
        </Button>
      </div>
      {dueError && (
        <LoadError message={dueError} onRetry={() => void useTasksStore.getState().loadDue()} />
      )}
      {tasks === null ? (
        !dueError && <SkeletonRows />
      ) : (
        <ul className="tasks-list__items" aria-label="Today tasks">
          {tasks.map((t) => (
            <li key={taskKey(t)}>
              {editing === todayKey(t) ? (
                <TaskEditor
                  accountId={t.accountId}
                  listId={t.listId}
                  task={t}
                  editKey={todayKey(t)}
                />
              ) : (
                <TodayRow task={t} />
              )}
            </li>
          ))}
          {tasks.length === 0 && <li className="tasks-list__empty">Nothing due today</li>}
        </ul>
      )}
    </section>
  );
}

/** A task row with its list's menu (indent, move to another list) as in the list itself. */
function TodayRow({ task }: { task: Task }) {
  const listTasks = useTasksStore((s) => s.lists[listKey(task.accountId, task.listId)]);
  const lists = useTasksStore(
    (s) => s.accounts?.find((a) => a.accountId === task.accountId)?.lists,
  );
  const open = useMemo(() => splitCompleted(listTasks ?? []).open, [listTasks]);
  const otherLists = useMemo(
    () => (lists ?? []).filter((l) => l.id !== task.listId),
    [lists, task.listId],
  );
  return <TaskRow task={task} open={open} otherLists={otherLists} editKey={todayKey(task)} />;
}
