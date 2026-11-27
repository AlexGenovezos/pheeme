import { expect, test } from "vitest";
import { canvasFit } from "./PdfView";

test("a page's canvas stays within what a webview will draw", () => {
  expect(canvasFit({ width: 1600, height: 2000 })).toBe(1);
  // A long side past 4096 shrinks to it.
  expect(canvasFit({ width: 1000, height: 8192 })).toBe(0.5);
  // Both sides within it, but the area past 16 megapixels.
  const fit = canvasFit({ width: 4000, height: 4000 });
  expect(4000 * fit * 4000 * fit).toBeLessThanOrEqual(16_000_000 + 1);
});
