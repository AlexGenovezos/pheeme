import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * The app's production CSP, as a meta tag. Two preview-only allowances: Tauri hashes the inline
 * boot script into `script-src` at build time, which the preview server can't, and the preview
 * fetches its sample attachments (small ones inlined as data: URLs), where the app uses IPC.
 */
function productionCsp(): string {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const csp: Record<string, string> = { ...conf.app.security.csp };
  csp["script-src"] += " 'unsafe-inline'";
  csp["connect-src"] += " 'self' data:";
  return Object.entries(csp)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

/**
 * Opens the app under the production CSP and previews the sample deck; returns the frame it's drawn
 * in and its slides.
 */
async function previewDeck(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.route("/", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${productionCsp()}">`,
    );
    await route.fulfill({ response, body: html });
  });
  await page.goto("/");
  await page.getByRole("option", { name: /Icon sketches for the dock/ }).click();
  await page.getByRole("button", { name: "Preview icon-review.pptx" }).click();
  const frame = page
    .getByRole("dialog", { name: "Preview: icon-review.pptx" })
    .locator("iframe.file-preview__slides");
  await expect(frame).toHaveAttribute("data-state", "ready");
  // Script-less: nothing the deck puts in the frame can run.
  await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  // Match the frame's own light document so dark mode doesn't paint an opaque white canvas.
  await expect(frame).toHaveCSS("color-scheme", "light");
  return { frame, deck: frame.contentFrame().locator("#deck") };
}

test("a PowerPoint attachment previews slide by slide under the app's CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => /Content.Security.Policy/i.test(m.text()) && violations.push(m.text()));
  const { deck } = await previewDeck(page);

  await expect(deck.getByText("Icon refresh", { exact: true })).toBeVisible();
  await expect(deck.getByText("Three directions explored, one favourite")).toBeVisible();
  // Pictures come out of the file as blob: URLs, which the CSP has to allow.
  await expect
    .poll(() =>
      deck
        .locator("img")
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);

  // The chart slide mounts as it scrolls into view.
  await deck.getByText("Hours by platform").scrollIntoViewIfNeeded();
  await expect(deck.getByText("Hours by platform")).toBeVisible();
  await expect(deck.locator("canvas").first()).toBeVisible();

  // Every slide was drawn at the deck's width, inside the frame.
  const widths = await deck
    .locator("[data-slide-index]")
    .evaluateAll((slides) => slides.map((s) => s.getBoundingClientRect().width));
  expect(widths.length).toBe(3);
  for (const width of widths) expect(width).toBeGreaterThan(600);

  expect(violations).toEqual([]);
});

test("a deck's embedded fonts reach the frame it's drawn in", async ({ page }) => {
  // The sample deck with a font embedded for Arial, the typeface of its text.
  await page.route("**/sample-*.pptx", (route) =>
    route.fulfill({ path: "e2e/fixtures/embedded-font.pptx" }),
  );
  const { frame, deck } = await previewDeck(page);
  const title = deck.getByText("Icon refresh", { exact: true });
  await expect(title).toBeVisible();
  // The renderer draws the text in a family of its own naming, registered on the app's document.
  const family = await title.evaluate((el) => getComputedStyle(el).fontFamily);
  const embedded = /__pptx_embedded_\w+/.exec(family)?.[0];
  expect(embedded, family).toBeTruthy();
  await expect
    .poll(() =>
      frame.evaluate(
        (f: HTMLIFrameElement, name) =>
          [...f.contentDocument!.fonts].some(
            (face) => face.family.replace(/"/g, "") === name && face.status === "loaded",
          ),
        embedded!,
      ),
    )
    .toBe(true);
});

test("chart tooltips can't put a deck's markup into the app", async ({ page }) => {
  // A bubble chart whose series name is HTML: the renderer's tooltip would insert it unescaped.
  await page.route("**/sample-*.pptx", (route) =>
    route.fulfill({ path: "e2e/fixtures/chart-tooltip.pptx" }),
  );
  const { deck } = await previewDeck(page);
  const chart = deck.locator("canvas").first();
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  for (let x = 0.05; x < 1; x += 0.05)
    for (let y = 0.05; y < 1; y += 0.1)
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await expect(page.locator("#injected")).toHaveCount(0);
  await expect(deck.locator("#injected")).toHaveCount(0);
});

test("clicking a slide keeps focus in the frame, traps Tab, ignores Shift+Arrow, and Escape closes", async ({
  page,
}) => {
  const { frame, deck } = await previewDeck(page);
  const dialog = page.getByRole("dialog", { name: "Preview: icon-review.pptx" });
  await deck.getByText("Icon refresh", { exact: true }).click();
  // Focus stays in the frame (not stolen back to the stage) so copy and Page Down work.
  await expect(frame).toBeFocused();
  const scroller = frame.contentFrame().locator("#scroller");
  await page.keyboard.press("PageDown");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // Shift+ArrowRight adjusts selection rather than stepping to the next attachment.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(dialog).toBeVisible();
  // Tabbing out of the frame stays trapped inside the modal dialog.
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
    .toBe(true);
  await deck.getByText("Icon refresh", { exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
