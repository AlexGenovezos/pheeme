import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ThreadDetail, ThreadPage } from "../src/lib/tauri";
import type { PreviewInvoke } from "../src/preview/install";

const image = readFileSync("public/pheeme-icon.png"); // Real 512 × 512 PNG, decoded by the browser.
const IMAGE_DELAY = 90;
const BODY_DELAY = 80;
const STEP_MS = 200; // Five arrows/second, including browser event dispatch and observation.

interface Probe {
  bodies: string[];
  maxRetained: number;
  requests: Array<{ id: string; opened: boolean; preload: boolean }>;
  mutations: string[];
  persistedRead: string[];
  readRefreshes: number;
  samples: Array<{ expected: string; subject: string; body: string; problem: string }>;
  expected: string;
  observing: boolean;
}

type PreviewWindow = Window & {
  __PHEEME_PREVIEW_INVOKE__: PreviewInvoke;
  preloadProbe: Probe;
  __TAURI_INTERNALS__: { invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> };
};

async function fixture(page: Page) {
  const requests = new Map<string, number>();
  await page.addInitScript(
    ({ bodyDelay, imageOrigin }) => {
      const win = window as unknown as PreviewWindow;
      const probe: Probe = {
        maxRetained: 0,
        bodies: [],
        requests: [],
        mutations: [],
        persistedRead: [],
        readRefreshes: 0,
        samples: [],
        expected: "",
        observing: false,
      };
      win.preloadProbe = probe;
      const read = new Set(["preload-0"]);
      win.__PHEEME_PREVIEW_INVOKE__ = async (cmd, args, next) => {
        if (cmd === "list_threads") {
          if (args?.alsoLabelId && args.alsoLabelId !== "CATEGORY_UPDATES")
            return { threads: [], next: null };
          const base = next("get_thread", {
            accountId: "acc-personal",
            threadId: "p-01",
          }) as ThreadDetail;
          const count = 32;
          const threads = Array.from({ length: count }, (_, i) => ({
            ...base.thread,
            id: `preload-${i}`,
            subject: `Preload receipt ${i}`,
            unread: !read.has(`preload-${i}`),
            messageCount: 1,
            date: Date.now() - i * 60_000,
          })).filter(
            (row) =>
              !args?.unreadOnly ||
              row.unread ||
              (Array.isArray(args.keepRead) &&
                args.keepRead.some(
                  (pair) => Array.isArray(pair) && pair[0] === row.accountId && pair[1] === row.id,
                )),
          );
          if (args?.unreadOnly && threads.some((row) => !row.unread)) probe.readRefreshes++;
          return {
            threads: threads.slice(0, Number(args?.limit) || threads.length),
            next: null,
          } satisfies ThreadPage;
        }
        if (cmd === "get_thread" && String(args?.threadId).startsWith("preload-")) {
          const id = String(args?.threadId);
          probe.requests.push({
            id,
            opened: args?.opened === true,
            preload: args?.preload === true,
          });
          await new Promise((done) => setTimeout(done, bodyDelay));
          const base = next("get_thread", {
            accountId: "acc-personal",
            threadId: "p-01",
          }) as ThreadDetail;
          const n = Number(id.slice("preload-".length));
          const subject = `Preload receipt ${n}`;
          const bodyHtml = `<div style="max-width:520px;font-family:Arial,sans-serif;padding:16px">
                <h1>${subject}</h1><p>Your order has shipped. Delivery details and receipt below.</p>
                <img alt="Receipt artwork" width="512" height="256" style="width:100%;height:auto"
                  src="${imageOrigin}/artwork-${n}.png">
                <img alt="Shipment status" width="64" height="64" src="${imageOrigin}/no-store-${n}.png">
                <p>Order ${n}: one item, total $42.00. Thank you for your purchase.</p>
              </div>`;
          probe.bodies.push(id);
          return {
            ...base,
            thread: { ...base.thread, id, subject, unread: !read.has(id), messageCount: 1 },
            messages: [
              {
                ...base.messages[base.messages.length - 1],
                id: `${id}-message`,
                threadId: id,
                subject,
                unread: !read.has(id),
                bodyHtml,
                bodyText: subject,
                hasRemoteContent: true,
                labelIds: ["INBOX", "CATEGORY_UPDATES", ...(!read.has(id) ? ["UNREAD"] : [])],
              },
            ],
          } satisfies ThreadDetail;
        }
        if (cmd === "modify_threads") {
          probe.mutations.push(cmd);
          const ids = (Array.isArray(args?.threadIds) ? args.threadIds : []).map(String);
          if (ids.every((id) => id.startsWith("preload-"))) {
            for (const id of ids) {
              if (Array.isArray(args?.remove) && args.remove.includes("UNREAD")) read.add(id);
              if (Array.isArray(args?.add) && args.add.includes("UNREAD")) read.delete(id);
            }
            probe.persistedRead = [...read];
            await win.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
              event: "sync:messages_updated",
              payload: { accountId: args?.accountId, added: [], removed: [], modified: ids },
            });
            return;
          }
        }
        return next(cmd, args);
      };
    },
    { bodyDelay: BODY_DELAY, imageOrigin: imageServerOrigin },
  );
  page.on("request", (request) => {
    if (request.url().startsWith(imageServerOrigin)) {
      const path = new URL(request.url()).pathname;
      requests.set(path, (requests.get(path) ?? 0) + 1);
    }
  });
  return requests;
}

// Real HTTP cache behavior matters: Playwright routing disables the browser cache. This tiny
// server provides delayed cacheable and no-store PNGs without changing production fixtures.
import { createServer, type Server } from "node:http";
let imageServer: Server;
let imageServerOrigin: string;
test.beforeAll(async () => {
  imageServer = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": req.url?.includes("no-store") ? "no-store" : "public, max-age=3600",
      });
      res.end(image);
    }, IMAGE_DELAY);
  });
  await new Promise<void>((done) => imageServer.listen(0, "127.0.0.1", done));
  const address = imageServer.address();
  if (!address || typeof address === "string") throw new Error("No image server address");
  imageServerOrigin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((done) => imageServer.close(() => done()));
});

const list = (page: Page) => page.getByRole("listbox", { name: /conversations$/ });
const visible = (page: Page) => page.locator('.thread-view__retained[data-visible="true"]');

async function warm(
  page: Page,
  requests: Map<string, number>,
  name: string,
  first: number,
  timings: Record<string, number>,
) {
  const start = Date.now();
  await expect
    .poll(async () => {
      const bodies = await page.evaluate(
        () => (window as unknown as PreviewWindow).preloadProbe.bodies,
      );
      return Array.from({ length: 20 }, (_, i) => first + i).every(
        (n) => bodies.includes(`preload-${n}`) && (requests.get(`/artwork-${n}.png`) ?? 0) > 0,
      );
    })
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLIFrameElement>("iframe")].every(
          (frame) =>
            frame.contentDocument?.images.length &&
            [...frame.contentDocument.images].every(
              (img) => img.complete && img.naturalWidth === 512,
            ),
        ),
      ),
    )
    .toBe(true);
  timings[name] = Date.now() - start;
}

test("warm unread Updates paint complete bodies and images through 23 rows at five arrows/second", async ({
  page,
}) => {
  const requests = await fixture(page);
  const timings: Record<string, number> = {};
  await page.goto("/");
  await expect(list(page).getByRole("option").first()).toBeVisible();
  await warm(page, requests, "arrival", 0, timings);
  await page
    .getByRole("navigation", { name: "Mailboxes" })
    .getByRole("link", { name: "Updates", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await warm(page, requests, "Updates", 0, timings);
  await page.getByRole("button", { name: "Unread only", exact: true }).click();
  await expect(list(page).getByRole("option").first()).toContainText("Preload receipt 1");
  await warm(page, requests, "Updates unread", 1, timings);
  expect(
    await page.evaluate(() => (window as unknown as PreviewWindow).preloadProbe.mutations),
  ).toEqual([]);
  await list(page).getByRole("option").first().click();
  await expect(visible(page).getByRole("heading", { level: 2 })).toHaveText("Preload receipt 1");
  // Let the two nearby retained frames finish before starting the warm-list guarantee.
  await warm(page, requests, "selected nearby", 1, timings);
  const noStoreBefore = requests.get("/no-store-2.png");
  await page.evaluate(() => {
    const probe = (window as unknown as PreviewWindow).preloadProbe;
    probe.expected = "Preload receipt 1";
    probe.observing = true;
    const documents = new Map<string, { frame: HTMLIFrameElement; root: HTMLElement }>();
    const observe = () => {
      if (!probe.observing) return;
      const pane = document.querySelector(".view-pane__scroll")!;
      probe.maxRetained = Math.max(
        probe.maxRetained,
        pane.querySelectorAll(".thread-view__retained").length,
      );
      const current = pane.querySelector('.thread-view__retained[data-visible="true"]');
      const subject = current?.querySelector("h2")?.textContent ?? "";
      const frame = current?.querySelector<HTMLIFrameElement>("iframe");
      const doc = frame?.contentDocument;
      const body = doc?.querySelector("h1")?.textContent ?? "";
      let problem = "";
      if (!current || !frame || !doc?.body.textContent?.trim() || !frame.clientHeight)
        problem = "blank";
      else if (
        pane.querySelector(".thread-loading") ||
        current.querySelector(".message-card__unavailable")
      )
        problem = "loading";
      else if (subject !== probe.expected || body !== probe.expected) problem = "stale";
      else if (
        doc.images.length !== 2 ||
        [...doc.images].some((img) => !img.complete || img.naturalWidth !== 512)
      )
        problem = "incomplete images";
      for (const wrapper of pane.querySelectorAll(".thread-view__retained")) {
        const key = wrapper.querySelector("h2")?.textContent ?? "";
        const neighbor = wrapper.querySelector<HTMLIFrameElement>("iframe");
        const root = neighbor?.contentDocument?.documentElement;
        if (!neighbor || !root) continue;
        const previous = documents.get(key);
        if (previous && (previous.frame !== neighbor || previous.root !== root))
          problem ||= `replaced nearby document: ${key}`;
        documents.set(key, { frame: neighbor, root });
      }
      probe.samples.push({ expected: probe.expected, subject, body, problem });
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });
  let noStoreAfter: number | undefined;
  const start = Date.now();
  for (let n = 2; n <= 23; n++) {
    // Expectation changes in the same task as the real DOM key event, before the next paint.
    await page.evaluate((n) => {
      (window as unknown as PreviewWindow).preloadProbe.expected = `Preload receipt ${n}`;
      const box = document.querySelector('[role="listbox"]')!;
      box.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    }, n);
    await page.waitForTimeout(Math.max(0, start + (n - 1) * STEP_MS - Date.now()));
    if (n === 2) noStoreAfter = requests.get("/no-store-2.png");
  }
  const elapsed = Date.now() - start;
  const probe = await page.evaluate(() => {
    const probe = (window as unknown as PreviewWindow).preloadProbe;
    probe.observing = false;
    return probe;
  });
  expect(probe.persistedRead).toEqual(
    expect.arrayContaining(Array.from({ length: 23 }, (_, n) => `preload-${n + 1}`)),
  );
  expect(
    probe.readRefreshes,
    "persisted read rows survive real same-query refreshes through keepRead",
  ).toBeGreaterThan(0);
  expect(probe.samples.length).toBeGreaterThan(100);
  expect(probe.maxRetained).toBeLessThanOrEqual(5);
  expect(
    probe.mutations.length,
    "the observer sees actual open mark-read operations",
  ).toBeGreaterThan(0);
  expect(
    probe.samples.filter((sample) => sample.problem),
    "every painted frame after arrows",
  ).toEqual([]);
  for (let n = 2; n <= 23; n++)
    expect(probe.samples.some((sample) => sample.expected === `Preload receipt ${n}`)).toBe(true);
  expect(noStoreAfter, "revealing same nearby iframe reuses no-store image").toBe(noStoreBefore);
  expect(22 / (elapsed / 1000)).toBeGreaterThanOrEqual(4);
  expect(probe.requests.filter((r) => r.preload).every((r) => !r.opened)).toBe(true);
  await expect(visible(page).getByRole("heading", { level: 2 })).toHaveText("Preload receipt 23");
  console.log(
    `preload: warmup ${JSON.stringify(timings)} ms; 22 arrows/${elapsed} ms; ${probe.samples.length} rAF samples; max ${probe.maxRetained} retained; no-store-2 reveal requests ${noStoreBefore} -> ${noStoreAfter} (end ${requests.get("/no-store-2.png")})`,
  );
});
