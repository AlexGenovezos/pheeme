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
