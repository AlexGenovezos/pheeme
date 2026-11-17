// Putting the accounts in order: drag an account's header up or down the sidebar, or Move up / Move down from its
// menu. Pointer events rather than HTML5 drag and drop, which the desktop app's file drop handling swallows on
// Windows (as for dragging mail and tasks).
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { toastError } from "../../components/ui/Toast";
import { useAccountStore } from "../../store/accountStore";

/** Pointer travel before a press on a header becomes a drag, so a click with a shaky hand stays a click. */
const DRAG_THRESHOLD = 5;

/** Each account's group in the sidebar carries its id in this. */
export const ACCOUNT_GROUP = "data-account-group";

/** `ids` with `id` moved `by` places (−1 up, 1 down), or unchanged at either end. */
export function moved(ids: string[], id: string, by: number): string[] {
  const from = ids.indexOf(id);
  const to = from + by;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = ids.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
}

/**
 * Where `dragged` lands when let go at height `y`: just before the first other account whose middle is below `y`,
 * else last. `middles` holds each account's vertical middle on screen.
 */
export function dropped(
  ids: string[],
  dragged: string,
  middles: Record<string, number>,
  y: number,
): string[] {
  const others = ids.filter((id) => id !== dragged);
  const at = others.findIndex((id) => (middles[id] ?? Infinity) > y);
  const index = at === -1 ? others.length : at;
  return [...others.slice(0, index), dragged, ...others.slice(index)];
}

/** Saves the accounts in `ids`' order, toasting a failure (the store has already put the old order back). */
export function reorder(ids: string[]): void {
  useAccountStore.getState().reorder(ids).catch(toastError);
}

/** Moves the account one place up (−1) or down (1). */
export function moveAccount(id: string, by: number): void {
  const ids = useAccountStore.getState().accounts.map((a) => a.id);
  const next = moved(ids, id, by);
  if (next !== ids) reorder(next);
}

interface AccountDragState {
  /** The account being dragged, while dragging. */
  dragging: string | null;
  /** The order it would leave if let go now. */
  order: string[] | null;
}

export const useAccountDrag = create<AccountDragState>(() => ({ dragging: null, order: null }));

/** Each account group's vertical middle on screen. */
function middles(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of document.querySelectorAll<HTMLElement>(`[${ACCOUNT_GROUP}]`)) {
    const id = el.getAttribute(ACCOUNT_GROUP);
    const r = el.getBoundingClientRect();
    if (id) out[id] = r.top + r.height / 2;
  }
  return out;
}

let active: (() => void) | null = null;

/**
 * Called on a primary-button press on an account's header: past the threshold it becomes a drag of that account
 * until the button comes up, which puts it where it was let go. Escape cancels; a drag swallows the click after it.
 */
export function startAccountDrag(event: ReactPointerEvent, accountId: string): void {
  if (event.button !== 0 || active) return;
  const start = { x: event.clientX, y: event.clientY };
  const ids = useAccountStore.getState().accounts.map((a) => a.id);
  if (ids.length < 2) return;
  let dragging = false;
  // Measured once the drag starts: the groups don't move until it ends.
  let mids: Record<string, number> = {};

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      mids = middles();
    }
    useAccountDrag.setState({
      dragging: accountId,
      order: dropped(ids, accountId, mids, e.clientY),
    });
  };
  const up = () => {
    const { order } = useAccountDrag.getState();
    stop();
    if (!dragging) return;
    // The click the press and release make would fold the account.
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (order && order.some((id, i) => id !== ids[i])) reorder(order);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("keydown", key, true);
    useAccountDrag.setState({ dragging: null, order: null });
    active = null;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("keydown", key, true);
  active = stop;
}

const swallow = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
