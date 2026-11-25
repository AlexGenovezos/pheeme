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
function setup(at: () => number, scrollHeight = () => 2000) {
  const pane = document.createElement("div");
  Object.defineProperty(pane, "scrollHeight", { get: scrollHeight });
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

test("a scroll the layout caused (a frame above shrinking clamps it) keeps holding", () => {
  let at = 800;
  let tall = 2000;
  const { pane, content, target } = setup(
    () => at,
    () => tall,
  );
  keepInView(pane, content, target);
  tall = 1000; // a frame above shrank, and the browser clamped the scroll
  at = 500;
  pane.scrollTop = 600;
  pane.dispatchEvent(new Event("scroll"));
  expect(resized).not.toBeNull();
  expect(pane.scrollTop).toBe(500);
  tall = 2000; // and grew again
  at = 800;
  resized?.();
  expect(pane.scrollTop).toBe(800);
});
