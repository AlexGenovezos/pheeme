import { expect, test } from "@playwright/test";
import type { PreviewInvoke } from "../src/preview/install";
import type { ThreadDetail } from "../src/lib/tauri";

test("mod+f finds text in an HTML email, steps to a match far down and closes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const rows = page.getByRole("listbox", { name: /conversations$/ }).getByRole("option");
  // A fixed-width layout wider than the pane (so the frame is zoomed to fit), with a match split by
  // markup near the top, one hidden preheader that mustn't count, and one far below the fold.
  await page.addInitScript(() => {
    const filler = Array.from({ length: 120 }, (_, i) => `<p>Filler paragraph ${i}</p>`).join("");
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
            bodyHtml: `<div style="display:none">zebrafish preheader</div>
              <table width="1400" style="width:1400px"><tr><td>
              <p id="first">The <b>zebra</b>fish arrives Monday.</p>
              ${filler}
              <p id="last">Last zebrafish here.</p>
              </td></tr></table>`,
            hasRemoteContent: false,
          },
        ],
      };
    };
  });
  await page.goto("/");
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  const iframe = page.locator('iframe[title="Message body"]:visible');
  await expect(iframe).toBeVisible();

  await page.keyboard.press("ControlOrMeta+f");
  const field = page.getByRole("textbox", { name: "Find in conversation" });
  await expect(field).toBeFocused();
  await field.fill("zebrafish");
  const bar = page.getByRole("search", { name: "Find in conversation" });
  await expect(bar).toContainText("1 of 2");

  const highlights = () =>
    iframe.evaluate((el: HTMLIFrameElement) => {
      const reg = (el.contentWindow as Window & typeof globalThis).CSS.highlights;
      const text = (name: string) =>
        [...((reg.get(name) as Highlight | undefined) ?? [])].map((r) => r.toString());
      return { all: text("pheeme-find"), current: text("pheeme-find-current") };
    });
  expect(await highlights()).toEqual({ all: ["zebrafish"], current: ["zebrafish"] });

  // The last match, on screen in the pane once Enter moves to it.
  const lastOnScreen = () =>
    page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe")].find(
        (f) => f.offsetParent,
      )!;
      const pane = frame.closest(".view-pane__scroll")!.getBoundingClientRect();
      const r = frame.contentDocument!.getElementById("last")!.getBoundingClientRect();
      const top = frame.getBoundingClientRect().top + r.top;
      return top >= pane.top && top + r.height <= pane.bottom;
    });
  expect(await lastOnScreen()).toBe(false);
  await field.press("Enter");
  await expect(bar).toContainText("2 of 2");
  await expect.poll(lastOnScreen).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("find-last-match.png") });

  await field.press("Shift+Enter");
  await expect(bar).toContainText("1 of 2");
  await field.fill("no such words");
  await expect(bar).toContainText("No matches");

  await field.press("Escape");
  await expect(bar).toBeHidden();
  expect(await highlights()).toEqual({ all: [], current: [] });
});
