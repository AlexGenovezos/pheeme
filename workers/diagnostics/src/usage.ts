// Receives the app's daily anonymous usage report: for one local day, which screens were open
// (how often, how long), which commands ran by shortcut, palette or button, the user's rebound
// shortcuts and the number of connected accounts. Pure: every binding comes in through
// `UsageDeps`, so tests run it under plain Node.
//
// Only installs the Worker already knows from `/v1/ping` may report, so a report never creates
// an install and needs no quota of its own. Each report is one object,
// `usage/<day>/<installId>.json`, which the bucket's 30-day rule deletes. Names are checked
// against the shape the app's own screen and command ids have, so no free text is stored.

import { readCapped } from "./handler";
import { INSTALLS_PREFIX, status } from "./ping";
import type { UsageDeps, UsageRecord } from "./types";

export const USAGE_PREFIX = "usage/";
/** A day's report is a few KB; this leaves room for a heavy user. */
export const MAX_USAGE_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;
const MAX_REBOUND = 300;
const MAX_FIELD_CHARS = 100;
const MAX_COUNT = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a day may be: the app drops what it couldn't send in 14 days. */
const OLDEST_DAY_MS = 20 * DAY_MS;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The shape of the app's screen names and command ids. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export async function handleUsage(request: Request, deps: UsageDeps): Promise<Response> {
  if (request.method !== "POST") return status(405, "Method not allowed", { allow: "POST" });

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await deps.perIp.limit({ key: ip })).success) {
    return status(429, "Too many reports, try again later", { "retry-after": "60" });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return status(400, "Expected application/json");
  }
  if (Number(request.headers.get("content-length")) > MAX_USAGE_BYTES) {
    return status(413, "Report too large");
  }
  const bytes = await readCapped(request.body, MAX_USAGE_BYTES);
  if (bytes === "too_large") return status(413, "Report too large");

  const now = deps.now();
  const parsed = parseUsage(new TextDecoder().decode(bytes), now);
  if (!parsed) return status(400, "Malformed report");
  const { installId, record } = parsed;

  if (!(await deps.bucket.get(`${INSTALLS_PREFIX}${installId}.json`))) {
    return status(403, "Unknown install");
  }
  await deps.bucket.put(
    `${USAGE_PREFIX}${record.day}/${installId}.json`,
    new TextEncoder().encode(JSON.stringify({ ...record, receivedAt: now.toISOString() })).buffer,
    { httpMetadata: { contentType: "application/json" } },
  );
  return new Response(null, { status: 204 });
}

/** The report, keeping only the fields this Worker knows, or null if anything is off. */
export function parseUsage(
  text: string,
  now: Date,
): { installId: string; record: Omit<UsageRecord, "receivedAt"> } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { installId, day, version, os, arch, accounts, screens, commands, rebound } = value;
  if (typeof installId !== "string" || !INSTALL_ID_RE.test(installId)) return null;
  if (!isRecentDay(day, now)) return null;
  if (![version, os, arch].every(isShortField)) return null;
  if (!isCount(accounts) || (accounts as number) > 1000) return null;
  if (!Array.isArray(screens) || screens.length > MAX_ENTRIES) return null;
  if (!Array.isArray(commands) || commands.length > MAX_ENTRIES) return null;
  if (!Array.isArray(rebound) || rebound.length > MAX_REBOUND) return null;

  const outScreens: UsageRecord["screens"] = [];
  for (const s of screens) {
    if (!isObject(s) || !isName(s.name) || !isCount(s.opens)) return null;
    if (!Number.isInteger(s.ms) || (s.ms as number) < 0 || (s.ms as number) > DAY_MS) return null;
    outScreens.push({ name: s.name as string, opens: s.opens as number, ms: s.ms as number });
  }
  const outCommands: UsageRecord["commands"] = [];
  for (const c of commands) {
    if (!isObject(c) || !isName(c.id)) return null;
    if (![c.key, c.palette, c.button].every(isCount)) return null;
    outCommands.push({
      id: c.id as string,
      key: c.key as number,
      palette: c.palette as number,
      button: c.button as number,
    });
  }
  const outRebound: UsageRecord["rebound"] = [];
  for (const r of rebound) {
    if (!isObject(r) || !isName(r.id)) return null;
    if (r.key !== null && !(isShortField(r.key) && (r.key as string).length <= 80)) return null;
    outRebound.push({ id: r.id as string, key: r.key as string | null });
  }
  return {
    installId,
    record: {
      day: day as string,
      version: version as string,
      os: os as string,
      arch: arch as string,
      accounts: accounts as number,
      screens: outScreens,
      commands: outCommands,
      rebound: outRebound,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): boolean {
  return typeof value === "string" && NAME_RE.test(value);
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
}

function isShortField(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FIELD_CHARS &&
    !CONTROL_RE.test(value)
  );
}

/** A real `YYYY-MM-DD` no older than `OLDEST_DAY_MS` and no later than tomorrow (time zones). */
function isRecentDay(value: unknown, now: Date): boolean {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) return false;
  return at >= now.getTime() - OLDEST_DAY_MS && at <= now.getTime() + DAY_MS;
}
