// Dragging conversations from the list onto the sidebar: a category asks how to move them (CategoryMoveDialog), a
// label moves them there, Trash deletes them. Pointer events rather than HTML5 drag and drop, which Tauri's own file
// drop handling intercepts in WebView2, and which can't draw the card the way the app does.
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { useUiStore } from "../store/uiStore";
import { useMailStore } from "../store/mailStore";
import { moveTo, shownCategory, trash } from "./actions";
import { openCategoryMove } from "./CategoryMoveDialog";
import { parseThreadKey, type ThreadKey, threadKey } from "./mailboxes";

/** Pointer travel before a press on a row becomes a drag, so a click with a shaky hand stays a click. */
const DRAG_THRESHOLD = 5;

/** The sidebar entries that take a drop carry these. */
export const DROP_ACCOUNT = "data-drop-account";
export const DROP_LABEL = "data-drop-label";
/** Set on the entry under the pointer while it would take the drop. */
const DROP_ACTIVE = "data-drop-active";

/** Attributes for a sidebar entry that takes dropped conversations of `accountId`. */
export const dropTarget = (accountId: string, labelId: string) => ({
  [DROP_ACCOUNT]: accountId,
  [DROP_LABEL]: labelId,
});

interface DragCardState {
  /** The card following the pointer, while dragging. */
  card: { count: number; x: number; y: number } | null;
}

export const useDragCardStore = create<DragCardState>(() => ({ card: null }));

/**
 * Whether dropping conversations of `accountId` (null: several accounts) on an entry for `target` does something:
 * same account, and not the mailbox they're shown in. Like Move to…, nothing leaves Spam or Trash this way yet.
 */
export function canDrop(accountId: string | null, target: { accountId: string; labelId: string }) {
  if (accountId === null || accountId !== target.accountId) return false;
  const { mailbox } = useUiStore.getState();
  const searching = Boolean(useMailStore.getState().query?.search);
  if (!searching && (mailbox.labelId === "SPAM" || mailbox.labelId === "TRASH")) return false;
  if (target.labelId.startsWith("CATEGORY_")) return shownCategory() !== target.labelId;
  return searching || mailbox.category !== undefined || mailbox.labelId !== target.labelId;
}

/** What a drop on `target` does. `at` is where the pointer let go, for the category popup. */
export function dropOn(
  keys: ThreadKey[],
  target: { accountId: string; labelId: string },
  at: { x: number; y: number },
): void {
  const { accountId, labelId } = target;
  if (labelId.startsWith("CATEGORY_")) openCategoryMove({ accountId, keys, category: labelId, at });
  else if (labelId === "TRASH") void trash(keys);
  else void moveTo(accountId, keys, labelId);
}

/** The drop target under the point, with its account and label. */
function targetAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${DROP_LABEL}]`);
  const accountId = el?.getAttribute(DROP_ACCOUNT);
  const labelId = el?.getAttribute(DROP_LABEL);
  return el && accountId && labelId ? { el, accountId, labelId } : null;
}

/** The conversations a drag from `key` carries: the checked ones if it is one of them, else just it. */
function dragged(key: ThreadKey): ThreadKey[] {
  const { checked } = useUiStore.getState();
  const listed = new Set(useMailStore.getState().threads.map((t) => threadKey(t.accountId, t.id)));
  return checked.includes(key) ? checked.filter((k) => listed.has(k)) : [key];
}

let active: (() => void) | null = null;

/**
 * Called on a row's primary-button press: past the threshold it becomes a drag of the row (or the checked rows it
 * belongs to) until the button comes up. Escape cancels it.
 */
export function startMailDrag(event: ReactPointerEvent, key: ThreadKey): void {
  if (event.button !== 0 || event.pointerType === "touch" || event.ctrlKey || event.metaKey) return;
  active?.();
  const start = { x: event.clientX, y: event.clientY };
  let keys: ThreadKey[] | null = null;
  let accountId: string | null = null;
  let over: HTMLElement | null = null;

  const highlight = (el: HTMLElement | null) => {
    if (el === over) return;
    over?.removeAttribute(DROP_ACTIVE);
    over = el;
    over?.setAttribute(DROP_ACTIVE, "");
  };

  const onMove = (e: PointerEvent) => {
    if (!keys) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      keys = dragged(key);
      const accounts = new Set(keys.map((k) => parseThreadKey(k).accountId));
      accountId = accounts.size === 1 ? [...accounts][0] : null;
      document.documentElement.classList.add("mail-dragging");
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    useDragCardStore.setState({ card: { count: keys.length, x: e.clientX, y: e.clientY } });
    const target = targetAt(e.clientX, e.clientY);
    highlight(target && canDrop(accountId, target) ? target.el : null);
  };

  const onUp = (e: PointerEvent) => {
    const carried = keys;
    stop();
    if (!carried) return;
    // The press and release make a click on whatever is under the pointer; the drop was the action.
    const swallow = (click: MouseEvent) => {
      click.stopPropagation();
      click.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    const target = targetAt(e.clientX, e.clientY);
    if (target && canDrop(accountId, target))
      dropOn(carried, target, { x: e.clientX, y: e.clientY });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !keys) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };

  function stop() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", stop);
    highlight(null);
    document.documentElement.classList.remove("mail-dragging");
    useDragCardStore.setState({ card: null });
    active = null;
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", stop);
  active = stop;
}

/** The card that follows the pointer while dragging conversations. Mount once. */
export function DragCardHost() {
  const card = useDragCardStore((s) => s.card);
  if (!card) return null;
  return (
    <div className="mail-drag-card" style={{ left: card.x, top: card.y }} aria-hidden="true">
      {card.count === 1 ? "1 conversation" : `${card.count} conversations`}
    </div>
  );
}
