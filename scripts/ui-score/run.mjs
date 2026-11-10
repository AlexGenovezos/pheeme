// UI scorecard runner: drives the browser preview (`npm run dev`) through each part of the UI at a
// 1280x800 window, at the default and the narrowest sidebar, light and dark, and scores each with
// score.js. A part's score is its worst variant. See scripts/ui-score/README.md.
// Usage: npm run ui:score -- [--url http://localhost:1420] [--out dir] [--shots] [--only id,id]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:1420");
const OUT = arg("--out", path.join(here, "out"));
const SHOTS = process.argv.includes("--shots");
const ONLY = arg("--only", "");
const scorer = fs.readFileSync(path.join(here, "score.js"), "utf8");
fs.mkdirSync(OUT, { recursive: true });

// macOS 26+ traffic lights, measured from a Retina screenshot of the app: three 14 px lights
// from x 16 to 76, centred on the 44 px title bar. The app is told it has an overlay title bar.
const MAC = `(() => {
  const apply = () => {
    // Toasts (the first-run notifications offer) float over whatever is scored; keep them out.
    if (document.head && !document.getElementById('__no-toasts')) {
      const st = document.createElement('style'); st.id = '__no-toasts'; st.textContent = '.ui-toast-viewport{display:none!important}'; document.head.appendChild(st);
    }
    for (const s of document.querySelectorAll('.shell')) if (!s.hasAttribute('data-overlay-titlebar')) s.setAttribute('data-overlay-titlebar', '');
    if (document.body && !document.getElementById('__mac-traffic-lights')) {
      const d = document.createElement('div'); d.id = '__mac-traffic-lights';
      d.style.cssText = 'position:fixed;left:16px;top:15px;width:60px;height:14px;z-index:2147483647;pointer-events:none;display:flex;justify-content:space-between';
      for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const b = document.createElement('span'); b.style.cssText = 'width:14px;height:14px;border-radius:50%;background:' + c + ';box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.2)'; d.appendChild(b); }
      document.body.appendChild(d);
    }
  };
  new MutationObserver(apply).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', apply);
})()`;

const wait = (page, ms = 250) => page.waitForTimeout(ms);
async function key(page, k) {
  await page.keyboard.press(k);
  await wait(page);
}
async function clickCenter(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.mouse.click(b.x + Math.min(12, b.width / 2), b.y + b.height / 2);
  await wait(page, 350);
}
const calendar = (page) => key(page, "Control+2");
const mail = (page) => key(page, "Control+1");
async function tasksPanel(page, open) {
  const is = (await page.locator(".tasks-panel").count()) > 0;
  if (is !== open) await key(page, "Control+Shift+T");
}
async function view(page, v) {
  await calendar(page);
  await tasksPanel(page, false);
  await key(page, v);
}
async function openInvite(page) {
  await mail(page);
  const row = page.locator(".thread-row", { hasText: "Invitation: Design review" }).first();
  await clickCenter(page, row);
  await page.locator(".invite-card").waitFor();
  await wait(page, 600);
}
const event = (page, name) => page.locator(".cal-main .cal-event", { hasText: name }).first();

/** Each part: how to reach it, and the element(s) scored. `hide` is removed from the score. */
const PARTS = [
  {
    id: "mail-sidebar",
    name: "Mail sidebar",
    base: true,
    go: (p) => mail(p),
    root: "aside.shell__sidebar",
  },
  { id: "mail-list", name: "Mail list", base: true, go: (p) => mail(p), root: ".thread-list" },
  {
    id: "mail-conversation",
    name: "Mail conversation",
    base: true,
    go: openInvite,
    root: ".shell__view",
    hide: ".invite-card",
  },
  { id: "invite-card", name: "Invite card (Mail)", go: openInvite, root: ".invite-card" },
  {
    id: "cal-sidebar",
    name: "Calendar sidebar",
    go: (p) => view(p, "w"),
    root: "aside.shell__sidebar",
  },
  { id: "week", name: "Week", go: (p) => view(p, "w"), root: ".cal-main" },
  {
    id: "week-tasks",
    name: "Week + Tasks panel",
    go: async (p) => {
      await view(p, "w");
      await tasksPanel(p, true);
    },
    root: ".cal-main",
  },
  {
    id: "tasks-panel",
    name: "Tasks panel",
    go: async (p) => {
      await view(p, "w");
      await tasksPanel(p, true);
    },
    root: ".tasks-panel",
  },
  { id: "day", name: "Day", go: (p) => view(p, "d"), root: ".cal-main" },
  { id: "month", name: "Month", go: (p) => view(p, "m"), root: ".cal-main" },
  {
    id: "event-popover",
    name: "Event popover",
    go: async (p) => {
      await view(p, "w");
      await clickCenter(p, event(p, "Team planning"));
    },
    root: ".cal-pop",
  },
  {
    id: "quick-create",
    name: "Quick create",
    go: async (p) => {
      await view(p, "w");
      await key(p, "c");
    },
    root: ".cal-quick",
  },
  {
    id: "event-editor",
    name: "Event editor",
    go: async (p) => {
      await view(p, "w");
      await key(p, "c");
      await p.locator(".cal-quick button", { hasText: "More options" }).click();
      await wait(p, 500);
    },
    root: ".cal-editor",
  },
  {
    id: "repeating-prompt",
    name: "Repeating-event prompt",
    go: async (p) => {
      await view(p, "w");
      await clickCenter(p, event(p, "Standup"));
      await key(p, "Delete");
    },
    root: ".cal-prompt",
  },
  {
    id: "search",
    name: "Calendar search",
    go: async (p) => {
      await view(p, "w");
      await key(p, "/");
      await p.keyboard.type("review");
      await wait(p, 800);
    },
    root: ".cal-search",
  },
  {
    id: "pinned-email",
    name: "Pinned email",
    go: async (p) => {
      await openInvite(p);
      await p.locator(".invite-card button", { hasText: "in Calendar" }).click();
      await wait(p, 800);
    },
    root: ".pinned-email",
  },
  {
    id: "week-pinned",
    name: "Week + pinned email",
    go: async (p) => {
      await openInvite(p);
      await p.locator(".invite-card button", { hasText: "in Calendar" }).click();
      await wait(p, 800);
    },
    root: ".cal-main",
  },
];

// The default sidebar width, and the narrowest the app allows (a stored 1 px is clamped up to it).
const VARIANTS = [
  { id: "light-default", scheme: "light", sidebar: 220 },
  { id: "light-narrowest", scheme: "light", sidebar: 1 },
  { id: "dark-default", scheme: "dark", sidebar: 220 },
  { id: "dark-narrowest", scheme: "dark", sidebar: 1 },
];

const browser = await chromium.launch();
const results = {};
for (const part of PARTS.filter((p) => !ONLY || ONLY.split(",").includes(p.id))) {
  results[part.id] = { name: part.name, base: !!part.base, variants: {} };
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: v.scheme,
    });
    await ctx.addInitScript(
      ([w]) => {
        if (!localStorage.getItem("__seeded")) {
          localStorage.setItem(
            "pheeme.layout",
            JSON.stringify({
              sidebarWidth: w,
              listWidth: 380,
              sidebarCollapsed: false,
              listDensity: "comfortable",
              readingPane: true,
            }),
          );
          localStorage.setItem("__seeded", "1");
        }
      },
      [v.sidebar],
    );
    await ctx.addInitScript(MAC);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    let r;
    try {
      await page.goto(URL);
      await page.locator(".shell").first().waitFor();
      await wait(page, 800);
      await part.go(page);
      await page.locator(part.root).first().waitFor();
      await wait(page, 300);
      await page.evaluate(scorer);
      r = await page.evaluate(
        ([root, hide]) => {
          const h = hide ? [...globalThis.document.querySelectorAll(hide)] : [];
          h.forEach((e) => (e.style.display = "none"));
          const out = globalThis.__score(root);
          h.forEach((e) => (e.style.display = ""));
          return out;
        },
        [part.root, part.hide],
      );
      if (SHOTS && v.scheme === "light") {
        const el = page.locator(part.root).first();
        const box = await el.boundingBox();
        const pad = 8;
        const clip = {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(1280 - Math.max(0, box.x - pad), box.width + 2 * pad),
          height: Math.min(800 - Math.max(0, box.y - pad), box.height + 2 * pad),
        };
        await page.screenshot({ path: path.join(OUT, `${part.id}-${v.id}.png`), clip });
        await page.screenshot({ path: path.join(OUT, `${part.id}-${v.id}-full.png`) });
      }
    } catch (e) {
      r = { error: String(e).slice(0, 300) };
    }
    results[part.id].variants[v.id] = r;
    await ctx.close();
  }
  const vs = Object.entries(results[part.id].variants);
  const worst = vs.reduce((a, b) => ((b[1].total ?? -1) < (a[1].total ?? -1) ? b : a));
  results[part.id].score = worst[1].total ?? null;
  results[part.id].worst = worst[0];
  const d = worst[1].defects || [];
  console.log(
    `${String(results[part.id].score).padStart(4)}  ${part.name.padEnd(26)} worst=${worst[0]}  base=${worst[1].base}` +
      (worst[1].error ? `  ERROR ${worst[1].error}` : "") +
      (d.length ? `\n        defects: ${d.join(" | ")}` : ""),
  );
}
await browser.close();
fs.writeFileSync(path.join(OUT, "scores.json"), JSON.stringify(results, null, 2));
