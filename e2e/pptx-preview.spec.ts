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

/** Opens the app under the production CSP and previews the sample deck; returns its slides. */
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
  const deck = page
    .getByRole("dialog", { name: "Preview: icon-review.pptx" })
    .locator(".file-preview__slides");
  await expect(deck).toHaveAttribute("data-state", "ready");
  return deck;
}

test("a PowerPoint attachment previews slide by slide under the app's CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => /Content.Security.Policy/i.test(m.text()) && violations.push(m.text()));
  const deck = await previewDeck(page);

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

  expect(violations).toEqual([]);
});

test("chart tooltips can't put a deck's markup into the app", async ({ page }) => {
  // A bubble chart whose series name is HTML: the renderer's tooltip would insert it unescaped.
  await page.route("**/sample-*.pptx", (route) =>
    route.fulfill({ path: "e2e/fixtures/chart-tooltip.pptx" }),
  );
  const deck = await previewDeck(page);
  const chart = deck.locator("canvas").first();
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  for (let x = 0.05; x < 1; x += 0.05)
    for (let y = 0.05; y < 1; y += 0.1)
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await expect(page.locator("#injected")).toHaveCount(0);
});
