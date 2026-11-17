// Dated tasks on the calendar: a hook that reads the tasks due on the days shown, and the chip each
// one draws as in the all-day band and month cells. The circle ticks it off (crossed out in place);
// the title opens it in the Tasks panel. Google's task blocks show as their task with the same tick.
import { Check } from "lucide-react";
import { type CSSProperties, useEffect } from "react";
import { addDays } from "../calendar/dates";
import type { CalendarEvent, Task } from "../lib/tauri";
import { cx } from "../lib/utils";
import { taskTitle } from "./outline";
import { taskForBlock } from "./plan";
import { useTasksStore } from "./tasksStore";
import "./tasks.css";

/** The tasks due on `days` (read when they aren't in memory yet); `null` until the first read. */
export function useDatedTasks(days: string[]): Task[] | null {
  const first = days[0];
  const last = days[days.length - 1];
  useEffect(() => {
    if (!first || !last) return;
    const to = addDays(last, 1);
    // The calendar reads the months around the days shown along with its events; read just these
    // days only when they aren't covered yet.
    const [from, until] = useTasksStore.getState().datedFor?.split(":") ?? [];
    if (from && until && from <= first && until >= to) return;
    void useTasksStore.getState().loadDated(first, to);
  }, [first, last]);
  return useTasksStore((s) => s.dated);
}

/** The task Google's task block `event` is for, among the dated tasks; none for other events. */
export function useBlockTask(event: CalendarEvent): Task | undefined {
  return useTasksStore((s) =>
    event.taskLink && s.dated ? taskForBlock(event.taskLink, s.dated) : undefined,
  );
}

/** The small round tick that completes (or reopens) `task`, on a chip or a task block. */
export function TaskTick({
  task,
  className,
  style,
}: {
  task: Task;
  className?: string;
  style?: CSSProperties;
}) {
  const title = taskTitle(task);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.completed}
      aria-label={task.completed ? `Mark not done: ${title}` : `Mark done: ${title}`}
      className={cx("task-check task-check--sm", className)}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        void useTasksStore.getState().setCompleted(task, !task.completed);
      }}
    >
      <span className="task-check__ring">
        <Check aria-hidden="true" />
      </span>
    </button>
  );
}

export function TaskChip({ task, style }: { task: Task; style: CSSProperties }) {
  const title = taskTitle(task);
  const store = useTasksStore.getState;
  return (
    <div className={cx("task-chip", task.completed && "task-chip--done")} style={style}>
      <TaskTick task={task} />
      <button
        type="button"
        className="task-chip__title"
        aria-label={`Task: ${title}${task.completed ? ", done" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          store().reveal(task);
        }}
      >
        {title}
      </button>
    </div>
  );
}
