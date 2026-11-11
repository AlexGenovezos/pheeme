// UI scorecard runner: drives the browser preview (`npm run dev`) through each part of the UI in a
// 1280x800 and the smallest (900x600) window, at the default and the narrowest sidebar, light and
// dark, and scores each with score.js. A part's score is its worst variant. See scripts/ui-score/README.md.
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
/** With no room for it beside the content the sidebar hides; open it (over the content) to score it. */
async function sidebarShown(page) {
  if (await page.locator("aside.shell__sidebar").first().isVisible()) return;
  await page.getByRole("button", { name: "Show sidebar" }).first().click();
  await wait(page, 400);
}
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
/** Quick create: click an empty hour (Saturday, 3 PM) in the week. */
async function quickCreate(p) {
  const col = p.locator(".cal-grid__column").last();
  await col.evaluate((el) => {
    const scroll = el.closest(".cal-grid__scroll");
    scroll.scrollTop = 14 * 48;
  });
  await wait(p, 200);
  const box = await col.boundingBox();
  const top = await col.evaluate((el) => el.getBoundingClientRect().top);
  await p.mouse.click(box.x + box.width / 2, top + 15 * 48 + 12);
  await p.locator(".cal-quick").waitFor();
  await wait(p, 300);
}
async function openThread(p, subject) {
  await mail(p);
  await clickCenter(p, p.locator(".thread-row", { hasText: subject }).first());
  await wait(p, 1200);
}
async function openSettings(p, page) {
  await mail(p);
  await key(p, "Control+,");
  await p.locator(".settings").waitFor();
  await p.locator(".settings__page", { hasText: page }).first().click();
  await wait(p, 500);
}
async function openEditor(p) {
  await view(p, "w");
  await quickCreate(p);
  await p.locator(".cal-quick button", { hasText: "More options" }).click();
  await p.locator(".cal-editor").waitFor();
  await wait(p, 400);
}
const event = (page, name) => page.locator(".cal-main .cal-event", { hasText: name }).first();

/** Each part: how to reach it, and the element(s) scored. `hide` is removed from the score. */
const PARTS = [
  {
    id: "mail-sidebar",
    name: "Mail sidebar",
    base: true,
    go: async (p) => {
      await mail(p);
      await sidebarShown(p);
    },
    root: "aside.shell__sidebar",
  },
  { id: "mail-list", name: "Mail list", base: true, go: (p) => mail(p), root: ".thread-list" },
  {
    id: "mail-conversation",
    name: "Mail conversation",
    base: true,
    go: openInvite,
    root: ".shell__view",
  },
  { id: "invite-card", name: "Invite card (Mail)", go: openInvite, root: ".invite-card" },
  {
    id: "cal-sidebar",
    name: "Calendar sidebar",
    go: async (p) => {
      await view(p, "w");
      await sidebarShown(p);
    },
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
      await quickCreate(p);
    },
    root: ".cal-quick",
  },
  {
    id: "quick-add",
    name: "Quick add (type a sentence)",
    go: async (p) => {
      await view(p, "w");
      await key(p, "c");
      await p.keyboard.type("Coffee with Sam tomorrow at 3pm at Tartine");
      await wait(p, 500);
    },
    root: ".cal-qa",
  },
  {
    id: "event-editor",
    name: "Event editor",
    go: async (p) => {
      await view(p, "w");
      await quickCreate(p);
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
  {
    id: "editor-custom-repeat",
    name: "Event editor: custom repeat",
    go: async (p) => {
      await openEditor(p);
      await p.getByRole("combobox", { name: "Repeat" }).click();
      await p.getByRole("option", { name: /Custom/ }).click();
      await wait(p, 300);
    },
    root: ".cal-editor",
  },
  {
    id: "week-pinned-tasks",
    name: "Week + pinned email + Tasks",
    go: async (p) => {
      await openInvite(p);
      await p.locator(".invite-card button", { hasText: "in Calendar" }).click();
      await wait(p, 800);
      await tasksPanel(p, true);
      await wait(p, 300);
    },
    root: ".cal-main",
  },
  {
    id: "editor-reminders",
    name: "Event editor: notifications",
    go: async (p) => {
      await openEditor(p);
      await p.locator(".cal-editor button", { hasText: /^Change$/ }).click();
      await wait(p, 300);
    },
    root: ".cal-editor",
  },
  {
    id: "picker-date",
    name: "Date picker",
    go: async (p) => {
      await openEditor(p);
      await p.locator(".cal-editor").getByRole("combobox", { name: "Date" }).first().click();
      await wait(p, 300);
    },
    root: ".ui-picker",
  },
  {
    id: "picker-time",
    name: "Time list",
    go: async (p) => {
      await view(p, "w");
      await quickCreate(p);
      await p.getByRole("combobox", { name: "End time" }).click();
      await wait(p, 300);
    },
    root: ".ui-picker",
  },
  {
    id: "picker-select",
    name: "Dropdown list (time zone)",
    go: async (p) => {
      await openEditor(p);
      await p.locator(".cal-editor [role=combobox]", { hasText: "America/" }).first().click();
      await wait(p, 300);
    },
    root: ".ui-picker",
  },
  {
    id: "task-editor",
    name: "Task editor",
    go: async (p) => {
      await view(p, "w");
      await tasksPanel(p, true);
      await p.locator(".task-row__main").first().click();
      await wait(p, 300);
    },
    root: ".task-editor",
  },
  {
    id: "go-to-date",
    name: "Go to date",
    go: async (p) => {
      await view(p, "w");
      await key(p, "g");
      await wait(p, 300);
    },
    root: ".cal-goto",
  },
  {
    id: "mail-tasks",
    name: "Mail + Tasks panel (conversation open)",
    base: true,
    go: async (p) => {
      await openInvite(p);
      await tasksPanel(p, true);
      await wait(p, 300);
    },
    root: ".tasks-frame",
  },
  {
    id: "compose",
    name: "Compose (new message)",
    base: true,
    go: async (p) => {
      await mail(p);
      await key(p, "c");
      await p.locator(".compose").first().waitFor();
      await wait(p, 600);
    },
    root: ".compose",
  },
  {
    id: "settings-appearance",
    name: "Settings: Appearance",
    base: true,
    go: (p) => openSettings(p, "Appearance"),
    root: ".settings",
  },
  {
    id: "settings-keyboard",
    name: "Settings: Keyboard shortcuts",
    base: true,
    go: (p) => openSettings(p, "Keyboard shortcuts"),
    root: ".settings",
  },
  {
    id: "settings-accounts",
    name: "Settings: Accounts",
    base: true,
    go: (p) => openSettings(p, "Accounts"),
    root: ".settings",
  },
  {
    id: "settings-contacts",
    name: "Settings: Contacts",
    base: true,
    go: (p) => openSettings(p, "Contacts"),
    root: ".settings",
  },
  {
    id: "settings-compose",
    name: "Settings: Compose",
    base: true,
    go: (p) => openSettings(p, "Compose"),
    root: ".settings",
  },
  {
    id: "settings-signatures",
    name: "Settings: Signatures",
    base: true,
    go: (p) => openSettings(p, "Signatures"),
    root: ".settings",
  },
  {
    id: "settings-sync",
    name: "Settings: Sync",
    base: true,
    go: (p) => openSettings(p, "Sync"),
    root: ".settings",
  },
  {
    id: "settings-notifications",
    name: "Settings: Notifications",
    base: true,
    go: (p) => openSettings(p, "Notifications"),
    root: ".settings",
  },
  {
    id: "settings-mcp",
    name: "Settings: MCP",
    base: true,
    go: (p) => openSettings(p, "MCP"),
    root: ".settings",
  },
  {
    id: "settings-mods",
    name: "Settings: Mods",
    base: true,
    go: (p) => openSettings(p, "Mods"),
    root: ".settings",
  },
  {
    id: "settings-diagnostics",
    name: "Settings: Diagnostics",
    base: true,
    go: (p) => openSettings(p, "Diagnostics"),
    root: ".settings",
  },
  {
    id: "settings-about",
    name: "Settings: About",
    base: true,
    go: (p) => openSettings(p, "About"),
    root: ".settings",
  },
  {
    id: "speed-reader",
    name: "Speed reader",
    base: true,
    go: async (p) => {
      await mail(p);
      await clickCenter(
        p,
        p.locator(".thread-row", { hasText: "Notes from the garden club" }).first(),
      );
      await wait(p, 1200);
      await key(p, "Shift+R");
      await p.locator(".speed-reader").waitFor();
      await wait(p, 400);
    },
    root: ".speed-reader",
  },
  {
    id: "mail-search",
    name: "Mail search (results)",
    base: true,
    go: async (p) => {
      await mail(p);
      await p
        .getByRole("searchbox", { name: "Search mail" })
        .or(p.getByLabel("Search mail"))
        .first()
        .click();
      await p.keyboard.type("review");
      await wait(p, 1200);
    },
    root: ".shell__list",
  },
  {
    id: "attachments",
    name: "Attachment list",
    base: true,
    go: (p) => openThread(p, "Icon sketches for the dock"),
    root: ".attachments",
  },
  {
    id: "conversation-many",
    name: "Conversation with many messages",
    base: true,
    go: (p) => openThread(p, "Re: Lisbon in March?"),
    root: ".shell__view",
  },
  {
    id: "reading-options",
    name: "Speed reader: reading options",
    base: true,
    go: async (p) => {
      await openThread(p, "Notes from the garden club");
      await key(p, "Shift+R");
      await p.locator(".speed-reader").waitFor();
      await p.getByRole("button", { name: "Reading options" }).first().click();
      await wait(p, 400);
    },
    root: ".speed-reader",
  },
  {
    id: "recent-searches",
    name: "Recent searches",
    base: true,
    go: async (p) => {
      await mail(p);
      const box = p.getByLabel("Search mail").first();
      await box.click();
      await p.keyboard.type("review");
      await key(p, "Enter");
      await wait(p, 800);
      await box.fill("");
      await key(p, "Escape");
      await p
        .locator(".thread-list")
        .first()
        .click({ position: { x: 5, y: 5 } })
        .catch(() => {});
      await box.click();
      await wait(p, 600);
    },
    root: ".mail-search__recent",
  },
];

// The default sidebar width, and the narrowest the app allows (a stored 1 px is clamped up to it).
// Two windows: 1280x800, and the smallest the app allows (tauri.conf.json minWidth/minHeight).
const WINDOWS = [
  { id: "1280", width: 1280, height: 800 },
  { id: "900", width: 900, height: 600 },
];
const VARIANTS = WINDOWS.flatMap((w) =>
  ["light", "dark"].flatMap((scheme) =>
    [
      ["default", 220],
      ["narrowest", 1],
    ].map(([side, sidebar]) => ({ id: `${w.id}-${scheme}-${side}`, scheme, sidebar, w })),
  ),
);

const browser = await chromium.launch();
const results = {};
for (const part of PARTS.filter((p) => !ONLY || ONLY.split(",").includes(p.id))) {
  results[part.id] = { name: part.name, base: !!part.base, variants: {} };
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.w.width, height: v.w.height },
      deviceScaleFactor: 2,
      colorScheme: v.scheme,
      // Fixed, so a run is repeatable: the fixtures and where things open follow the clock.
      timezoneId: "America/Chicago",
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
    await page.clock.setFixedTime(new Date("2026-11-10T13:00:00-06:00"));
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
      if (SHOTS) {
        const el = page.locator(part.root).first();
        const box = await el.boundingBox();
        const pad = 8;
        const clip = {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(v.w.width - Math.max(0, box.x - pad), box.width + 2 * pad),
          height: Math.min(v.w.height - Math.max(0, box.y - pad), box.height + 2 * pad),
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
