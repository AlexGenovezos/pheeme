import { expect, test } from "@playwright/test";
import type { CalendarEvent, EventDetail } from "../src/lib/tauri";
import type { PreviewInvoke } from "../src/preview/install";

test.use({ timezoneId: "America/New_York" });

test("overlapping events stay wider, readable and reachable as the week resizes", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-11T16:00:00Z"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    const win = window as unknown as { __PHEEME_PREVIEW_INVOKE__: PreviewInvoke };
    let events: CalendarEvent[] = [];
    let templateId = "";
    win.__PHEEME_PREVIEW_INVOKE__ = (cmd, args, next) => {
      if (cmd === "calendar_events") {
        const template = (next(cmd, args) as CalendarEvent[]).find((e) => !e.allDay)!;
        templateId = template.id;
        const at = (hour: number) => new Date(2026, 10, 11, 0, hour * 60).getTime();
        events = [
          ["Morning", 6, 11.5],
          ["Byzantine Chant Workshop", 10, 17],
          ["LEGOS of Learning", 13, 21],
          ["Wedding Tyler Bethke", 15, 16],
          ["Great Vespers", 17, 18],
        ].map(([summary, start, end], i) => ({
          ...template,
          id: `overlap-${i}`,
          summary: String(summary),
          start: { ms: at(Number(start)), date: null, timeZone: null },
          end: { ms: at(Number(end)), date: null, timeZone: null },
          selfResponse: null,
          canEdit: true,
        }));
        return events;
      }
      if (cmd === "calendar_event_detail") {
        const event = events.find((e) => e.id === args?.eventId);
        if (event)
          return {
            ...(next(cmd, { ...args, eventId: templateId }) as EventDetail),
            ...event,
          };
      }
      return next(cmd, args);
    };
  });
  await page.goto("/");
  await page.getByRole("radio", { name: "Calendar" }).click();
  const chant = page.getByRole("button", { name: /^Byzantine Chant Workshop,/ });
  const legos = page.getByRole("button", { name: /^LEGOS of Learning,/ });
  const wedding = page.getByRole("button", { name: /^Wedding Tyler Bethke,/ });
  const column = page.locator('.cal-grid__column[data-date="2026-11-11"]');
  await expect(chant).toBeVisible();
  await page.locator(".cal-grid__scroll").evaluate((el) => (el.scrollTop = 288));

  for (const width of [1600, 1040]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.mouse.move(0, 0);
    await legos.evaluate((el) => el.blur());
    const day = (await column.boundingBox())!;
    for (const card of [chant, legos, wedding]) {
      const bounds = (await card.boundingBox())!;
      expect(bounds.width).toBeGreaterThan(day.width / 3);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(day.x + day.width);
    }
    const title = chant.locator(".cal-event__title");
    await expect(title).toHaveCSS("white-space", "normal");
    expect((await title.boundingBox())!.height).toBeGreaterThan(
      await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight)),
    );
    const content = legos.locator(".cal-event__content");
    const chantLeft = (await chant.boundingBox())!.x;
    expect((await content.boundingBox())!.x + (await content.boundingBox())!.width).toBeLessThan(
      chantLeft,
    );
    await page.screenshot({ path: testInfo.outputPath(`overlap-${width}.png`) });

    // Hover raises the background event and exposes the rest of its title, without a reflow.
    const before = await legos.boundingBox();
    await legos.hover({ position: { x: 8, y: 8 } });
    expect(await legos.boundingBox()).toEqual(before);
    expect(await legos.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeGreaterThan(
      await chant.evaluate((el) => Number(getComputedStyle(el).zIndex)),
    );
    expect((await content.boundingBox())!.x + (await content.boundingBox())!.width).toBeGreaterThan(
      chantLeft,
    );
    await page.screenshot({ path: testInfo.outputPath(`overlap-hover-${width}.png`) });

    // Keyboard focus reveals the same area, and the event remains a normal accessible button.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await legos.focus();
    await expect(legos).toBeFocused();
    expect(await legos.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    expect((await content.boundingBox())!.x + (await content.boundingBox())!.width).toBeGreaterThan(
      chantLeft,
    );
  }

  await wedding.click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("dialog", { name: "Wedding Tyler Bethke" })).toBeVisible();
});

test("a later event cannot cover the bottom lines of a wrapped tall-card title", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-11T16:00:00Z"));
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("pheeme.calendar", JSON.stringify({ mode: "calendar", view: "week" }));
    const win = window as unknown as { __PHEEME_PREVIEW_INVOKE__: PreviewInvoke };
    win.__PHEEME_PREVIEW_INVOKE__ = (cmd, args, next) => {
      const result = next(cmd, args);
      if (cmd !== "calendar_events") return result;
      const template = (result as CalendarEvent[]).find((e) => !e.allDay)!;
      return ["Byzantine Chant Workshop", "Later event"].map((summary, i) => ({
        ...template,
        id: `staggered-${i}`,
        summary,
        start: { ms: new Date(2026, 10, 11, 9 + i).getTime(), date: null, timeZone: null },
        end: {
          ms: new Date(2026, 10, 11, i === 0 ? 16 : 11).getTime(),
          date: null,
          timeZone: null,
        },
        meeting: null,
        selfResponse: null,
      }));
    };
  });
  await page.goto("/");
  await page.addStyleTag({
    content:
      ".cal-grid__head, .cal-grid__band, .cal-grid__body { grid-template-columns: var(--calendar-gutter-width) repeat(7, 110px); }",
  });
  const event = page.getByRole("button", { name: /^Byzantine Chant Workshop,/ });
  await expect(event).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".cal-grid__scroll").evaluate((el) => (el.scrollTop = 384));
  await page.mouse.move(0, 0);
  const foreground = (await page.getByRole("button", { name: /^Later event,/ }).boundingBox())!;
  const titleClear = await event.locator(".cal-event__title").evaluate((el, front) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].every((r) => r.bottom <= front.y || r.right <= front.x);
  }, foreground);
  expect(titleClear).toBe(true);
});
