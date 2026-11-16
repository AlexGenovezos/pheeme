// Where a floating panel goes. Pure arithmetic on rectangles, so the rules (flip to the other side,
// clamp to the window) are tested without a browser; usePopover.ts and the callers measure the DOM.

export interface Size {
  width: number;
  height: number;
}

/** The part of a DOMRect the placement rules read. */
export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `value` moved to the nearest spot where `size` fits between `margin` and `room - margin`. */
const clamp = (value: number, size: number, room: number, margin: number) =>
  Math.max(margin, Math.min(value, room - size - margin));

/** A panel opened at a point (a click, a row's corner), pushed back inside the window if it overflows. */
export function clampToWindow(
  at: { x: number; y: number },
  size: Size,
  viewport: Size,
  margin = 0,
): { x: number; y: number } {
  return {
    x: clamp(at.x, size.width, viewport.width, margin),
    y: clamp(at.y, size.height, viewport.height, margin),
  };
}

/**
 * A panel beside what it belongs to: to its right if there's room, else its left, level with its
 * top, and clamped to the window. With no anchor (it isn't on screen) it sits near the middle.
 */
export function placeBeside(
  anchor: Anchor | null,
  size: Size,
  viewport: Size,
  gap = 8,
): { left: number; top: number } {
  let left = viewport.width / 2 - size.width / 2;
  let top = viewport.height / 3 - size.height / 3;
  if (anchor) {
    left = anchor.right + gap;
    if (left + size.width > viewport.width - gap) left = anchor.left - gap - size.width;
    top = anchor.top;
  }
  return {
    left: clamp(left, size.width, viewport.width, gap),
    top: clamp(top, size.height, viewport.height, gap),
  };
}

export interface FieldPlacement {
  left: number;
  top: number;
  minWidth: number | undefined;
  /** Set when the content is taller than the room, so it scrolls instead of spilling off screen. */
  maxHeight: number | undefined;
}

/**
 * A popover hanging from a field: under it, or over it when there's more room there (or when it
 * doesn't fit under and doesn't fit over either, whichever has more). `cap` is the tallest its own
 * CSS lets it grow, so placing it never lifts that cap.
 */
export function placeByField(
  field: Anchor & { width: number },
  content: { width: number; scrollHeight: number },
  viewport: Size,
  { gap, cap = Infinity, matchWidth = false }: { gap: number; cap?: number; matchWidth?: boolean },
): FieldPlacement {
  const width = Math.max(content.width, matchWidth ? field.width : 0);
  const height = Math.min(content.scrollHeight, cap);
  const below = viewport.height - field.bottom - 2 * gap;
  const above = field.top - 2 * gap;
  const down = below >= height || below >= above;
  const room = Math.max(0, down ? below : above);
  const shown = Math.min(height, room);
  const left = Math.max(gap, Math.min(field.left, viewport.width - width - gap));
  const top = down ? field.bottom + gap : field.top - gap - shown;
  return {
    left,
    top,
    minWidth: matchWidth ? field.width : undefined,
    maxHeight: Math.min(room, cap) < content.scrollHeight ? Math.min(room, cap) : undefined,
  };
}
