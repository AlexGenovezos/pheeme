// Receives diagnostics uploads from the app. Pure: every binding comes in
// through `Deps`, so tests run it under plain Node.

import type { DailyCapState, Deps, KvStorage, Notification } from "./types";

/** Largest accepted bundle. The app keeps its zip under 4.5 MB. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
/** Room for the `meta` part and multipart framing on top of the bundle. */
const MAX_BODY_BYTES = MAX_BUNDLE_BYTES + 64 * 1024;
/** Accepted uploads per UTC day, across all locations. */
export const DAILY_CAP = 200;
/** Must match `simple.period` of the `PER_IP` binding in wrangler.jsonc. */
const PER_IP_PERIOD_SECONDS = 60;
export const BUCKET_NAME = "pheeme-diagnostics";

const MAX_NOTE_CHARS = 2000;
const MAX_HIGHLIGHTS = 20;
const MAX_HIGHLIGHT_CHARS = 500;
const MAX_FIELD_CHARS = 100;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
// Plain ASCII addresses only: the value goes into Reply-To and Subject headers.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

interface Meta {
  version: string;
  os: string;
  arch: string;
  replyTo: string | null;
  note: string;
  highlights: string[];
}

export async function handleUpload(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/upload") return status(404, "Not found");
  if (request.method !== "POST") {
    return status(405, "Method not allowed", { allow: "POST" });
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await deps.perIp.limit({ key: ip });
  if (!success) {
    return status(429, "Too many uploads, try again later", {
      "retry-after": String(PER_IP_PERIOD_SECONDS),
    });
  }

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return status(413, "Upload too large");
  const body = await readCapped(request.body, MAX_BODY_BYTES);
  if (body === "too_large") return status(413, "Upload too large");

  let form: FormData;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new Error();
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return status(400, "Expected multipart/form-data");
  }

  const bundlePart = form.get("bundle");
  if (bundlePart === null || typeof bundlePart === "string") {
    return status(400, "Missing bundle");
  }
  if (bundlePart.size > MAX_BUNDLE_BYTES) return status(413, "Upload too large");
  const bundle = await bundlePart.arrayBuffer();
  if (!isZip(bundle)) return status(400, "Bundle is not a zip");

  const meta = parseMeta(form.get("meta"));
  if (!meta) return status(400, "Malformed meta");

  const now = deps.now();
  if (!(await deps.dailyCap.take())) {
    return status(429, "Daily upload limit reached, try again tomorrow", {
      "retry-after": String(secondsUntilUtcMidnight(now)),
    });
  }

  const id = deps.id();
  const key = `${utcDay(now)}/${id}.zip`;
  const sender = meta.replyTo ?? "anonymous";
  await deps.bucket.put(key, bundle, {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { version: meta.version, os: meta.os, replyTo: sender },
  });

  try {
    await deps.notify(notification(meta, key, id));
  } catch (error) {
    // The bundle is stored; Alex can still find it in R2.
    console.error(`diagnostics: notification for ${key} failed`, error);
  }
  return new Response(null, { status: 204 });
}

/** Counts one accepted upload against today's cap. Exact as long as a single
 * Durable Object calls it: no await sits between the read and the write, so
 * the input gate keeps concurrent calls from interleaving. */
export async function takeDailySlot(
  storage: KvStorage,
  now: Date,
  cap: number = DAILY_CAP,
): Promise<boolean> {
  const day = utcDay(now);
  const state = await storage.get<DailyCapState>("state");
  const count = state?.day === day ? state.count : 0;
  if (count >= cap) return false;
  await storage.put("state", { day, count: count + 1 } satisfies DailyCapState);
  return true;
}

export function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

function notification(meta: Meta, key: string, id: string): Notification {
  const sender = meta.replyTo ?? "anonymous";
  const highlights = meta.highlights.length
    ? meta.highlights.map((h) => `- ${h}`).join("\n")
    : "(none)";
  const text = [
    meta.note.trim() || "(no note)",
    "",
    "Highlights:",
    highlights,
    "",
    `App: ${meta.version} on ${meta.os} (${meta.arch})`,
    `Reply to: ${sender}`,
    `Bundle: ${key} (deleted after about 30 days)`,
    `Download: wrangler r2 object get ${BUCKET_NAME}/${key} --file ${id}.zip --remote`,
    "",
  ].join("\n");
  return {
    subject: `Pheeme diagnostics: ${sender} (${meta.version}, ${meta.os})`,
    replyTo: meta.replyTo,
    text,
  };
}

function parseMeta(raw: FormDataEntryValue | null): Meta | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;

  const fields = [m.version, m.os, m.arch];
  if (!fields.every(isShortField)) return null;

  let replyTo: string | null = null;
  if (typeof m.replyTo === "string") {
    replyTo = m.replyTo.trim() || null;
    if (replyTo !== null && (replyTo.length > 254 || !EMAIL_RE.test(replyTo))) return null;
  } else if (m.replyTo !== null && m.replyTo !== undefined) {
    return null;
  }

  const note = m.note ?? "";
  if (typeof note !== "string" || [...note].length > MAX_NOTE_CHARS) return null;

  const highlights = m.highlights ?? [];
  if (
    !Array.isArray(highlights) ||
    highlights.length > MAX_HIGHLIGHTS ||
    !highlights.every((h) => typeof h === "string" && [...h].length <= MAX_HIGHLIGHT_CHARS)
  ) {
    return null;
  }

  return {
    version: m.version as string,
    os: m.os as string,
    arch: m.arch as string,
    replyTo,
    note,
    highlights: highlights as string[],
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

function isZip(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return head.length === 4 && ZIP_MAGIC.every((b, i) => head[i] === b);
}

/** Reads the whole body, giving up once it passes `cap` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | "too_large"> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.releaseLock(); // the rest is discarded with the request
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function status(code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status: code,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
