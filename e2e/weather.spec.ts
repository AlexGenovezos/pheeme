import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC", viewport: { width: 1280, height: 850 } });

// Monday: the preview's "Lunch with Dana" (Tartine, San Francisco) is on Thursday.
const NOW = new Date("2026-11-09T10:00:00Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    localStorage.setItem("pheeme.calendar", JSON.stringify({ mode: "calendar", view: "week" }));
    localStorage.setItem("pheeme.theme-mode", "light");
    localStorage.setItem(
      "pheeme.weather",
      JSON.stringify({
        enabled: true,
        unit: "fahrenheit",
        home: {
          name: "New York",
          region: "New York",
          country: "United States",
          latitude: 40.71,
          longitude: -74.01,
          timeZone: "America/New_York",
        },
      }),
    );
  });
});

test("the days and an event's place show the forecast", async ({ page }, testInfo) => {
  await page.goto("/");
  const heads = page.locator(".cal-grid__day-head");
  await expect(heads).toHaveCount(7);
  // Monday's forecast (the preview's first day is clear); Sunday the 8th is before it.
  const monday = heads.filter({ hasText: "9" }).first();
  await expect(monday.getByRole("img")).toHaveAccessibleName(/^Clear, high \d+°, low \d+°$/);
  // Each header holds weekday, date and forecast on one line.
  const fits = await heads.evaluateAll((els) =>
    els.every((el) => el.scrollWidth <= el.clientWidth && el.clientHeight < 48),
  );
  expect(fits).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("week.png") });

  await page.getByRole("button", { name: /^Lunch with Dana,/ }).click();
  const popover = page.getByRole("dialog", { name: "Lunch with Dana" });
  await expect(popover.getByText(/in San Francisco/)).toBeVisible();
  await popover.screenshot({ path: testInfo.outputPath("popover.png") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("m");
  await expect(page.locator(".cal-month__week .weather-day[role=img]").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("month.png") });
});

test("Settings › Calendar turns weather off and picks a home town", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".cal-grid__day-head .weather-day[role=img]").first()).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const home = page.getByRole("combobox", { name: "Home location" });
  await expect(home).toHaveValue("New York, United States");
  await home.fill("Lon");
  await page.getByRole("option", { name: "London, England, United Kingdom" }).click();
  await expect(home).toHaveValue("London, England, United Kingdom");
  await page.screenshot({ path: testInfo.outputPath("settings.png") });

  await page.getByRole("switch", { name: "Show weather" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-grid__day-head")).toHaveCount(7);
  await expect(page.locator(".weather-day")).toHaveCount(0);
});
