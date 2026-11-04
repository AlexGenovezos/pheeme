import { expect, test } from "@playwright/test";

test("install, use, configure, disable and remove a mod", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Mods", exact: true })
    .click();
  await testInfo.attach("before-mod-install", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Install from folder" }).click();
  await expect(page.getByRole("heading", { name: "Install Counter?" })).toBeVisible();
  await testInfo.attach("permission-review", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await expect(page.getByRole("region", { name: "Mods", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Install and enable" }).click();
  await expect(page.getByRole("switch", { name: "Enable Counter" })).toBeChecked();
  await page.getByRole("button", { name: "Close settings" }).click();

  const sidebar = page.getByRole("region", { name: "Mods", exact: true });
  await sidebar.getByRole("button", { name: "+1" }).click();
  await expect(sidebar.getByText("My counter: 1")).toBeVisible();
  await sidebar.getByRole("button", { name: "Counter", exact: true }).click();
  const panel = page.getByRole("region", { name: "Counter panel" });
  await panel.getByRole("button", { name: "Add one" }).click();
  await expect(panel.getByText("My counter: 2")).toBeVisible();
  await testInfo.attach("installed-mod-panel", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: /Settings/ });
  await settings.getByRole("textbox", { name: "Counter name" }).fill("Songs saved");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(sidebar.getByText("Songs saved: 2")).toBeVisible();
  await panel.getByRole("button", { name: "Close mod panel" }).click();

  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Mods", exact: true })
    .click();
  await page.getByRole("switch", { name: "Enable Counter" }).click();
  await expect(sidebar).toHaveCount(0);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByText("Add personal features without maintaining a fork.")).toBeVisible();
});
