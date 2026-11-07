import { expect, test } from "@playwright/test";
import type { PreviewInvoke } from "../src/preview/install";
import type { ThreadDetail } from "../src/lib/tauri";

test.use({ video: "on" });

for (const html of [false, true]) {
  test(`Left returns from a ${html ? "HTML" : "plain-text"} email to Up/Down navigation`, async ({
    page,
  }, testInfo) => {
    const list = page.getByRole("listbox", { name: /conversations$/ });
    const rows = list.getByRole("option");
    await page.addInitScript((html) => {
      const win = window as unknown as { __PHEEME_PREVIEW_INVOKE__: PreviewInvoke };
      win.__PHEEME_PREVIEW_INVOKE__ = async (cmd, args, next) => {
        const result = await next(cmd, args);
        if (cmd !== "get_thread") return result;
        const detail = result as ThreadDetail;
        return {
          ...detail,
          messages: [
            {
              ...detail.messages[detail.messages.length - 1],
              bodyHtml: html ? "<p>Keyboard navigation email</p>" : null,
              bodyText: "Keyboard navigation email",
            },
          ],
        };
      };
    }, html);
    await page.goto("/");
    await expect(rows.first()).toBeVisible();

    const firstId = await rows.nth(0).getAttribute("id");
    const secondId = await rows.nth(1).getAttribute("id");
    await rows.nth(1).click();
    await expect(list).toBeFocused();
    await expect(list).toHaveAttribute("aria-activedescendant", secondId!);

    const body = html
      ? page
          .frameLocator('iframe[title="Message body"]:visible')
          .getByText("Keyboard navigation email")
      : page
          .locator('.thread-view__retained[data-visible="true"]')
          .getByText("Keyboard navigation email", { exact: true });
    await body.click();
    await expect(list).not.toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("before-returning-to-list.png") });
    await page.keyboard.press("ArrowLeft");
    await expect(list).toBeFocused();
    await expect(list).toHaveAttribute("aria-activedescendant", secondId!);
    await page.keyboard.press("ArrowUp");
    await expect(list).toHaveAttribute("aria-activedescendant", firstId!);
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", secondId!);
    await expect(list).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("keyboard-navigation.png") });
  });
}

test("Right focuses the open email so the arrows scroll it, and Left goes back", async ({
  page,
}) => {
  const list = page.getByRole("listbox", { name: /conversations$/ });
  const rows = list.getByRole("option");
  await page.addInitScript(() => {
    const win = window as unknown as { __PHEEME_PREVIEW_INVOKE__: PreviewInvoke };
    win.__PHEEME_PREVIEW_INVOKE__ = async (cmd, args, next) => {
      const result = await next(cmd, args);
      if (cmd !== "get_thread") return result;
      const detail = result as ThreadDetail;
      const long = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
      return {
        ...detail,
        messages: [
          { ...detail.messages[detail.messages.length - 1], bodyHtml: null, bodyText: long },
        ],
      };
    };
  });
  await page.goto("/");
  await expect(rows.first()).toBeVisible();

  const secondId = await rows.nth(1).getAttribute("id");
  await rows.nth(1).click();
  await expect(list).toBeFocused();
  const pane = page.getByRole("region", { name: "Open conversation" });
  await expect(
    pane.locator('.thread-view__retained[data-visible="true"]').getByText("Line 199"),
  ).toBeAttached();

  await page.keyboard.press("ArrowRight");
  await expect(pane).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("PageDown");
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // Scrolling the email doesn't move through the list.
  await expect(list).toHaveAttribute("aria-activedescendant", secondId!);

  await page.keyboard.press("ArrowLeft");
  await expect(list).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list).not.toHaveAttribute("aria-activedescendant", secondId!);
});
