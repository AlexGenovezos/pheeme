import { expect, test } from "@playwright/test";
import type { ThreadDetail } from "../src/lib/tauri";

for (const fixed of [true, false]) {
  test(`a ${fixed ? "fixed-width" : "responsive"} promotional email fits while narrowing and widening the pane`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/");
    const rows = page.getByRole("listbox", { name: /conversations$/ }).getByRole("option");
    await expect(rows.first()).toBeVisible();
    // Exercise the real email renderer with a representative legacy promotional layout. The original
    // reported Steam HTML is unavailable; fixed table/min widths and inline image dimensions reproduce it.
    await page.evaluate((fixed) => {
      const ipc = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const invoke = ipc.invoke;
      ipc.invoke = async (cmd, args) => {
        const result = await invoke(cmd, args);
        if (cmd !== "get_thread") return result;
        const detail = result as ThreadDetail;
        return {
          ...detail,
          messages: [
            {
              ...detail.messages[detail.messages.length - 1],
              bodyHtml: `${fixed ? '<table id="promotion" width="700" style="width:700px;min-width:700px" cellpadding="0" cellspacing="0"><tr><td>' : '<div id="promotion">'}
              <h1>CONTROL Resonant is now on sale!</h1>
              <img id="logo" alt="Store logo" style="height:32px;width:auto"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'%3E%3Crect width='400' height='200' fill='teal'/%3E%3C/svg%3E">
              <img id="artwork" alt="Game artwork" width="700" height="350" style="width:700px;height:350px"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='700' height='350'%3E%3Crect width='700' height='350' fill='teal'/%3E%3C/svg%3E">
              <p>Promotional footer</p>${fixed ? "</td></tr></table>" : "</div>"}`,
              hasRemoteContent: false,
            },
          ],
        };
      };
    }, fixed);
    await rows.first().click();
    const iframe = page.locator('iframe[title="Message body"]');
    await expect(iframe).toBeVisible();
    const layout = () =>
      iframe.evaluate((el: HTMLIFrameElement) => {
        const doc = el.contentDocument!;
        const table = doc.querySelector("#promotion")!.getBoundingClientRect();
        const image = doc.querySelector("#artwork")!.getBoundingClientRect();
        const logo = doc.querySelector("#logo")!.getBoundingClientRect();
        const footer = doc.querySelector("p")!.getBoundingClientRect();
        return {
          width: el.clientWidth,
          height: el.clientHeight,
          right: table.right,
          left: table.left,
          imageRatio: image.width / image.height,
          logoWidth: logo.width,
          logoHeight: logo.height,
          footerBottom: footer.bottom,
          zoom: Number(doc.documentElement.style.getPropertyValue("zoom")),
        };
      });
    for (const width of [1600, 1000, 1200, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(async () => {
          const l = await layout();
          return (
            l.right <= l.width + 1 &&
            l.left >= -1 &&
            l.footerBottom <= l.height + 1 &&
            Math.abs(l.imageRatio - 2) < 0.05 &&
            Math.abs(l.zoom - (fixed ? Math.min(1, l.width / 700) : 1)) < 0.005 &&
            Math.abs(l.logoWidth - 64 * l.zoom) < 1 &&
            Math.abs(l.logoHeight - 32 * l.zoom) < 1
          );
        })
        .toBe(true);
      const l = await layout();
      expect(l.imageRatio).toBeCloseTo(2, 1);
      expect(l.zoom).toBeLessThanOrEqual(1);
    }
  });
}
