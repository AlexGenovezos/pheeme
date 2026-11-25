import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { keepInView } from "./reveal";

let resized: (() => void) | null = null;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {
        resized = null;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resized = null;
});

/** A pane whose target sits `at()` px down the content: its top on screen is that minus the scroll. */
function setup(at: () => number) {
  const pane = document.createElement("div");
  const content = document.createElement("div");
  const target = document.createElement("article");
  content.append(target);
  pane.append(content);
  target.getBoundingClientRect = () => ({ top: at() - pane.scrollTop }) as DOMRect;
  return { pane, content, target };
}

test("holds the message in place while the content above it grows", () => {
  let at = 800;
  const { pane, content, target } = setup(() => at);
  keepInView(pane, content, target);
  expect(pane.scrollTop).toBe(800);
  at = 1100; // an email above finished sizing
  resized?.();
  expect(pane.scrollTop).toBe(1100);
});

test("lets go once the reader scrolls, also over an email's frame where no wheel event reaches the pane", () => {
  let at = 800;
  const { pane, content, target } = setup(() => at);
  keepInView(pane, content, target);
  pane.dispatchEvent(new Event("scroll")); // its own scroll
  expect(resized).not.toBeNull();
  pane.scrollTop = 300;
  pane.dispatchEvent(new Event("scroll"));
  expect(resized).toBeNull();
  at = 1100;
  expect(pane.scrollTop).toBe(300);
});
