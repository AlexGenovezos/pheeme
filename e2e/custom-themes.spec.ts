import { expect, test } from "@playwright/test";

const FIXTURES = "src/styles/themes/vscode-fixtures";

test("import VS Code themes, use them, keep them across a relaunch, and remove one", async ({
  page,
}, testInfo) => {
  const shot = async (name: string) =>
    testInfo.attach(name, {
      body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
      contentType: "image/png",
    });
  /** The window background as the eye sees it: painted to a canvas, read back as rgb(). */
  const appBg = () =>
    page.evaluate(() => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    });
  const openAppearance = async () => {
    await page.getByRole("button", { name: /^Settings/ }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
  };

  await page.goto("/");
  await expect(page.locator(".shell")).toBeVisible();
  await openAppearance();
  const settings = page.getByRole("dialog", { name: /Settings/ });

  await settings
    .getByTestId("theme-file-input")
    .setInputFiles([
      `${FIXTURES}/solarized-light-color-theme.json`,
      `${FIXTURES}/monokai-color-theme.json`,
    ]);
  await expect(page.getByText("Installed 2 themes")).toBeVisible();
  // The last file wins: Monokai is dark, so Pheeme switches to Dark mode.
  await expect(settings.getByRole("combobox", { name: "Dark theme" })).toHaveText(/Monokai/);
  await expect(settings.getByRole("combobox", { name: "Light theme" })).toHaveText(
    "Solarized (light)",
  );
  await expect(settings.getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shot("settings-after-import");
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await appBg()).toBe("rgb(39, 40, 34)"); // Monokai's editor.background, #272822
  await shot("monokai");

  await openAppearance();
  await settings.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await appBg()).toBe("rgb(253, 246, 227)"); // Solarized Light, #fdf6e3
  await shot("solarized-light");

  // A relaunch restores both themes and the choice, painted before React by the boot script.
  await page.reload();
  await expect(page.locator(".shell")).toBeVisible();
  expect(await appBg()).toBe("rgb(253, 246, 227)");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("pheeme.theme-boot")!).light),
  ).toBe("#fdf6e3");

  await openAppearance();
  await settings.getByRole("button", { name: "Remove Solarized (light)" }).click();
  await expect(settings.getByRole("combobox", { name: "Light theme" })).toHaveText("Pheeme Light");
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await appBg()).toBe("rgb(255, 255, 255)"); // Pheeme Light
});
