import { expect, test } from "@playwright/test";

test.use({ video: "on" });

test("typing keeps search results visible and mounted while the next query loads", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("doc");
  const match = page.getByRole("option").filter({ hasText: "Icon sketches for the dock" }).first();
  await expect(match).toBeVisible();
  await page.screenshot({ path: "test-results/search-before-edit.png" });

  // Hold the real cached-search IPC response so the pending render is observable.
  await page.evaluate(() => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    ipc.invoke = async (cmd, args) => {
      if (cmd === "search_messages") await new Promise((resolve) => setTimeout(resolve, 500));
      return invoke(cmd, args);
    };
  });
  const original = await match.elementHandle();
  await search.press("End");
  await search.press("k");
  // Query directly: a retrying assertion could miss a transient blank list.
  const visibleDuringLoad = await match.count();
  await page.screenshot({ path: "test-results/search-during-edit.png" });
  expect(visibleDuringLoad).toBe(1);
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Cached mail and Gmail");
  await expect(match).toBeVisible();
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: "test-results/search-after-edit.png" });

  await search.fill("no-mail-matches-this-query");
  await expect(page.getByText("No conversations match your search.")).toBeVisible();
  await expect(match).toHaveCount(0);
});
