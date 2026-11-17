// The rules of the daily plan and Google's task blocks: which tasks need a decision today, how late
// each one is, whether the plan opens on its own, where booking a time hands off to, and which
// calendar event is which task's block.
import { addDays, dateOf, daysBetween } from "../calendar/dates";
import type { CalendarEvent, Task } from "../lib/tauri";

/** localStorage: the day (`YYYY-MM-DD`) the plan last opened, so it opens on its own once a day. */
export const PLANNED_KEY = "pheeme.tasks.planned";

/** Open tasks due today or earlier: overdue ones first, oldest first, then today's. */
export function planQueue(tasks: Task[], today: string): Task[] {
  return tasks
    .filter((t) => !t.completed && !t.hidden && t.due !== null && t.due <= today)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.due!.localeCompare(b.t.due!) || a.i - b.i)
    .map(({ t }) => t);
}

/** "Due today", "Due yesterday", "Due 12 days ago". */
export function lateness(due: string, today: string): string {
  if (due >= today) return "Due today";
  if (due === addDays(today, -1)) return "Due yesterday";
  return `Due ${daysBetween(due, today)} days ago`;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readPlanned(
  store: Pick<Storage, "getItem"> | undefined = storage(),
): string | null {
  try {
    return store?.getItem(PLANNED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writePlanned(
  date: string,
  store: Pick<Storage, "setItem"> | undefined = storage(),
) {
  try {
    store?.setItem(PLANNED_KEY, date);
  } catch {
    // Storage full or blocked: the plan may open on its own once more today.
  }
}

/** Open on its own: not yet today, and only with something to decide. */
export const shouldAutoOpen = (planned: string | null, today: string, queue: Task[]): boolean =>
  planned !== today && queue.length > 0;

/** Google Calendar on the web at `date`, for the account `email`: where a task gets its hour. */
export function bookingUrl(email: string, date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `https://calendar.google.com/calendar/u/0/r/day/${y}/${m}/${d}?authuser=${encodeURIComponent(email)}`;
}

/** The task a block's link (`https://tasks.google.com/task/<code>`) is for. */
export const taskForBlock = (link: string, tasks: Task[]): Task | undefined =>
  tasks.find((t) => t.webViewLink === link || t.webViewLink?.startsWith(`${link}?`));

/** `tasks` less those whose block is on their due day (the block shows them there). */
export function withoutBooked(tasks: Task[], events: CalendarEvent[], zone: string): Task[] {
  const booked = new Set<Task>();
  for (const e of events) {
    if (!e.taskLink) continue;
    const task = taskForBlock(e.taskLink, tasks);
    if (!task) continue;
    const day = e.start.date ?? (e.start.ms != null ? dateOf(e.start.ms, zone) : null);
    if (day === task.due) booked.add(task);
  }
  return booked.size ? tasks.filter((t) => !booked.has(t)) : tasks;
}
