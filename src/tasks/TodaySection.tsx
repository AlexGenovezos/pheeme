// Today, at the top of the Tasks panel: every account's open tasks due today or earlier, overdue
// ones first (their date in red), each a normal task row, with Plan today to decide on them one at
// a time. It keeps its shape while it reads, and says "Nothing due today" only once it has.
import { useMemo } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { registry } from "../keyboard/registry";
import { useKeybinding } from "../keyboard/useCommands";
import type { Task } from "../lib/tauri";
import { describeShortcut } from "../keyboard/format";
import { listKey, splitCompleted, taskKey } from "./outline";
import { planQueue } from "./plan";
import { TaskEditor } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { todayDate, useTasksStore } from "./tasksStore";

export const PLAN_TODAY_COMMAND = "tasks.planToday";

/** The `editing` key of a task opened from Today, so its editor shows here, not in its list. */
const todayKey = (task: Task) => `today\n${taskKey(task)}`;

export function TodaySection() {
  const due = useTasksStore((s) => s.due);
  const dueError = useTasksStore((s) => s.dueError);
  const editing = useTasksStore((s) => s.editing);
  const shortcut = useKeybinding(PLAN_TODAY_COMMAND);
  const tasks = useMemo(() => (due ? planQueue(due, todayDate()) : null), [due]);
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
          onClick={() => registry.run(PLAN_TODAY_COMMAND)}
        >
          Plan today
        </Button>
      </div>
      {dueError && (
        <div className="tasks-access">
          <p role="alert">Couldn't read tasks: {dueError}</p>
          <Button size="sm" onClick={() => void useTasksStore.getState().loadDue()}>
            Try again
          </Button>
        </div>
      )}
      {tasks === null ? (
        !dueError &&
        [0, 1].map((i) => (
          <div key={i} className="task-row" aria-hidden="true">
            <Skeleton shape="circle" className="task-row__skeleton-check" />
            <Skeleton width={`${60 - i * 20}%`} />
          </div>
        ))
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
