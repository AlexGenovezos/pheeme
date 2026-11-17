import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC", viewport: { width: 1280, height: 850 }, deviceScaleFactor: 2 });

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
  // Its words add the hours the sun is out, which the grid draws as a band that holds still
  // once the opening burst is over.
  await expect(monday.getByRole("img")).toHaveAccessibleName(
    /^Clear, high \d+°, low \d+°\. Sun \d+ AM–\d+ PM$/,
  );
  const sun = page.locator('.cal-grid__column[data-date="2026-11-09"] .wx-hours--sun');
  await expect(sun).toBeVisible();
  await expect(sun).not.toHaveClass(/wx-hours--playing/, { timeout: 10_000 });
  // Each header holds weekday, date and forecast on one line.
  const fits = await heads.evaluateAll((els) =>
    els.every((el) => el.scrollWidth <= el.clientWidth && el.clientHeight < 48),
  );
  expect(fits).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("week.png") });

  // The drawings hold still until hovered.
  const rays = monday.locator(".wx-sun__glow");
  await expect(rays).toHaveCSS("animation-play-state", "paused");
  await monday.getByRole("img").hover();
  await expect(rays).toHaveCSS("animation-play-state", "running");

  await page.getByRole("button", { name: /^Lunch with Dana,/ }).click();
  const popover = page.getByRole("dialog", { name: "Lunch with Dana" });
  const forecast = popover.locator(".weather-event");
  await expect(forecast).toContainText("San Francisco · Thursday");
  // The scene moves: rain falls between two frames.
  const art = forecast.locator(".weather-art");
  await expect(art).toHaveClass(/weather-art--live/);
  const before = await art.screenshot();
  await page.waitForTimeout(400);
  expect((await art.screenshot()).equals(before)).toBe(false);
  await popover.screenshot({ path: testInfo.outputPath("popover.png") });
  // The little pause button holds every drawing still.
  await forecast.getByRole("button", { name: "Stop weather animation" }).click();
  const still = await art.screenshot();
  await page.waitForTimeout(400);
  expect((await art.screenshot()).equals(still)).toBe(true);
  await forecast.getByRole("button", { name: "Animate weather" }).click();
  await page.keyboard.press("Escape");

  await page.keyboard.press("m");
  await expect(page.locator(".cal-month__week .weather-day[role=img]").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("month.png") });
  await page
    .locator(".cal-month__week")
    .nth(2)
    .screenshot({
      path: testInfo.outputPath("month-week.png"),
      scale: "device",
    });
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
