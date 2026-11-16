// One optimistic mail action across every store that shows it: the list rows, the cached conversations and the
// sidebar's unread counts. Each store holds the action's changes over its reloads until the action settles; this is
// the one place that knows which stores those are, so the actions patch and release them together.
import type { ThreadDetail, ThreadSummary } from "../lib/tauri";
import { type UnreadCountChange, useLabelStore } from "../store/labelStore";
import { newOp, useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import type { ThreadKey } from "./mailboxes";

export class OptimisticOp {
  private readonly id = newOp();
  /** Conversations whose command hasn't settled yet. */
  private readonly waiting: Set<ThreadKey>;

  /** An action on `keys`, the conversations its changes apply to. */
  constructor(private readonly keys: ThreadKey[]) {
    this.waiting = new Set(keys);
  }

  /** Changes the sidebar's unread counts, held over count refreshes until the whole action settles. */
  unread(changes: UnreadCountChange[]): void {
    useLabelStore.getState().patchUnread(this.id, changes);
  }

  /** Rewrites the conversations' rows in the list. */
  rows(fn: (thread: ThreadSummary) => ThreadSummary): void {
    useMailStore.getState().patch(this.keys, fn, this.id);
  }

  /** Takes the conversations' rows out of the mailbox shown. */
  remove(): void {
    useMailStore.getState().remove(this.keys, this.id);
  }

  /** Rewrites the cached conversations (their label chips). */
  detail(fn: (detail: ThreadDetail) => ThreadDetail): void {
    const threads = useThreadStore.getState();
    for (const key of this.keys) threads.patchDetail(key, fn, this.id);
  }

  /**
   * The command for `keys` has settled (`rejected`: Gmail's queue refused it, or it was dropped): their rows and
   * details stop being held. The unread counts are released once every conversation of the action has settled.
   */
  settle(keys: ThreadKey[], rejected: boolean): void {
    useMailStore.getState().settle(this.id, keys, rejected);
    useThreadStore.getState().settleDetails(this.id, keys);
    if (this.waiting.size === 0) return;
    for (const key of keys) this.waiting.delete(key);
    if (this.waiting.size === 0) useLabelStore.getState().settleUnread(this.id);
  }
}
