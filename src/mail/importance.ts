// Gmail's importance marker is the IMPORTANT label, which a row carries among its system labels.
import type { ThreadSummary } from "../lib/tauri";

/** Whether Gmail has marked the conversation important. */
export const isImportant = (t: Pick<ThreadSummary, "systemLabelIds">): boolean =>
  t.systemLabelIds.includes("IMPORTANT");

/** Spam and Trash show a conversation without its other labels, so importance can't be set or shown there. */
export const canMarkImportance = (t: Pick<ThreadSummary, "systemLabelIds">): boolean =>
  !t.systemLabelIds.includes("SPAM") && !t.systemLabelIds.includes("TRASH");

/** The row with IMPORTANT added or removed, its system labels kept sorted like the backend's. */
export function withImportance(t: ThreadSummary, important: boolean): ThreadSummary {
  const rest = t.systemLabelIds.filter((id) => id !== "IMPORTANT");
  return { ...t, systemLabelIds: important ? [...rest, "IMPORTANT"].sort() : rest };
}
