import { expect, test } from "@playwright/test";

test("compose stays visible and opens a message with either sidebar state", async ({ page }) => {
  await page.goto("/");
  for (const collapse of [true, false]) {
    await page.getByRole("button", { name: collapse ? "Hide sidebar" : "Show sidebar" }).click();
    const compose = page.getByRole("button", { name: "New message", exact: true });
    await expect(compose).toBeVisible();
    await expect(compose).toHaveAttribute("title", /New message/);
    await compose.click();
    const panel = page.getByRole("region", { name: "New message", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toBeHidden();
  }
});
