import { create } from "zustand";
import type { ThreadKey } from "./mailboxes";

/**
 * A message to bring into view once its conversation shows: a clicked new-mail notification names the message it
 * showed. The conversation unfolds it and scrolls to it, also when it was open already. It waits while the cached
 * conversation doesn't have the message yet, and is dropped once another conversation opens.
 */
export interface Reveal {
  key: ThreadKey;
  messageId: string;
}

export const useRevealStore = create<{ reveal: Reveal | null }>(() => ({ reveal: null }));

export const revealMessage = (reveal: Reveal | null) => useRevealStore.setState({ reveal });

/** What a user does to move the pane themselves; any of these ends {@link keepInView}. */
const TAKEOVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
/** How long the message is held in place while the emails above it finish sizing (frames, images). */
const HOLD_MS = 3000;

/**
 * Scroll `pane` so `target` sits at its top, and keep it there while `content` (what holds the target) changes size
 * above it, until the user scrolls or clicks in the pane or {@link HOLD_MS} pass. Returns a function that stops.
 */
export function keepInView(
  pane: HTMLElement,
  content: Element,
  target: Element,
  holdMs = HOLD_MS,
): () => void {
  // The target's `scroll-margin-top` is the room left above it, as `scrollIntoView` would.
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const place = () => {
    const offset = target.getBoundingClientRect().top - pane.getBoundingClientRect().top - margin;
    if (Math.abs(offset) >= 1) pane.scrollTop += offset;
  };
  place();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  observer?.observe(content);
  const stop = () => {
    clearTimeout(timer);
    observer?.disconnect();
    for (const type of TAKEOVER) pane.removeEventListener(type, stop);
  };
  const timer = setTimeout(stop, holdMs);
  for (const type of TAKEOVER) pane.addEventListener(type, stop, { passive: true });
  return stop;
}
