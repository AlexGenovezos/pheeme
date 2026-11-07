import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleScrollKeyDown, handleScrollKeyUp, stopKeyScroll } from "./keyScroll";

let now = 0;
let nextId = 0;
let frames = new Map<number, FrameRequestCallback>();

/** Runs animation frames 16ms apart for `ms`. */
function advance(ms: number) {
  for (const end = now + ms; now < end;) {
    now += 16;
    const due = [...frames.values()];
    frames = new Map();
    due.forEach((cb) => cb(now));
  }
}

function pane() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 5000 });
  Object.defineProperty(el, "clientHeight", { value: 500 });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.round(Math.min(Math.max(v, 0), 4500));
    },
  });
  return el;
}

const key = (type: string, init: KeyboardEventInit) => new KeyboardEvent(type, init);
const down = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  handleScrollKeyDown(el, key("keydown", { key: k, cancelable: true, ...init }));
const up = (el: HTMLElement, k: string) => handleScrollKeyUp(el, key("keyup", { key: k }));

beforeEach(() => {
  now = 0;
  frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++nextId, cb);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a tap glides one step instead of jumping", () => {
  const el = pane();
  expect(down(el, "ArrowDown")).toBe(true);
  up(el, "ArrowDown");
  expect(el.scrollTop).toBe(0);
  advance(32);
  const early = el.scrollTop;
  expect(early).toBeGreaterThan(0);
  expect(early).toBeLessThan(40);
  advance(1000);
  expect(el.scrollTop).toBe(40);
  expect(frames.size).toBe(0);
});

test("holding the key glides on, then eases to a stop on release", () => {
  const el = pane();
  down(el, "ArrowDown");
  advance(600);
  down(el, "ArrowDown", { repeat: true });
  advance(400);
  const atRelease = el.scrollTop;
  expect(atRelease).toBeGreaterThan(300);
  up(el, "ArrowDown");
  advance(1000);
  expect(el.scrollTop).toBeGreaterThan(atRelease);
  expect(el.scrollTop).toBeLessThan(atRelease + 150);
  expect(frames.size).toBe(0);
});

test("ArrowUp scrolls back and stops at the top", () => {
  const el = pane();
  el.scrollTop = 30;
  down(el, "ArrowUp");
  up(el, "ArrowUp");
  advance(1000);
  expect(el.scrollTop).toBe(0);
});

test("leaves modified arrows and other keys alone", () => {
  const el = pane();
  expect(down(el, "ArrowDown", { shiftKey: true })).toBe(false);
  expect(down(el, "ArrowDown", { metaKey: true })).toBe(false);
  expect(down(el, "j")).toBe(false);
  expect(frames.size).toBe(0);
});

test("leaves keys typed in a text field alone", () => {
  const el = pane();
  const input = el.appendChild(document.createElement("input"));
  const event = key("keydown", { key: "ArrowDown", cancelable: true });
  Object.defineProperty(event, "target", { value: input });
  expect(handleScrollKeyDown(el, event)).toBe(false);
});

test("another scroll (the wheel, a new thread) takes over", () => {
  const el = pane();
  down(el, "ArrowDown");
  advance(32);
  el.scrollTop = 2000;
  advance(1000);
  expect(el.scrollTop).toBe(2000);
});

test("stopKeyScroll halts a glide at once", () => {
  const el = pane();
  down(el, "ArrowDown");
  advance(32);
  stopKeyScroll(el);
  const stopped = el.scrollTop;
  advance(1000);
  expect(el.scrollTop).toBe(stopped);
});

test("focus leaving the pane mid-glide lets go of the key, since its keyup goes elsewhere", () => {
  const el = pane();
  down(el, "ArrowDown");
  advance(500);
  el.dispatchEvent(new FocusEvent("blur"));
  advance(1000);
  const settled = el.scrollTop;
  advance(1000);
  expect(el.scrollTop).toBe(settled);
  expect(frames.size).toBe(0);
});
