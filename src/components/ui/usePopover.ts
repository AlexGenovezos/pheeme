// What the floating panels share (Menu, the label pickers, the colour popover, the category-move
// dialog, the event popover, quick create): kept on screen, closed by a press outside (and, for most,
// by the window losing focus), and focus put back where it was.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampToWindow } from "./placement";

/** The newest `value`, for listeners that are bound once but must not call a stale callback. */
function useLatest<T>(value: T) {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  return latest;
}

export interface DismissOptions {
  /** A press outside `ref` (and not `ignore`d). */
  onOutside(e: PointerEvent): void;
  /** The window lost focus: another app came forward. Leave out to stay open. */
  onBlur?(): void;
  /** Targets outside `ref` that still count as inside (the field a picker hangs from). */
  ignore?(target: Node): boolean;
}

/** Calls `onOutside` for a pointer press outside `ref`, and `onBlur` when the window loses focus. */
export function useDismiss(ref: RefObject<HTMLElement | null>, options: DismissOptions) {
  const latest = useLatest(options);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || latest.current.ignore?.(target)) return;
      latest.current.onOutside(e);
    };
    const onBlur = () => latest.current.onBlur?.();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [ref, latest]);
}

export interface PopoverOptions {
  ref: RefObject<HTMLElement | null>;
  /** Viewport coordinates of the top-left corner (clamped to stay on screen). */
  at: { x: number; y: number };
  /** `at` is the bottom-left corner instead: the panel opens upward (from a bar at the bottom of a window). */
  above?: boolean;
  onClose(): void;
  /** Whether the window losing focus closes it (default). */
  closeOnBlur?: boolean;
  /** The element focus moves to when it opens; the panel itself when this is left out. */
  focusIn?(panel: HTMLElement | null): HTMLElement | null | undefined;
  /** Where focus goes when it closes; the element focused when it opened when this is left out. */
  returnFocus?: HTMLElement | null;
  /** Targets outside the panel that don't close it (a list a field in it opened, the button that toggles it). */
  ignore?(target: Node): boolean;
}

/**
 * A panel opened at a point: kept inside the window once its size is known, closed by a press
 * outside it (and by the window blurring), with focus moved in on opening and back on closing.
 * Returns where to draw it, and the element that had focus when it opened.
 */
export function usePopover({
  ref,
  at,
  above = false,
  onClose,
  closeOnBlur = true,
  focusIn,
  returnFocus,
  ignore,
}: PopoverOptions) {
  const [pos, setPos] = useState(at);
  const opener = useRef<HTMLElement | null>(null);
  const latest = useLatest({ onClose, focusIn, ignore });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const next = clampToWindow(
      { x: at.x, y: above ? at.y - height : at.y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((p) => (p.x === next.x && p.y === next.y ? p : next));
  }, [ref, at.x, at.y, above]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    opener.current = previous;
    const focus = latest.current.focusIn;
    (focus ? focus(ref.current) : ref.current)?.focus();
    return () => {
      (returnFocus === undefined ? previous : returnFocus)?.focus?.();
    };
  }, [ref, latest, returnFocus]);

  useDismiss(ref, {
    onOutside: () => latest.current.onClose(),
    onBlur: closeOnBlur ? () => latest.current.onClose() : undefined,
    ignore: (target) => latest.current.ignore?.(target) ?? false,
  });

  return { pos, opener };
}
