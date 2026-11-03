// JS heap leak check: drive the preview build through a long session, then compare the live
// heap, DOM nodes and event listeners with where they started. Chromium stands in for the
// real webviews, so this catches JS-level leaks (stores, listeners, detached DOM), not
// engine-specific ones. See docs/performance.md.
import { expect, test, type CDPSession, type Page } from "@playwright/test";

const THREADS = 10_000;
const ROUNDS = 4;
/** Threads opened per round (each replaces the last in the reading pane): 200 in all. */
const OPENED = 50;
const SYNC_EVENTS = 10;
/**
 * Growth allowed after GC, end vs. start, about twice the worst healthy run (+0.5 MiB: V8's
 * optimized code and Chrome's performance timeline, not app state). Keeping one 10k-thread
 * list per load would add megabytes.
 */
const MAX_HEAP_GROWTH = 1024 * 1024;
const MAX_NODE_GROWTH = 100;
const MAX_LISTENER_GROWTH = 20;

interface Snapshot {
  heap: number;
  nodes: number;
  listeners: number;
}

async function snapshot(cdp: CDPSession): Promise<Snapshot> {
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? NaN;
  return {
    heap: get("JSHeapUsedSize"),
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
  };
}

const list = (page: Page) => page.getByRole("listbox", { name: /conversations$/ });

async function emitSync(page: Page, event: string, payload: object) {
  await page.evaluate(
    ([event, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload }),
    [event, payload] as const,
  );
}

async function goTo(page: Page, mailbox: string) {
  await page
    .getByRole("navigation", { name: "Mailboxes" })
    .getByRole("link", { name: mailbox, exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: mailbox })).toBeVisible();
}

/** One round of a heavy session: scroll, read, switch mailboxes, themes and screens, sync. */
async function round(page: Page) {
  const rows = list(page);
  for (const at of [0.25, 0.5, 0.75, 1, 0]) {
    await rows.evaluate((el, at) => (el.scrollTop = el.scrollHeight * at), at);
    await page.waitForTimeout(50);
  }

  await rows.getByRole("option").first().click();
  for (let i = 0; i < OPENED; i++) await page.keyboard.press("j");
  // Past the fixture conversations, into the generated ones.
  await expect(
    page.getByRole("heading", { level: 2, name: /^Generated conversation \d+$/ }),
  ).toBeVisible();

  for (const mailbox of ["Primary", "Starred", "Sent", "All Mail", "All Inboxes"]) {
    await goTo(page, mailbox);
  }

  for (const mode of ["Dark", "Light", "Match system"]) {
    await page.getByRole("button", { name: /^Appearance:/ }).click();
    await page.getByRole("menuitemcheckbox", { name: mode }).click();
  }

  await page.getByRole("button", { name: "Manage accounts" }).click();
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(rows).toBeVisible();

  for (let i = 0; i < SYNC_EVENTS; i++) {
    const accountId = "acc-personal";
    await emitSync(page, "sync:started", { accountId });
    await emitSync(page, "sync:messages_updated", {
      accountId,
      added: [],
      removed: [],
      modified: [`gen-${i}`],
    });
    await emitSync(page, "sync:completed", { accountId });
  }
  await expect(rows).toBeVisible();
}

test("a long session doesn't grow the JS heap, DOM or listeners", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(`/?threads=${THREADS}`);
  await expect(list(page).getByRole("option").first()).toBeVisible();

  await round(page); // warm up: lazy modules, caches, first-render work
  const start = await snapshot(cdp);
  for (let i = 0; i < ROUNDS; i++) await round(page);
  const end = await snapshot(cdp);

  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
  console.log(
    `memory: heap ${mib(start.heap)} -> ${mib(end.heap)}, nodes ${start.nodes} -> ${end.nodes}, ` +
      `listeners ${start.listeners} -> ${end.listeners} over ${ROUNDS} rounds`,
  );
  expect(end.heap - start.heap, "JS heap growth (bytes)").toBeLessThan(MAX_HEAP_GROWTH);
  expect(end.nodes - start.nodes, "DOM node growth").toBeLessThan(MAX_NODE_GROWTH);
  expect(end.listeners - start.listeners, "event listener growth").toBeLessThan(
    MAX_LISTENER_GROWTH,
  );
});
