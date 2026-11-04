import { expect, test } from "@playwright/test";
import { buildSrcdoc } from "../src/mail/srcdoc";

// GitHub Actions uses a 24px status column next to a job column requesting 100%.
// Preserve that sizing pressure without copying a private notification or its links.
const notification = `
  <table style="width:100%;max-width:544px;border-collapse:collapse">
    <thead><tr>
      <th scope="col" style="width:24px;box-sizing:border-box;padding:16px 0 16px 16px">Status</th>
      <th scope="col" style="width:100%;padding:16px">Job</th>
      <th scope="col" style="white-space:nowrap;padding:16px 16px 16px 0">Annotations</th>
    </tr></thead>
    <tbody><tr>
      <td style="padding:16px 0 16px 16px"><img alt="Succeeded" width="24" height="24"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='10' fill='green'/%3E%3C/svg%3E"></td>
      <td style="width:100%;padding:16px">Performance / Rust heap soak<br>Succeeded in 3 minutes</td>
      <td style="white-space:nowrap;padding:16px 16px 16px 0">1</td>
    </tr></tbody>
  </table>
  <p id="long-url">https://example.com/${"a".repeat(200)}</p>`;

for (const dark of [false, true]) {
  test(`GitHub job columns stay readable in ${dark ? "dark" : "light"} mode`, async ({ page }) => {
    await page.setContent(
      '<iframe title="Message body" sandbox="allow-same-origin" style="width:100%;height:600px;border:0"></iframe>',
    );
    const iframe = page.locator("iframe");
    await iframe.evaluate(
      (el, srcdoc) => {
        (el as HTMLIFrameElement).srcdoc = srcdoc;
      },
      buildSrcdoc(notification, {
        allowRemote: false,
        dark,
        declaresDark: false,
        textColor: dark ? "#e4e9e9" : "#1a1f1f",
        linkColor: "#0b7a70",
      }),
    );
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("columnheader", { name: "Status" })).toBeVisible();

    for (const width of [600, 320, 800]) {
      await page.setViewportSize({ width, height: 800 });
      const status = frame.getByRole("columnheader", { name: "Status" });
      // Check the text's lines, rather than the cell height shared with the other headings.
      expect(
        await status.evaluate((el) => {
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        }),
      ).toBe(1);
      const icon = await frame.getByRole("img", { name: "Succeeded" }).boundingBox();
      expect(icon?.width).toBe(24);
      expect(icon?.height).toBe(24);
      expect(
        await iframe.evaluate((el: HTMLIFrameElement) => {
          const doc = el.contentDocument!;
          const range = doc.createRange();
          range.selectNodeContents(doc.querySelector("#long-url")!);
          return (
            doc.documentElement.scrollWidth <= el.clientWidth && range.getClientRects().length > 1
          );
        }),
      ).toBe(true);
    }
  });
}
