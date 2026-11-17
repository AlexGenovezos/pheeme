// The daily plan's state: whether it's open, the tasks it walks through (taken when it opens, so
// decisions don't reorder it) and which one is showing. Also booking a time, which the plan and a
// task's menu share: the task moves to the day and Google Calendar opens there to give it an hour.
import { create } from "zustand";
import { toast, toastError } from "../components/ui/Toast";
import { openExternal, type Task } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { taskTitle } from "./outline";
import { bookingUrl, planQueue, writePlanned } from "./plan";
import { todayDate, useTasksStore } from "./tasksStore";

export const PLAN_TODAY_COMMAND = "tasks.planToday";

interface PlanState {
  open: boolean;
  /** The tasks to decide on, as they were when the plan opened. */
  queue: Task[];
  /** The task showing; `queue.length` once every one has had its decision. */
  index: number;
  /** Open the plan (reading the due tasks first if they haven't been). */
  openPlan(): Promise<void>;
  close(): void;
  next(): void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  open: false,
  queue: [],
  index: 0,
  openPlan: async () => {
    if (get().open) return;
    const today = todayDate();
    // It counts as planned once it opens, by hand or on its own.
    writePlanned(today);
    const tasks = useTasksStore.getState();
    if (tasks.due === null) await tasks.loadDue();
    set({ open: true, queue: planQueue(useTasksStore.getState().due ?? [], today), index: 0 });
  },
  close: () => set({ open: false }),
  next: () => set((s) => ({ index: Math.min(s.index + 1, s.queue.length) })),
}));

/**
 * Move `task` to `date` and open Google Calendar's day for its account, where dragging it from
 * Tasks onto an hour books it (the Calendar API can't make task blocks for personal accounts).
 */
export async function bookTask(task: Task, date: string): Promise<void> {
  const store = useTasksStore.getState();
  // Shows at once; Google's answer comes later (a refusal snaps back with its own toast).
  const saved = task.due === date ? Promise.resolve(true) : store.editTask(task, { due: date });
  const email =
    store.accounts?.find((a) => a.accountId === task.accountId)?.email ??
    useAccountStore.getState().accounts.find((a) => a.id === task.accountId)?.email;
  if (email) void openExternal(bookingUrl(email, date)).catch(toastError);
  toast({
    title: "Book it in Google Calendar",
    description: `Drag “${taskTitle(task)}” from Tasks onto an hour. Pheeme shows it here once it's booked.`,
    duration: 8000,
  });
  await saved;
}
