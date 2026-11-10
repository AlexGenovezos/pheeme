// Dated tasks on the calendar: a hook that reads the tasks due on the days shown, and the chip each
// one draws as in the all-day band and month cells. The circle ticks it off (crossed out in place);
// the title opens it in the Tasks panel.
import { Check } from "lucide-react";
import { type CSSProperties, useEffect } from "react";
import { addDays } from "../calendar/dates";
import type { Task } from "../lib/tauri";
import { cx } from "../lib/utils";
import { taskTitle } from "./outline";
import { useTasksStore } from "./tasksStore";
import "./tasks.css";

/** The tasks due on `days` (read again when the days change); `null` until the first read. */
export function useDatedTasks(days: string[]): Task[] | null {
  const first = days[0];
  const last = days[days.length - 1];
  useEffect(() => {
    if (first && last) void useTasksStore.getState().loadDated(first, addDays(last, 1));
  }, [first, last]);
  return useTasksStore((s) => s.dated);
}

export function TaskChip({ task, style }: { task: Task; style: CSSProperties }) {
  const title = taskTitle(task);
  const store = useTasksStore.getState;
  return (
    <div className={cx("task-chip", task.completed && "task-chip--done")} style={style}>
      <button
        type="button"
        role="checkbox"
        aria-checked={task.completed}
        aria-label={task.completed ? `Mark not done: ${title}` : `Mark done: ${title}`}
        className="task-check task-check--sm"
        onClick={(e) => {
          e.stopPropagation();
          void store().setCompleted(task, !task.completed);
        }}
      >
        <Check aria-hidden="true" />
      </button>
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
