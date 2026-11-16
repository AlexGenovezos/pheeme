#!/usr/bin/env node
// What people do in Pheeme: reads the anonymous usage reports the diagnostics Worker keeps in R2
// (`usage/<day>/<installId>.json`, one per install and local day, deleted after 30 days) and
// prints which screens are used and for how long, which commands run and how (shortcut, palette
// or button), which shortcuts people rebind, and how many accounts they connect.
//
// usage: node scripts/usage.mjs [--days N] [--json]
// Needs Alex's `wrangler login`, like scripts/installs.mjs.
// Exits 1 if any report couldn't be read, since the counts would be too low.
import { fileURLToPath } from "node:url";
import { listKeys, readAll, readJson, token } from "./installs.mjs";

const PREFIX = "usage/";
const DAY_MS = 24 * 60 * 60 * 1000;

/** `usage/<day>/<installId>.json` → `{ day, installId }`, or null for anything else. */
export function parseKey(key) {
  const m = /^usage\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})\.json$/.exec(key);
  return m ? { day: m[1], installId: m[2] } : null;
}

/** The keys of reports for the `days` days up to `now`. */
export function recentKeys(keys, days, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  return keys.filter((k) => {
    const parsed = parseKey(k);
    return parsed && parsed.day >= from;
  });
}

const sortRows = (rows, by) => rows.sort((a, b) => b[by] - a[by] || a.name.localeCompare(b.name));

/**
 * Totals from reports (`UsageRecord` in workers/diagnostics/src/types.ts, each with the
 * `installId` from its key).
 */
export function summarize(reports) {
  const installs = new Set(reports.map((r) => r.installId));
  const screens = new Map();
  const commands = new Map();
  const latest = new Map();
  for (const r of reports) {
    for (const s of r.screens) {
      const row = screens.get(s.name) ?? {
        name: s.name,
        installs: new Set(),
        opens: 0,
        ms: 0,
        days: 0,
      };
      row.installs.add(r.installId);
      row.opens += s.opens;
      row.ms += s.ms;
      row.days += 1;
      screens.set(s.name, row);
    }
    for (const c of r.commands) {
      const row = commands.get(c.id) ?? {
        name: c.id,
        installs: new Set(),
        key: 0,
        palette: 0,
        button: 0,
      };
      row.installs.add(r.installId);
      row.key += c.key;
      row.palette += c.palette;
      row.button += c.button;
      commands.set(c.id, row);
    }
    const prev = latest.get(r.installId);
    if (!prev || r.day > prev.day) latest.set(r.installId, r);
  }

  const rebound = new Map();
  const accounts = new Map();
  for (const r of latest.values()) {
    for (const { id, key } of r.rebound) {
      const row = rebound.get(id) ?? { name: id, installs: 0, keys: new Map() };
      row.installs += 1;
      const k = key ?? "(removed)";
      row.keys.set(k, (row.keys.get(k) ?? 0) + 1);
      rebound.set(id, row);
    }
    accounts.set(r.accounts, (accounts.get(r.accounts) ?? 0) + 1);
  }

  return {
    installs: installs.size,
    reports: reports.length,
    days: new Set(reports.map((r) => r.day)).size,
    screens: sortRows(
      [...screens.values()].map((s) => ({
        name: s.name,
        installs: s.installs.size,
        opens: s.opens,
        hours: s.ms / 3_600_000,
        minutesPerDay: s.ms / 60_000 / s.days,
      })),
      "hours",
    ),
    commands: sortRows(
      [...commands.values()].map((c) => ({
        name: c.name,
        installs: c.installs.size,
        total: c.key + c.palette + c.button,
        key: c.key,
        palette: c.palette,
        button: c.button,
      })),
      "total",
    ),
    rebound: sortRows(
      [...rebound.values()].map((r) => ({
        name: r.name,
        installs: r.installs,
        keys: [...r.keys].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, installs: n })),
      })),
      "installs",
    ),
    accounts: [...accounts]
      .sort((a, b) => a[0] - b[0])
      .map(([n, installs]) => ({ accounts: n, installs })),
  };
}

const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");

export function format(s, days) {
  const lines = [
    `Usage reports, last ${days} days: ${s.reports} from ${s.installs} installs over ${s.days} days`,
    "",
    "Screens (by time on screen)",
    "  installs  opens    hours  min/day  screen",
    ...s.screens.map(
      (r) =>
        `  ${String(r.installs).padStart(8)}  ${String(r.opens).padStart(5)}  ${r.hours.toFixed(1).padStart(7)}  ${r.minutesPerDay.toFixed(1).padStart(7)}  ${r.name}`,
    ),
    "",
    "Commands (by times run; how: shortcut / palette / button)",
    "  installs    runs   key  palette  button  command",
    ...s.commands.map(
      (r) =>
        `  ${String(r.installs).padStart(8)}  ${String(r.total).padStart(6)}  ${pct(r.key, r.total).padStart(4)}  ${pct(r.palette, r.total).padStart(7)}  ${pct(r.button, r.total).padStart(6)}  ${r.name}`,
    ),
    "",
    "Rebound shortcuts (installs; most common new keys)",
    ...(s.rebound.length
      ? s.rebound.map(
          (r) =>
            `  ${String(r.installs).padStart(8)}  ${r.name}: ${r.keys
              .slice(0, 3)
              .map((k) => `${k.key} (${k.installs})`)
              .join(", ")}`,
        )
      : ["  none"]),
    "",
    "Connected accounts (installs)",
    ...s.accounts.map((a) => `  ${String(a.installs).padStart(8)}  ${a.accounts}`),
    "",
    "Only installs with usage stats on report; each install sends one report per day it was used.",
  ];
  return lines.join("\n");
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const days = Number(argValue("--days", "30"));
  const tok = token();
  const keys = recentKeys(await listKeys(PREFIX, tok), days);
  const { records, failures } = await readAll(keys, async (key) => ({
    ...(await readJson(key, tok)),
    installId: parseKey(key).installId,
  }));
  const summary = summarize(records);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...summary, failed: failures.length }, null, 2));
  } else {
    console.log(format(summary, days));
  }
  if (failures.length > 0) {
    console.error(`\nINCOMPLETE: ${failures.length} report(s) could not be read:`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}
