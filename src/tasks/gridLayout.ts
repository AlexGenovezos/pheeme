// Dated tasks on the calendar grid: one-day items in the all-day band (Day, Week) and month cells,
// each in the first row its day has free after the events already placed there.
import type { Task } from "../lib/tauri";

export interface TaskSegment {
  task: Task;
  /** Index of its day among the days shown. */
  start: number;
  span: 1;
  row: number;
}

/** The rows events take, by day (`start`/`span` index into the same days). */
type Taken = { start: number; span: number; row: number };

export function layoutTasks(tasks: Task[], days: string[], taken: Taken[]): TaskSegment[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const used = days.map(() => new Set<number>());
  for (const s of taken) for (let d = s.start; d < s.start + s.span; d++) used[d]?.add(s.row);
  const segments: TaskSegment[] = [];
  for (const task of tasks) {
    const day = task.due ? index.get(task.due) : undefined;
    if (day === undefined) continue;
    let row = 0;
    while (used[day].has(row)) row++;
    used[day].add(row);
    segments.push({ task, start: day, span: 1, row });
  }
  return segments;
}
