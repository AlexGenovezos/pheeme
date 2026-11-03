#!/usr/bin/env node
// Nightly real-app run (#47 item 4): launch the release build through tauri-driver, then
// measure cold start to the first list paint, idle memory after a minute, and memory after a
// scripted session. Writes github-action-benchmark JSON and fails when a budget is exceeded.
// Run it inside `xvfb-run` and `dbus-run-session` against a data dir filled by
// `cargo run --example seed_mailbox`. See docs/performance.md.
//
//   node scripts/perf/app-run.mjs --app src-tauri/target/release/pheeme --home <dir> \
//     [--out perf.json] [--idle-seconds 60] [--session-minutes 10]

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    app: { type: "string" },
    home: { type: "string" },
    out: { type: "string", default: "perf.json" },
    "idle-seconds": { type: "string", default: "60" },
    "session-minutes": { type: "string", default: "10" },
    port: { type: "string", default: "4444" },
  },
});
if (!opts.app || !opts.home) throw new Error("--app and --home are required");
const app = resolve(opts.app);

/** About 20% above the first measured baseline (docs/performance.md). */
const BUDGETS = {
  // Measured on ubuntu-22.04 runners (Xvfb, software rendering) on 2026-11-03: 1590 ms and
  // 239 MiB idle, over the issue's starting targets of 1.5 s and 150 MiB.
  "Cold start to first list paint": { unit: "ms", max: 2000 },
  "Idle memory (app + WebKit, PSS)": { unit: "MiB", max: 290 },
  "Memory after the session (app + WebKit, PSS)": { unit: "MiB", max: 350 },
};

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

/** Total proportional set size (shared pages split between their users) and RSS, in MiB. */
function memory() {
  let pss = 0;
  let rss = 0;
  const pids = appProcesses();
  for (const pid of pids) {
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      pss += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      rss += Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
    } catch {
      // exited meanwhile
    }
  }
  if (pids.length === 0) throw new Error(`no running process for ${app}`);
  return { pss: pss / 1024, rss: rss / 1024, processes: pids.length };
}

const LINKS = 'nav[aria-label="Mailboxes"] [role="link"]';

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
  await run(
    session,
    `const l = document.querySelector('[role="listbox"]');
     l.scrollTop = l.scrollHeight;
     l.scrollTop = 0;
     l.querySelector('[role="option"]')?.click();
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

  const started = performance.now();
  ({ sessionId: session } = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: app }, browserName: "wry" } },
  }));
  for (;;) {
    try {
      await find(session, '[role="listbox"] [role="option"]');
      break;
    } catch (e) {
      if (e.code !== "no such element") throw e;
      if (performance.now() - started > 60_000) throw new Error("the list never painted");
      await sleep(20);
    }
  }
  const coldStart = performance.now() - started;
  console.log(`cold start to first list paint: ${coldStart.toFixed(0)} ms`);

  await sleep(Number(opts["idle-seconds"]) * 1000);
  const idle = memory();
  console.log(
    `idle: ${idle.pss.toFixed(1)} MiB PSS, ${idle.rss.toFixed(1)} MiB RSS, ${idle.processes} processes`,
  );

  const until = Date.now() + Number(opts["session-minutes"]) * 60_000;
  let passes = 0;
  while (Date.now() < until) {
    await sessionPass(session);
    passes++;
  }
  await sleep(5_000);
  const after = memory();
  console.log(
    `after ${passes} session passes: ${after.pss.toFixed(1)} MiB PSS, ${after.rss.toFixed(1)} MiB RSS`,
  );

  const results = [
    { name: "Cold start to first list paint", value: Math.round(coldStart) },
    { name: "Idle memory (app + WebKit, PSS)", value: +idle.pss.toFixed(1) },
    { name: "Memory after the session (app + WebKit, PSS)", value: +after.pss.toFixed(1) },
  ].map((r) => ({ ...r, unit: BUDGETS[r.name].unit }));
  writeFileSync(opts.out, JSON.stringify(results, null, 2));

  const over = results.filter((r) => r.value > BUDGETS[r.name].max);
  for (const r of over)
    console.error(`over budget: ${r.name} ${r.value} ${r.unit} > ${BUDGETS[r.name].max}`);
  process.exitCode = over.length ? 1 : 0;
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
}
