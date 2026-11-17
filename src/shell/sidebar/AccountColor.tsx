// An account's colour: its dot in the sidebar opens twelve swatches, and the one picked recolours the account
// everywhere it shows (the dot, the rail, the All Inboxes stripe). Saved with the account, on this computer.
import { type KeyboardEvent, useRef } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../../components/ui/usePopover";
import { toastError } from "../../components/ui/Toast";
import { type Swatch, SwatchGrid } from "../../labels/ColorPopover";
import { useAccountStore } from "../../store/accountStore";
import "../../labels/labels.css";
import "../../components/ui/Surface.css";

/** The colours' names, in `--color-account-N` order. */
export const ACCOUNT_COLOR_NAMES = [
  "Blue",
  "Green",
  "Orange",
  "Purple",
  "Red",
  "Yellow",
  "Teal",
  "Pink",
  "Indigo",
  "Lime",
  "Brown",
  "Grey",
] as const;

const SWATCHES: Swatch[] = ACCOUNT_COLOR_NAMES.map((name, i) => ({
  value: String(i + 1),
  name,
  background: `var(--color-account-${i + 1})`,
  // Light swatches in a dark theme and dark ones in a light theme: the sidebar's own colour reads on both.
  foreground: "var(--color-sidebar-bg)",
}));

/** The grid's tab stop: the ticked swatch, else the first. */
const gridStop = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[tabindex="0"]');

export function AccountColorPopover({
  accountId,
  color,
  at,
  returnFocus,
  onClose,
}: {
  accountId: string;
  /** The account's colour now, 1–12. */
  color: number;
  at: { x: number; y: number };
  returnFocus?: HTMLElement | null;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos } = usePopover({ ref, at, onClose, focusIn: gridStop, returnFocus });

  const choose = (value: string) => {
    onClose();
    useAccountStore.getState().setColor(accountId, Number(value)).catch(toastError);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The grid is the only stop, so Tab stays on it.
    if (e.key === "Escape") onClose();
    else if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      className="label-color popover-surface"
      role="dialog"
      aria-label="Account colour"
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <SwatchGrid swatches={SWATCHES} value={String(color)} onChoose={choose} columns={6} />
    </div>,
    document.body,
  );
}
