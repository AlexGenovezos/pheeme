import { expect, test } from "@playwright/test";

test("the website embeds the real app, including actions and lazy-loaded compose", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    // The product video is recorded after these checks (npm run video:site), which fails
    // if it can't write every file the page links to.
    if (url.startsWith("http://127.0.0.1:4174/video/")) return;
    if (url.startsWith("http://127.0.0.1:4174/") && response.status() >= 400) {
      errors.push(`${response.status()} ${url}`);
    }
  });

  await page.goto("/");
  await page.getByTitle("Try Pheeme with sample mail").scrollIntoViewIfNeeded();
  const app = page.frameLocator(".demo-frame");
  await expect(app.getByRole("complementary", { name: "Sidebar", exact: true })).toBeVisible();
  const conversation = app.locator('[role="option"][id="thread-acc-personal_3a_p-01"]');
  await conversation.click();
  await expect(app.getByRole("main", { name: "Reading pane" })).toContainText(
    "Icon sketches for the dock",
  );

  // This exercises the app's real shortcut registry, stores and fixture backend.
  await app.getByRole("listbox").press("e");
  await expect(conversation).toHaveCount(0);
  await app.getByRole("searchbox", { name: "Search mail" }).fill("Icon sketches");
  await expect(conversation).toBeVisible();

  // The editor is a separate bundle: its assets must resolve under /demo/ too.
  await app.getByRole("button", { name: "New message", exact: true }).click();
  await expect(app.getByLabel("Subject", { exact: true })).toBeVisible();
  await app.getByLabel("Subject", { exact: true }).fill("Trying Pheeme");

  // Demo mutations last only for this session and never require a mail account.
  await page.reload();
  await page.getByTitle("Try Pheeme with sample mail").scrollIntoViewIfNeeded();
  await expect(conversation).toBeVisible();
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(app.getByRole("dialog", { name: /Settings/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("onboarding assets load from the app's subdirectory", async ({ page }) => {
  await page.goto("/demo/?accounts=0");
  await expect(page.getByRole("heading", { name: "Free for good, and your mail stays yours." })).toBeVisible();
  const mark = page.locator(".intro__art img");
  await expect(mark).toHaveAttribute("src", "/demo/pheeme-icon.png");
  await expect.poll(() => mark.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test.describe("mobile demo", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "no-preference",
  });

  test("swiping inside the app reveals the reading pane", async ({ page, context }) => {
    await page.goto("/");
    const frame = page.getByTitle("Try Pheeme with sample mail");
    await frame.scrollIntoViewIfNeeded();
    const app = page.frameLocator(".demo-frame");
    await expect(app.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
    await expect(page.getByText("Swipe sideways to explore.")).toBeVisible();
    expect(await page.locator("#demo").evaluate((el) => el.clientWidth <= innerWidth)).toBe(true);

    const viewport = page.locator(".demo-viewport");
    expect(await viewport.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Start inside the iframe: programmatic scrolling misses blocked scroll chaining.
    const bounds = (await viewport.boundingBox())!;
    const touch = await context.newCDPSession(page);
    const x = Math.min(bounds.x + bounds.width - 30, 360);
    const y = Math.min(bounds.y + 180, 750);
    for (let swipe = 0; swipe < 3; swipe++) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 12; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - step * 20, y }],
        });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await touch.detach();
    await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(500);

    // The same build also works outside the embed, with its own sample-mail session.
    await expect(page.getByRole("link", { name: "Open full demo" })).toHaveAttribute("href", "/demo/");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/demo/");
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
  });
});
