import { expect, type Page, test } from "@playwright/test";

/**
 * The JavaScript built-ins pdf.js calls that an older Mac's WebKit lacks (Safari before 26.2, as on
 * macOS 15): removed from the window and from every worker before the app's code runs, so the
 * browser stands in for that webview. Without `pdfjsPolyfills.ts` the page fails to draw with
 * "TypeError | getOptionalContentConfig", as it did for a user.
 */
const STRIP = `for (const [owner, key] of [
  [Map.prototype, "getOrInsertComputed"], [Map.prototype, "getOrInsert"],
  [WeakMap.prototype, "getOrInsertComputed"], [WeakMap.prototype, "getOrInsert"],
  [Math, "sumPrecise"], [Promise, "try"],
  [Uint8Array, "fromBase64"], [Uint8Array, "fromHex"],
  [Uint8Array.prototype, "toBase64"], [Uint8Array.prototype, "toHex"],
  [Uint8Array.prototype, "setFromBase64"], [Uint8Array.prototype, "setFromHex"],
]) delete owner[key];`;

async function useOldWebKit(page: Page) {
  await page.addInitScript((strip) => {
    // oxlint-disable-next-line no-new-func -- the same removal, here and in each worker
    new Function(strip)();
    Object.assign(window, { stripped: !Reflect.has(Map.prototype, "getOrInsertComputed") });
    const NativeWorker = window.Worker;
    // A worker runs the removal first, then the script it was asked for.
    window.Worker = function (url: string | URL, options?: WorkerOptions) {
      const target = JSON.stringify(new URL(url, location.href).href);
      const source = `${strip}\nawait import(${target});`;
      const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      return new NativeWorker(blob, { ...options, type: "module" });
    } as unknown as typeof Worker;
  }, STRIP);
}

/** Previews the sample invoice; returns its first page. */
async function previewInvoice(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.getByRole("option", { name: /Invoice R0042817/ }).click();
  await page.getByRole("button", { name: "Preview R0042817.pdf" }).click();
  return page
    .getByRole("dialog", { name: "Preview: R0042817.pdf" })
    .locator(".file-preview__page")
    .first();
}

/** Whether the canvas holds more than one colour: something was drawn on it. */
const drawn = (page: ReturnType<Page["locator"]>) =>
  page.locator("canvas").evaluate((c: HTMLCanvasElement) => {
    if (!c.width || !c.height) return false;
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    for (let i = 4; i < data.length; i += 4)
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return true;
    return false;
  });

test("a PDF draws in a webview without the newest built-ins", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await useOldWebKit(page);
  const first = await previewInvoice(page);

  await expect.poll(() => drawn(first), { timeout: 15_000 }).toBe(true);
  await expect(first.getByText(/couldn't draw/)).toHaveCount(0);
  // The removal happened before the app's code ran, so what drew the page was core-js's version.
  expect(await page.evaluate(() => Reflect.get(window, "stripped"))).toBe(true);
  expect(errors).toEqual([]);
});

test("a PDF still draws where no worker can start", async ({ page }) => {
  // pdf.js then imports its worker file into the window and needs its `WorkerMessageHandler`.
  await page.addInitScript(() => {
    window.Worker = function () {
      throw new Error("Workers are blocked");
    } as unknown as typeof Worker;
  });
  const first = await previewInvoice(page);

  await expect.poll(() => drawn(first), { timeout: 15_000 }).toBe(true);
  await expect(first.getByText(/couldn't draw/)).toHaveCount(0);
});

test("a page pdf.js can't draw says so in its place", async ({ page }) => {
  // Every page fails to draw: what any future gap in the built-ins would look like.
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  const first = await previewInvoice(page);
  const before = await first.boundingBox();

  await expect(first.getByText("Pheeme couldn't draw page 1.", { exact: false })).toBeVisible();
  // The message sits in the page's own frame: nothing moves.
  expect(await first.boundingBox()).toEqual(before);
});
