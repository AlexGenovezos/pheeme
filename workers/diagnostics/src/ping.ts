// Receives the app's daily anonymous usage ping. Pure: every binding comes in
// through `PingDeps`, so tests run it under plain Node.
//
// Each install has one object, `installs/<installId>.json`, overwritten by every
// ping. The bucket's 30-day expiry rule deletes it 30 days after the last ping,
// so the objects under `installs/` are exactly the installs active in the last
// 30 days. Nothing else is kept: no IP address, no history of pings.

import type { InstallRecord, PingDeps } from "./types";

export const INSTALLS_PREFIX = "installs/";
/** A ping is about 200 bytes. */
const MAX_BODY_BYTES = 2048;
const MAX_FIELD_CHARS = 100;
/** Must match `simple.period` of the `PING_PER_IP` binding in wrangler.jsonc. */
const PER_IP_PERIOD_SECONDS = 60;
// Random (v4) UUIDs only, as the app makes them.
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

interface Ping {
  installId: string;
  version: string;
  os: string;
  osVersion: string;
  arch: string;
}

export async function handlePing(request: Request, deps: PingDeps): Promise<Response> {
  if (request.method !== "POST") return status(405, "Method not allowed", { allow: "POST" });

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await deps.perIp.limit({ key: ip });
  if (!success) {
    return status(429, "Too many pings, try again later", {
      "retry-after": String(PER_IP_PERIOD_SECONDS),
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return status(400, "Expected application/json");
  }
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return status(413, "Ping too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return status(413, "Ping too large");

  const ping = parsePing(text);
  if (!ping) return status(400, "Malformed ping");

  const key = `${INSTALLS_PREFIX}${ping.installId}.json`;
  const now = deps.now().toISOString();
  const previous = await deps.bucket.get(key);
  const firstSeen = (previous && (await readFirstSeen(previous))) ?? now;
  const record: InstallRecord = {
    firstSeen,
    lastSeen: now,
    version: ping.version,
    os: ping.os,
    osVersion: ping.osVersion,
    arch: ping.arch,
  };
  await deps.bucket.put(key, new TextEncoder().encode(JSON.stringify(record)).buffer, {
    httpMetadata: { contentType: "application/json" },
  });
  return new Response(null, { status: 204 });
}

async function readFirstSeen(object: { json<T>(): Promise<T> }): Promise<string | null> {
  try {
    const old = await object.json<Partial<InstallRecord>>();
    return typeof old.firstSeen === "string" && !Number.isNaN(Date.parse(old.firstSeen))
      ? old.firstSeen
      : null;
  } catch {
    return null;
  }
}

function parsePing(text: string): Ping | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.installId !== "string" || !INSTALL_ID_RE.test(p.installId)) return null;
  const fields = [p.version, p.os, p.osVersion, p.arch];
  if (!fields.every(isShortField)) return null;
  return {
    installId: p.installId,
    version: p.version as string,
    os: p.os as string,
    osVersion: p.osVersion as string,
    arch: p.arch as string,
  };
}

function isShortField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FIELD_CHARS &&
    !CONTROL_RE.test(value)
  );
}

function status(code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status: code,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
