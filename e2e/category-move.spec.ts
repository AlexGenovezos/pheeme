import { expect, type Locator, type Page, test } from "@playwright/test";

/** Press on `from`, drag in steps onto `to` (past the 5 px threshold), then let go unless `release` is false. */
async function drag(page: Page, from: Locator, to: Locator, { release = true } = {}) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  if (release) await page.mouse.up();
}

test("drag a conversation onto Updates, choose just this, and it moves tabs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  const account = page.getByRole("group", { name: "avery@example.com" });
  await account.getByRole("link", { name: "Primary", exact: true }).click();
  const list = page.getByRole("listbox", { name: "Primary conversations" });
  const row = list.getByRole("option").first();
  const subject = (await row.locator(".ui-row__subtitle").textContent())!.trim();
  const updates = account.getByRole("link", { name: "Updates", exact: true });

  await drag(page, row, updates, { release: false });
  await expect(page.locator(".mail-drag-card")).toHaveText("1 conversation");
  await expect(updates).toHaveAttribute("data-drop-active", "");
  // Another account's tab doesn't take this account's mail.
  const other = page
    .getByRole("group", { name: "avery@example.org" })
    .getByRole("link", { name: "Social", exact: true });
  const o = (await other.boundingBox())!;
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2, { steps: 4 });
  await expect(other).not.toHaveAttribute("data-drop-active");
  const u = (await updates.boundingBox())!;
  await page.mouse.move(u.x + u.width / 2, u.y + u.height / 2, { steps: 4 });
  await page.screenshot({ path: testInfo.outputPath("dragging.png") });
  await page.mouse.up();

  const dialog = page.getByRole("dialog", { name: "Move to Updates" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /future mail/ })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("choice.png") });
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(list.getByText(subject, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Moved to "Updates"')).toBeVisible();

  await updates.click();
  await expect(
    page
      .getByRole("listbox", { name: "Updates conversations" })
      .getByText(subject, { exact: true }),
  ).toBeVisible();
});

test("future mail too saves a rule that Settings lists", async ({ page }) => {
  await page.goto("/");
  const account = page.getByRole("group", { name: "avery@example.com" });
  await account.getByRole("link", { name: "Primary", exact: true }).click();
  const row = page
    .getByRole("listbox", { name: "Primary conversations" })
    .getByRole("option")
    .first();
  await drag(page, row, account.getByRole("link", { name: "Forums", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Move to Forums" });
  const future = dialog.getByRole("radio", { name: /future mail/ });
  const sender = (await future
    .locator("xpath=..")
    .locator(".category-move__sender")
    .textContent())!;
  await future.check();
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText(`Future mail from ${sender} goes there too`)).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sender rules" }).click();
  const rules = page.getByRole("region", { name: "avery@example.com" });
  await expect(rules).toContainText(sender);
  await expect(rules).toContainText("Goes to Forums");
});

test("Escape mid-drag drops nothing", async ({ page }) => {
  await page.goto("/");
  const account = page.getByRole("group", { name: "avery@example.com" });
  await account.getByRole("link", { name: "Primary", exact: true }).click();
  const row = page
    .getByRole("listbox", { name: "Primary conversations" })
    .getByRole("option")
    .first();
  const updates = account.getByRole("link", { name: "Updates", exact: true });
  await drag(page, row, updates, { release: false });
  await page.keyboard.press("Escape");
  await expect(page.locator(".mail-drag-card")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "Move to Updates" })).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Primary conversations" })).toBeVisible();
});
