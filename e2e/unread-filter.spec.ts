import { expect, test } from "@playwright/test";

test.use({ video: "on" });

test("unread counts follow keyboard navigation while email details are still loading", async ({
  page,
}, testInfo) => {
  await page.goto("/?threads=3");
  const navigation = page.getByRole("navigation", { name: "Mailboxes" });
  const primary = navigation.getByRole("link", { name: "Primary", exact: true }).first();
  const inboxes = navigation.getByRole("link", { name: "All Inboxes", exact: true });
  await primary.click();
  await page.getByRole("button", { name: "Unread only", exact: true }).click();
  const list = page.getByRole("listbox", { name: "Primary conversations" });
  await expect(list.getByRole("option")).toHaveCount(4);
  const inboxCount = Number.parseInt((await inboxes.getAttribute("aria-description"))!, 10);

  // Hold the detail requests that automatic mark-read waits for. The visible counts must
  // follow each opened row without waiting for those requests or a cache refresh.
  await page.evaluate(() => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    let release!: () => void;
    const details = new Promise<void>((resolve) => (release = resolve));
    Object.assign(window, { releaseUnreadDetails: release });
    ipc.invoke = async (cmd, args) => {
      if (cmd === "get_thread") await details;
      return invoke(cmd, args);
    };
  });
  await page.screenshot({ path: testInfo.outputPath("unread-counts-before.png") });
  await list.focus();
  for (let opened = 1; opened <= 3; opened++) {
    await page.keyboard.press("ArrowDown");
    await expect(primary).toHaveAttribute("aria-description", `${4 - opened} unread`);
    await expect(page.locator(".toolbar__subtitle")).toHaveText(`${4 - opened} unread`);
    await expect(inboxes).toHaveAttribute("aria-description", `${inboxCount - opened} unread`);
    await expect(list.locator('[role="option"]:not([data-unread])')).toHaveCount(opened);
  }
  await page.screenshot({ path: testInfo.outputPath("unread-counts-after.png") });
  await page.evaluate(() => {
    (window as unknown as { releaseUnreadDetails(): void }).releaseUnreadDetails();
  });
  await expect(
    page.getByRole("main", { name: "Reading pane" }).getByText("My notes are at", { exact: false }),
  ).toBeVisible();
  await expect(primary).toHaveAttribute("aria-description", "1 unread");
  await expect(page.locator(".toolbar__subtitle")).toHaveText("1 unread");
});

test("unread filtering survives reading and mailbox changes, and stays separate from search", async ({
  page,
}) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Unread only", exact: true });
  const rows = page.getByRole("listbox", { name: "All Inboxes conversations" }).getByRole("option");
  const statement = rows.filter({ hasText: "Your October statement is ready" });
  const icon = rows.filter({ hasText: "Icon sketches for the dock" });
  await expect(statement).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: "test-results/unread-before.png" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(statement).toHaveCount(0);
  expect(
    await rows.evaluateAll((elements) =>
      elements.every((element) => element.getAttribute("data-unread") === "true"),
    ),
  ).toBe(true);
  const filteredCount = await rows.count();
  await expect(icon).toBeVisible();
  await page.screenshot({ path: "test-results/unread-after.png" });

  // Opening marks it read and emits a sync; it must stay where the reader opened it.
  await icon.click();
  await expect(icon).not.toHaveAttribute("data-unread", "true");
  await expect(rows).toHaveCount(filteredCount);
  await expect(icon).toBeVisible();

  // Undoing another row's archive must not clear this visit's just-read row.
  const other = rows.filter({ hasText: "Pilot for the support team" });
  await other.hover();
  await other.getByRole("button", { name: "Archive", exact: true, includeHidden: true }).click();
  await expect(other).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(other).toBeVisible();
  await expect(icon).toBeVisible();
  await expect(rows).toHaveCount(filteredCount);

  const navigation = page.getByRole("navigation", { name: "Mailboxes" });
  await navigation.getByRole("link", { name: "Starred", exact: true }).first().click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await navigation.getByRole("link", { name: "All Inboxes", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(icon).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search mail" }).fill("statement");
  await expect(toggle).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(statement).toHaveCount(0);
  await toggle.click();
  await expect(statement).toBeVisible();
});
