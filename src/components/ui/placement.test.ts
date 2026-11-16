import { describe, expect, it } from "vitest";
import { clampToWindow, placeBeside, placeByField } from "./placement";

const VIEW = { width: 1000, height: 800 };
const anchor = (left: number, top: number, width = 100, height = 40) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
});

describe("clampToWindow", () => {
  const size = { width: 200, height: 300 };
  it("leaves a panel that fits where it was opened", () => {
    expect(clampToWindow({ x: 100, y: 50 }, size, VIEW)).toEqual({ x: 100, y: 50 });
  });
  it("pulls a panel back from the right and bottom edges", () => {
    expect(clampToWindow({ x: 950, y: 700 }, size, VIEW)).toEqual({ x: 800, y: 500 });
  });
  it("never goes past the top or left edge", () => {
    expect(clampToWindow({ x: -20, y: -5 }, size, VIEW)).toEqual({ x: 0, y: 0 });
  });
  it("keeps a margin from every edge", () => {
    expect(clampToWindow({ x: 950, y: 0 }, size, VIEW, 8)).toEqual({ x: 792, y: 8 });
  });
  it("pins a panel larger than the window to the near edge", () => {
    expect(clampToWindow({ x: 50, y: 50 }, { width: 1200, height: 900 }, VIEW)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("placeBeside", () => {
  const size = { width: 300, height: 200 };
  it("goes to the right of the anchor, level with its top", () => {
    expect(placeBeside(anchor(100, 120), size, VIEW)).toEqual({ left: 208, top: 120 });
  });
  it("flips to the left when the right side has no room", () => {
    // 800 + 100 + 8 + 300 > 1000 - 8.
    expect(placeBeside(anchor(800, 120), size, VIEW)).toEqual({ left: 492, top: 120 });
  });
  it("stays on the right when it just fits", () => {
    expect(placeBeside(anchor(584, 0), size, VIEW)).toEqual({ left: 692, top: 8 });
  });
  it("is clamped when neither side has room", () => {
    const wide = { width: 900, height: 200 };
    expect(placeBeside(anchor(400, 100, 200), wide, VIEW)).toEqual({ left: 8, top: 100 });
  });
  it("is lifted when the anchor is near the bottom", () => {
    expect(placeBeside(anchor(100, 700), size, VIEW)).toEqual({ left: 208, top: 592 });
  });
  it("sits near the middle with no anchor", () => {
    expect(placeBeside(null, size, VIEW)).toEqual({ left: 350, top: 800 / 3 - 200 / 3 });
  });
});

describe("placeByField", () => {
  const gap = 4;
  const content = { width: 160, scrollHeight: 200 };
  it("hangs under the field when it fits", () => {
    expect(placeByField(anchor(100, 100), content, VIEW, { gap })).toEqual({
      left: 100,
      top: 144,
      minWidth: undefined,
      maxHeight: undefined,
    });
  });
  it("opens over the field when there is more room there", () => {
    const at = anchor(100, 700);
    expect(placeByField(at, content, VIEW, { gap })).toMatchObject({ top: 700 - gap - 200 });
  });
  it("shrinks to the room left and scrolls when neither side holds it", () => {
    const tall = { width: 160, scrollHeight: 900 };
    const placed = placeByField(anchor(100, 300), tall, VIEW, { gap });
    // Below: 800 - 340 - 8 = 452; above: 300 - 8 = 292; so it goes down and is capped to 452.
    expect(placed).toMatchObject({ top: 344, maxHeight: 452 });
  });
  it("never lifts the CSS cap on a list", () => {
    const placed = placeByField(anchor(100, 100), { width: 160, scrollHeight: 500 }, VIEW, {
      gap,
      cap: 240,
    });
    expect(placed.maxHeight).toBe(240);
  });
  it("keeps the popover inside the window horizontally", () => {
    expect(placeByField(anchor(950, 100), content, VIEW, { gap }).left).toBe(1000 - 160 - gap);
  });
  it("is at least as wide as the field when asked", () => {
    const placed = placeByField(anchor(950, 100, 120), content, VIEW, { gap, matchWidth: true });
    expect(placed).toMatchObject({ minWidth: 120, left: 1000 - 160 - gap });
    const narrow = placeByField(anchor(950, 100, 300), content, VIEW, { gap, matchWidth: true });
    expect(narrow.left).toBe(1000 - 300 - gap);
  });
});
