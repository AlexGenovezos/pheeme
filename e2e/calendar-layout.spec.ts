import { expect, test } from "@playwright/test";
import type { CalendarEvent } from "../src/lib/tauri";
import type { PreviewInvoke } from "../src/preview/install";

test.use({ timezoneId: "UTC", viewport: { width: 1180, height: 850 } });

test("a tall, narrow event shows its full title and details with inline icons", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-14T10:00:00Z"));
  await page.addInitScript(() => {
    localStorage.setItem("pheeme.calendar", JSON.stringify({ mode: "calendar", view: "week" }));
    localStorage.setItem("pheeme.theme-mode", "light");
    const win = window as unknown as { __PHEEME_PREVIEW_INVOKE__: PreviewInvoke };
    win.__PHEEME_PREVIEW_INVOKE__ = async (cmd, args, next) => {
      const result = await next(cmd, args);
      if (cmd !== "calendar_events") return result;
      const base = (result as CalendarEvent[])[0];
      return ["Byzantine Chant Workshop", "Another event"].map((summary, i) => ({
        ...base,
        id: `narrow-${i}`,
        summary,
        allDay: false,
        start: { ms: Date.parse("2026-11-14T10:00:00Z"), date: null, timeZone: "UTC" },
        end: { ms: Date.parse("2026-11-14T17:00:00Z"), date: null, timeZone: "UTC" },
        location: "St John the Baptist Church",
        meeting: null,
        selfResponse: null,
      }));
    };
  });
  await page.goto("/");
  const event = page.getByRole("button", { name: /^Byzantine Chant Workshop,/ });
  await expect(event).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("narrow-calendar.png") });

  await expect(event.locator(".cal-event__time")).toHaveText("10:00 AM – 5:00 PM");
  await expect(event.locator(".cal-event__location")).toHaveText("St John the Baptist Church");
  const layout = await event.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const title = el.querySelector<HTMLElement>(".cal-event__title")!;
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let fits = true;
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      fits &&= [...range.getClientRects()].every(
        (r) => r.right <= bounds.right + 0.5 && r.bottom <= bounds.bottom + 0.5,
      );
    }
    const inline = [...el.querySelectorAll(".cal-event__detail")].every((detail) => {
      const icon = detail.querySelector("svg")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(detail.querySelector("span")!);
      return [...range.getClientRects()].some(
        (r) => r.left >= icon.right && r.top < icon.bottom && r.bottom > icon.top,
      );
    });
    return {
      width: bounds.width,
      wrapped: title.clientHeight > parseFloat(getComputedStyle(title).lineHeight),
      fits,
      inline,
    };
  });
  expect(layout.width).toBeLessThan(80);
  expect(layout.wrapped).toBe(true);
  expect(layout.fits).toBe(true);
  expect(layout.inline).toBe(true);
});
