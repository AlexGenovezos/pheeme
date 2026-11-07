import { expect, test } from "@playwright/test";
import type { SyncProgress } from "../src/lib/tauri";

test.use({ video: "on" });

test("Accounts shows each mailbox's progress and refreshes when sync finishes", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const settingsButton = page.getByRole("button", { name: /^Settings/ });
  await expect(settingsButton).toBeVisible();
  await page.evaluate(() => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    let reads = 0;
    ipc.invoke = async (cmd, args) => {
      if (cmd !== "get_sync_progress") return invoke(cmd, args);
      reads++;
      return [
        {
          accountId: "acc-personal",
          syncedMessages: reads === 1 ? 20400 : 30000,
          totalMessages: 30000,
          downloadedMessages: 6200,
          complete: reads > 1,
        },
        {
          accountId: "acc-work",
          syncedMessages: 8450,
          totalMessages: 8450,
          downloadedMessages: 3120,
          complete: true,
        },
      ] satisfies SyncProgress[];
    };
  });
  await settingsButton.click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Accounts", exact: true })
    .click();
  const personal = page.getByRole("progressbar", { name: "Mail sync for avery@example.com" });
  const work = page.getByRole("progressbar", { name: "Mail sync for avery@example.org" });
  await expect(personal).toHaveAttribute("value", "68");
  await expect(work).toHaveAttribute("value", "100");
  await expect(page.getByText("20,400 of 30,000 messages synced")).toBeVisible();
  await expect(page.getByText(/6,200 message bodies available offline/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sync-in-progress.png") });
  await expect(personal).toHaveAttribute("value", "100");
  await expect(page.getByText("30,000 of 30,000 messages synced")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sync-complete.png") });
});
