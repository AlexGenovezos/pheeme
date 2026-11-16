// Keyboard navigation inside the mailbox list, and the small helpers its rows share.
import type { KeyboardEvent } from "react";
import { focusFromKeyboard } from "../../keyboard/focus";
import { registry } from "../../keyboard/registry";

/** A mailbox or label row that opens something (synthetic label parents have no role). */
const MAILBOX_ROW = '.sidebar__row[role="link"]';

const plainKey = (e: KeyboardEvent) => !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/** The first row after `from` (down) or the last one before it (up). */
function nearest(rows: HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | undefined {
  const side = down ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  const beyond = rows.filter((r) => from.compareDocumentPosition(r) & side);
  return down ? beyond[0] : beyond[beyond.length - 1];
}

/**
 * Arrow keys inside the mailbox list: Up/Down step to the next mailbox and open it, Right moves on to the
 * conversation list. Left stops here, so it doesn't bounce back to the list (`list.focus`).
 */
export function onMailboxKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!plainKey(e) || !(e.target instanceof HTMLElement)) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    registry.run("list.focus");
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const target = e.target;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(MAILBOX_ROW));
    const down = e.key === "ArrowDown";
    const at = rows.indexOf(target);
    // From a header, ⋮ or fold button: the nearest row in that direction.
    const next = at >= 0 ? rows[at + (down ? 1 : -1)] : nearest(rows, target, down);
    e.preventDefault();
    if (!next) return;
    focusFromKeyboard(next);
    next.click();
  }
}

/** Focus the open mailbox's row (or the first row when it isn't shown). False when there are none. */
export function focusOpenMailbox(): boolean {
  const nav = document.querySelector<HTMLElement>(".sidebar__scroll");
  const row =
    nav?.querySelector<HTMLElement>(`${MAILBOX_ROW}[data-selected]`) ??
    nav?.querySelector<HTMLElement>(MAILBOX_ROW);
  focusFromKeyboard(row);
  return Boolean(row);
}

export function activateOnKey(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** Below the row, left-aligned: where a menu or popover for it opens. */
export const below = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
};
