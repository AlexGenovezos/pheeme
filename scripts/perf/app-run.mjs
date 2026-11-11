#!/usr/bin/env node
// Nightly real-app run (#47 item 4): launch the release build through tauri-driver, then
// measure cold start to the first list paint, idle memory after a minute, and memory after a
// scripted session. Writes github-action-benchmark JSON and fails when a budget is exceeded.
// Run it inside `xvfb-run` and `dbus-run-session` against a data dir filled by
// `cargo run --example seed_mailbox`. See docs/performance.md.
//
//   node scripts/perf/app-run.mjs --app src-tauri/target/release/pheeme --home <dir> \
//     [--out perf.json] [--startup-out startup.json] [--idle-seconds 60] [--session-minutes 10]

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    app: { type: "string" },
    home: { type: "string" },
    out: { type: "string", default: "perf.json" },
    "startup-out": { type: "string", default: "startup.json" },
    "idle-seconds": { type: "string", default: "60" },
    "session-minutes": { type: "string", default: "10" },
    port: { type: "string", default: "4444" },
  },
});
if (!opts.app || !opts.home) throw new Error("--app and --home are required");
const app = resolve(opts.app);

/** About 20% above the measured baseline (docs/performance.md). */
const BUDGETS = {
  // Measured on ubuntu-22.04 runners (Xvfb, software rendering) on 2026-11-03: single starts
  // of 913-2120 ms, 236-240 MiB idle, 300-310 MiB after the session. Idle is over the
  // issue's starting target of 150 MiB. Re-measured on 2026-11-08 after preloading ahead of
  // the reader (#154: 160 cached conversations, 5 rendered): 269-281 MiB idle, 355-365 MiB
  // after the session.
  "Start to first list paint (median of 5)": { unit: "ms", max: 3000 },
  "Idle memory (app + WebKit, PSS)": { unit: "MiB", max: 330 },
  // The total swings with WebKit's garbage collector (#274): in about half the runs it lets the session's
  // garbage pile up for 40-70 passes before a full collection, then keeps part of that peak, so the same
  // commit ends at 375 or 434 MiB. This ceiling only catches gross growth; the two below catch leaks.
  "Memory after the session (app + WebKit, PSS)": { unit: "MiB", max: 460 },
  // The Rust process doesn't depend on WebKit's timing: 134-138 MiB after the session on 2026-11-10.
  "App process after the session (PSS)": { unit: "MiB", max: 165 },
  // WebKit's web process, the lowest reading late in the session minus the lowest early on: a leak keeps
  // raising the floor, a late collection doesn't. 17-26 MiB on 2026-11-10 (or below zero after a pile-up).
  "Web process growth during the session (PSS)": { unit: "MiB", max: 45 },
};

const LAUNCHES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${opts.port}`;

async function wd(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${json.value?.message ?? res.status}`);
    err.code = json.value?.error;
    throw err;
  }
  return json.value;
}

const find = (session, css) =>
  wd("POST", `/session/${session}/element`, { using: "css selector", value: css });
const run = (session, script, args = []) =>
  wd("POST", `/session/${session}/execute/sync`, { script, args });

/** pid -> parent pid, for every process. */
function processTable() {
  const table = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      table.set(Number(name), ppid);
    } catch {
      // exited meanwhile
    }
  }
  return table;
}

/** The app's pid and every process under it (WebKit's web and network processes). */
function appProcesses() {
  const table = processTable();
  const roots = [...table.keys()].filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] === app;
    } catch {
      return false;
    }
  });
  const all = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of table)
      if (all.has(ppid) && !all.has(pid)) {
        all.add(pid);
        grew = true;
      }
  }
  return [...all];
}

/** Total proportional set size (shared pages split between their users) and RSS, in MiB, with
 * PSS per process name (the app, WebKitWebProcess, WebKitNetworkProcess). */
function memory() {
  let pss = 0;
  let rss = 0;
  const byName = {};
  const pids = appProcesses();
  for (const pid of pids) {
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const p = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      pss += p;
      rss += Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      byName[name] = (byName[name] ?? 0) + p / 1024;
    } catch {
      // exited meanwhile
    }
  }
  if (pids.length === 0) throw new Error(`no running process for ${app}`);
  return { pss: pss / 1024, rss: rss / 1024, processes: pids.length, byName };
}

/** PSS of WebKit's web process(es) (`comm` is cut to 15 characters: WebKitWebProces). */
const webProcess = (m) =>
  Object.entries(m.byName)
    .filter(([name]) => name.startsWith("WebKitWeb"))
    .reduce((sum, [, v]) => sum + v, 0);
/** PSS of the app's own (Rust) process: everything that isn't WebKit. */
const appProcess = (m) =>
  Object.entries(m.byName)
    .filter(([name]) => !name.startsWith("WebKit"))
    .reduce((sum, [, v]) => sum + v, 0);

const describe = (m) =>
  `${m.pss.toFixed(1)} MiB PSS (${Object.entries(m.byName)
    .map(([n, v]) => `${n} ${v.toFixed(1)}`)
    .join(", ")})`;

const LINKS = 'nav[aria-label="Mailboxes"] [role="link"]';

/** Wait (up to `ms`) for the list to show a row. */
async function waitForRow(session, ms = 15_000) {
  const until = performance.now() + ms;
  for (;;) {
    try {
      return await find(session, '[role="listbox"] [role="option"]');
    } catch (e) {
      if (e.code !== "no such element" || performance.now() > until) throw e;
      await sleep(20);
    }
  }
}

/** One pass of a reading session: every mailbox, a scroll, twenty conversations. */
async function sessionPass(session) {
  const links = await run(
    session,
    `return document.querySelectorAll(${JSON.stringify(LINKS)}).length`,
  );
  for (let i = 0; i < links; i++) {
    await run(session, `document.querySelectorAll(arguments[0])[arguments[1]]?.click()`, [
      LINKS,
      i,
    ]);
    await sleep(150);
  }
  // Back to the first mailbox (All Inboxes), and wait for its rows before reading.
  await run(session, `document.querySelector(arguments[0])?.click()`, [LINKS]);
  await waitForRow(session);
  // Separate commands, so the list sees the bottom before it is sent back to the top.
  await run(
    session,
    `const l = document.querySelector('[role="listbox"]'); l.scrollTop = l.scrollHeight;`,
  );
  await sleep(500);
  await run(session, `document.querySelector('[role="listbox"]').scrollTop = 0;`);
  await waitForRow(session);
  await run(
    session,
    `const l = document.querySelector('[role="listbox"]');
     l.querySelector('[role="option"]').click();
     l.focus();`,
  );
  for (let i = 0; i < 20; i++) {
    await wd("POST", `/session/${session}/actions`, {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: "j" },
            { type: "keyUp", value: "j" },
          ],
        },
      ],
    });
    await sleep(100);
  }
}

const env = {
  ...process.env,
  HOME: opts.home,
  XDG_DATA_HOME: `${opts.home}/.local/share`,
  XDG_CACHE_HOME: `${opts.home}/.cache`,
  XDG_CONFIG_HOME: `${opts.home}/.config`,
  WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  // Tauri only lets WebKitWebDriver drive the webview with this set.
  TAURI_WEBVIEW_AUTOMATION: "true",
};
const driver = spawn("tauri-driver", ["--port", opts.port], { env, stdio: "inherit" });
let session;
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/status`);
      break;
    } catch {
      if (i > 100) throw new Error("tauri-driver didn't start");
      await sleep(100);
    }
  }

  // Launch it LAUNCHES times and keep the last session open. One start on a shared runner
  // varied from 0.9 to 2.1 s, so the median is what's reported.
  const starts = [];
  for (let i = 0; i < LAUNCHES; i++) {
    if (session) {
      await wd("DELETE", `/session/${session}`);
      session = undefined;
      // The next launch (and the memory reading) must not overlap this instance.
      for (let waited = 0; appProcesses().length > 0; waited += 100) {
        if (waited > 15_000) throw new Error("the previous app instance didn't exit");
        await sleep(100);
      }
      await sleep(500);
    }
    const started = performance.now();
    ({ sessionId: session } = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: app }, browserName: "wry" } },
    }));
    await waitForRow(session, 60_000);
    starts.push(performance.now() - started);
  }
  const coldStart = [...starts].sort((a, b) => a - b)[LAUNCHES >> 1];
  console.log(
    `start to first list paint: median ${coldStart.toFixed(0)} ms of ${starts.map((t) => t.toFixed(0)).join(", ")}`,
  );

  await sleep(Number(opts["idle-seconds"]) * 1000);
  const idle = memory();
  console.log(
    `idle: ${idle.pss.toFixed(1)} MiB PSS, ${idle.rss.toFixed(1)} MiB RSS, ${idle.processes} processes`,
  );
  console.log(`idle by process: ${describe(idle)}`);

  const until = Date.now() + Number(opts["session-minutes"]) * 60_000;
  let passes = 0;
  /** The web process every 10 passes. */
  const timeline = [];
  while (Date.now() < until) {
    await sessionPass(session);
    passes++;
    if (passes % 10 === 0) {
      const m = memory();
      timeline.push({ passes, web: webProcess(m) });
      console.log(`pass ${passes}: ${describe(m)}`);
    }
  }
  await sleep(5_000);
  const after = memory();
  console.log(
    `after ${passes} session passes: ${after.pss.toFixed(1)} MiB PSS, ${after.rss.toFixed(1)} MiB RSS`,
  );
  console.log(`after the session by process: ${describe(after)}`);
  timeline.push({ passes, web: webProcess(after) });
  const lowest = (from, to) =>
    Math.min(...timeline.filter((t) => t.passes >= from && t.passes <= to).map((t) => t.web));
  // Early: once the caches are warm (pass 20) and before the first pile-ups are usually collected.
  // Late: the last third of the session.
  const growth = lowest(Math.round((passes * 2) / 3), passes) - lowest(20, 40);
  if (!Number.isFinite(growth))
    throw new Error(`only ${passes} session passes: too few to measure growth (needs 20 or more)`);
  console.log(`web process growth (lowest late minus lowest early): ${growth.toFixed(1)} MiB`);

  const results = [
    { name: "Start to first list paint (median of 5)", value: Math.round(coldStart) },
    { name: "Idle memory (app + WebKit, PSS)", value: +idle.pss.toFixed(1) },
    { name: "Memory after the session (app + WebKit, PSS)", value: +after.pss.toFixed(1) },
    { name: "App process after the session (PSS)", value: +appProcess(after).toFixed(1) },
    { name: "Web process growth during the session (PSS)", value: +growth.toFixed(1) },
  ].map((r) => ({ ...r, unit: BUDGETS[r.name].unit }));
  // Memory goes in one file (compared with earlier runs, failing on a regression), start
  // time in another (tracked only: it's too noisy on shared runners for a 20% alert). The
  // growth is gated on its budget only: it sits near zero, where a 20% change means nothing.
  writeFileSync(opts.out, JSON.stringify(results.slice(1, 4), null, 2));
  writeFileSync(opts["startup-out"], JSON.stringify(results.slice(0, 1), null, 2));

  const over = results.filter((r) => r.value > BUDGETS[r.name].max);
  for (const r of over)
    console.error(`over budget: ${r.name} ${r.value} ${r.unit} > ${BUDGETS[r.name].max}`);
  process.exitCode = over.length ? 1 : 0;
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
}
