import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Space between a button and the panel that opens above it. */
const GAP = 4;

/** Where a panel opening upward from `button` puts its bottom-left corner. */
export function aboveOf(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.top - GAP };
}

/**
 * A panel the formatting bar or the compose footer opens: drawn over the whole window (so nothing in the panel
 * or a dialog clips it), and a `data-owns-keys` region like the compose panel, so typing in it never fires an
 * app shortcut.
 */
export function Floating({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="compose-floating" data-owns-keys="">
      {children}
    </div>,
    document.body,
  );
}
