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

/** What a user does in the pane to take over; any of these ends {@link keepInView}. */
const TAKEOVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
/** How long the message is held in place while the emails above it finish sizing (frames, images). */
const HOLD_MS = 3000;

/**
 * Scroll `pane` so `target` sits at its top, and keep it there while `content` (what holds the target) changes size
 * above it, until the user scrolls or clicks in the pane or {@link HOLD_MS} pass. Returns a function that stops.
 */
export function keepInView(pane: HTMLElement, content: Element, target: Element): () => void {
  // The target's `scroll-margin-top` is the room left above it, as `scrollIntoView` would.
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  // Where this last left the pane, and how tall the content was then: a scroll anywhere else is the user's (also one
  // over an email's frame, whose wheel events never reach the pane), unless the content changed height, which moves
  // or clamps the scroll by itself (a frame above shrinking): then place it again.
  let placed = pane.scrollTop;
  let height = pane.scrollHeight;
  const place = () => {
    const offset = target.getBoundingClientRect().top - pane.getBoundingClientRect().top - margin;
    if (Math.abs(offset) >= 1) pane.scrollTop += offset;
    placed = pane.scrollTop;
    height = pane.scrollHeight;
  };
  const onScroll = () => {
    if (pane.scrollHeight !== height) place();
    else if (Math.abs(pane.scrollTop - placed) >= 1) stop();
  };
  place();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  observer?.observe(content);
  const stop = () => {
    clearTimeout(timer);
    observer?.disconnect();
    pane.removeEventListener("scroll", onScroll);
    for (const type of TAKEOVER) pane.removeEventListener(type, stop);
  };
  const timer = setTimeout(stop, HOLD_MS);
  pane.addEventListener("scroll", onScroll, { passive: true });
  for (const type of TAKEOVER) pane.addEventListener(type, stop, { passive: true });
  return stop;
}
