import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../lib/utils";

export interface DividerProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Called with the proposed width; the owner clamps and stores it. */
  onResize(width: number): void;
  onReset(): void;
  className?: string;
}

const KEY_STEP = 16;

/**
 * A draggable pane edge. Pointer drag, arrow keys (Shift for bigger steps),
 * Home/End for min/max, double-click or Enter to reset.
 */
export function Divider({ label, value, min, max, onResize, onReset, className }: DividerProps) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null);

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    delete document.body.dataset.resizing;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    if (e.key === "ArrowLeft") onResize(value - step);
    else if (e.key === "ArrowRight") onResize(value + step);
    else if (e.key === "Home") onResize(min);
    else if (e.key === "End") onResize(max);
    else if (e.key === "Enter") onReset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cx("shell__divider", className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startValue: value };
        document.body.dataset.resizing = "";
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(drag.current.startValue + e.clientX - drag.current.startX);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
