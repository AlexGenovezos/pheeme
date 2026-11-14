#!/usr/bin/env node
// How many people use Pheeme, and on what: reads the anonymous usage pings the diagnostics
// Worker keeps in R2 (one `installs/<id>.json` per install, deleted 30 days after its last
// ping) and prints counts by OS, OS version, chip and app version.
//
// usage: node scripts/installs.mjs [--json]
// Needs Alex's `wrangler login` (it reuses wrangler's OAuth token, refreshed first).
// Exits 1 if any object couldn't be read, since the counts would be too low.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT = "16ff14fb0430f18bc095f18a64b11c7e";
const BUCKET = "pheeme-diagnostics";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;
const PREFIX = "installs/";
const DAY_MS = 24 * 60 * 60 * 1000;

const CHIP = { aarch64: "ARM / Apple Silicon", x86_64: "Intel / AMD" };

/** Counts from install records (`InstallRecord` in workers/diagnostics/src/types.ts) as of `now`. */
export function summarize(records, now = new Date()) {
  const since = (days) => now.getTime() - days * DAY_MS;
  const seenSince = (days) => records.filter((r) => Date.parse(r.lastSeen) >= since(days)).length;
  const tally = (key) => {
    const counts = new Map();
    for (const r of records) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  return {
    active30d: records.length,
    active7d: seenSince(7),
    active1d: seenSince(1),
    new7d: records.filter((r) => Date.parse(r.firstSeen) >= since(7)).length,
    byOs: tally((r) => r.os),
    byOsVersion: tally((r) => r.osVersion),
    byChip: tally((r) => `${r.os} ${CHIP[r.arch] ?? r.arch}`),
    byVersion: tally((r) => r.version),
  };
}

export function format(s) {
  const table = (title, rows) =>
    [`\n${title}`, ...rows.map(([name, n]) => `  ${String(n).padStart(5)}  ${name}`)].join("\n");
  return [
    `Active installs (last 30 days): ${s.active30d}`,
    `  last 7 days: ${s.active7d}   last 24 h: ${s.active1d}   new this week: ${s.new7d}`,
    table("Operating system", s.byOs),
    table("OS version", s.byOsVersion),
    table("Chip", s.byChip),
    table("Pheeme version", s.byVersion),
    "\nAn install is one copy of the app on one computer; someone on two computers counts twice.",
  ].join("\n");
}

/** Where wrangler keeps its OAuth config: the XDG path on Linux, Library on macOS, AppData on Windows. */
export function wranglerConfigPath(
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
) {
  if (env.WRANGLER_CONFIG_PATH) return env.WRANGLER_CONFIG_PATH;
  if (platform === "darwin") {
    return path.join(home, "Library/Preferences/.wrangler/config/default.toml");
  }
  if (platform === "win32") {
    return path.join(
      env.APPDATA ?? path.join(home, "AppData/Roaming"),
      "xdg.config/.wrangler/config/default.toml",
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    ".wrangler/config/default.toml",
  );
}

function token() {
  // Wrangler's OAuth token lasts an hour; any authenticated wrangler call refreshes it.
  execFileSync("wrangler", ["r2", "bucket", "info", BUCKET], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const config = wranglerConfigPath();
  let text;
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {
    throw new Error(`can't read wrangler's config at ${config}; set WRANGLER_CONFIG_PATH to it`);
  }
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("no wrangler OAuth token; run `wrangler login`");
  return match[1];
}

async function api(route, tok) {
  const res = await fetch(API + route, { headers: { authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    throw Object.assign(new Error(`R2 API ${route}: ${res.status} ${await res.text()}`), {
      status: res.status,
    });
  }
  return res;
}

/** Reads each key with `read`; an object that fails is counted, not dropped. A 404 means it
 * expired between the list and the get (the 30-day rule), which is expected and not a failure. */
export async function readAll(keys, read, concurrency = 20) {
  const records = [];
  const failures = [];
  let expired = 0;
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency).map(async (key) => {
      try {
        return { record: await read(key) };
      } catch (error) {
        if (error?.status === 404) return { expired: true };
        return { failure: `${key}: ${error?.message ?? error}` };
      }
    });
    for (const r of await Promise.all(batch)) {
      if (r.failure) failures.push(r.failure);
      else if (r.expired) expired += 1;
      else records.push(r.record);
    }
  }
  return { records, failures, expired };
}

async function loadRecords(tok) {
  const keys = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ prefix: PREFIX, per_page: "1000" });
    if (cursor) q.set("cursor", cursor);
    const page = await (await api(`/objects?${q}`, tok)).json();
    keys.push(...page.result.map((o) => o.key));
    cursor = page.result_info?.is_truncated ? page.result_info.cursor : null;
  } while (cursor);
  return readAll(keys, async (key) =>
    (await api(`/objects/${encodeURIComponent(key)}`, tok)).json(),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { records, failures } = await loadRecords(token());
  const summary = summarize(records);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...summary, failed: failures.length }, null, 2));
  } else {
    console.log(format(summary));
  }
  if (failures.length > 0) {
    console.error(
      `\nINCOMPLETE: ${failures.length} install record(s) could not be read, so the counts above are too low:`,
    );
    for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
    if (failures.length > 10) console.error(`  ... and ${failures.length - 10} more`);
    process.exitCode = 1;
  }
}
