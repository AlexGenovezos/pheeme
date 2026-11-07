// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  DAILY_CAP,
  MAX_BUNDLE_BYTES,
  handleUpload,
  secondsUntilUtcMidnight,
  takeDailySlot,
} from "./handler";
import type { DailyCapState, Deps, KvStorage, Notification } from "./types";

const NOW = new Date("2026-11-06T15:30:00Z");
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function zip(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(ZIP_MAGIC);
  return bytes;
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.13.0",
    os: "macOS 15.1",
    arch: "aarch64",
    replyTo: "jane@gmail.com",
    note: "Opening an email took forever.",
    highlights: [
      "38.2 s from Gmail, 3 retries (429 rateLimitExceeded), sync busy",
      "12.0 s from Gmail, 1 retry (network)",
    ],
    ...overrides,
  };
}

function upload(
  opts: {
    meta?: unknown;
    rawMeta?: string;
    bundle?: Uint8Array<ArrayBuffer> | string | null;
    ip?: string;
    path?: string;
    method?: string;
  } = {},
): Request {
  const url = `https://diagnostics.pheeme.email${opts.path ?? "/v1/upload"}`;
  const method = opts.method ?? "POST";
  const headers = { "cf-connecting-ip": opts.ip ?? "203.0.113.7" };
  if (method === "GET") return new Request(url, { method, headers });
  const form = new FormData();
  if (opts.rawMeta !== undefined) form.set("meta", opts.rawMeta);
  else if (opts.meta !== null) form.set("meta", JSON.stringify(opts.meta ?? meta()));
  const bundle = opts.bundle === undefined ? zip() : opts.bundle;
  if (typeof bundle === "string") form.set("bundle", bundle);
  else if (bundle) {
    form.set("bundle", new Blob([bundle], { type: "application/zip" }), "pheeme-diagnostics.zip");
  }
  return new Request(url, { method, headers, body: form });
}

function deps(over: { limited?: boolean; capped?: boolean; notifyFails?: boolean } = {}) {
  const put = vi.fn(async () => ({}));
  const limit = vi.fn(async () => ({ success: !over.limited }));
  const take = vi.fn(async () => !over.capped);
  const notify = vi.fn<(mail: Notification) => Promise<void>>(async () => {
    if (over.notifyFails) throw new Error("E_SENDER_NOT_VERIFIED");
  });
  const d: Deps = {
    bucket: { put },
    perIp: { limit },
    dailyCap: { take },
    notify,
    now: () => NOW,
    id: () => "abc123",
  };
  return { d, put, limit, take, notify };
}

describe("handleUpload", () => {
  it("stores the bundle under today's date and notifies", async () => {
    const { d, put, notify, limit } = deps();
    const bundle = zip(128);
    const res = await handleUpload(upload({ bundle }), d);

    expect(res.status).toBe(204);
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0] as unknown as [string, ArrayBuffer, unknown];
    expect(key).toBe("2026-11-06/abc123.zip");
    expect(new Uint8Array(body)).toEqual(bundle);
    expect(opts).toEqual({
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { version: "0.13.0", os: "macOS 15.1", replyTo: "jane@gmail.com" },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const mail = notify.mock.calls[0][0];
    expect(mail.subject).toBe("Pheeme diagnostics: jane@gmail.com (0.13.0, macOS 15.1)");
    expect(mail.replyTo).toBe("jane@gmail.com");
    expect(mail.text).toContain("Opening an email took forever.");
    expect(mail.text).toContain("38.2 s from Gmail, 3 retries (429 rateLimitExceeded), sync busy");
    expect(mail.text).toContain("12.0 s from Gmail, 1 retry (network)");
    expect(mail.text).toContain("2026-11-06/abc123.zip");
    expect(mail.text).toContain(
      "wrangler r2 object get pheeme-diagnostics/2026-11-06/abc123.zip --file abc123.zip --remote",
    );
  });

  it("labels an upload without a reply address as anonymous", async () => {
    const { d, put, notify } = deps();
    const res = await handleUpload(upload({ meta: meta({ replyTo: null, note: "" }) }), d);

    expect(res.status).toBe(204);
    const opts = put.mock.calls[0] as unknown as [string, ArrayBuffer, { customMetadata: object }];
    expect(opts[2].customMetadata).toEqual({
      version: "0.13.0",
      os: "macOS 15.1",
      replyTo: "anonymous",
    });
    const mail = notify.mock.calls[0][0];
    expect(mail.subject).toBe("Pheeme diagnostics: anonymous (0.13.0, macOS 15.1)");
    expect(mail.replyTo).toBeNull();
  });

  it.each([
    ["just over 5 MB", MAX_BUNDLE_BYTES + 1],
    ["far over 5 MB, past the body cap", MAX_BUNDLE_BYTES + 512 * 1024],
  ])("rejects a bundle %s with 413 and stores nothing", async (_name, size) => {
    const { d, put, notify, take } = deps();
    const res = await handleUpload(upload({ bundle: zip(size) }), d);

    expect(res.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it("rejects a declared content-length over the cap before reading the body", async () => {
    const { d, put } = deps();
    const req = upload();
    const big = new Request(req.url, {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") ?? "",
        "content-length": String(MAX_BUNDLE_BYTES * 2),
      },
      body: "x",
    });
    const res = await handleUpload(big, d);

    expect(res.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a bundle that is not a zip with 400", async () => {
    const { d, put, take } = deps();
    const res = await handleUpload(upload({ bundle: new TextEncoder().encode("hello") }), d);

    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it.each([
    ["missing meta", { meta: null }],
    ["meta that is not JSON", { rawMeta: "{nope" }],
    ["meta that is not an object", { rawMeta: "[1,2]" }],
    ["missing version", { meta: meta({ version: undefined }) }],
    ["a note over 2000 characters", { meta: meta({ note: "x".repeat(2001) }) }],
    ["more than 20 highlights", { meta: meta({ highlights: Array(21).fill("slow") }) }],
    ["a highlight that is not a string", { meta: meta({ highlights: [42] }) }],
    ["a reply address with a line break", { meta: meta({ replyTo: "a@b.com\r\nBcc: x@y.z" }) }],
    ["a reply address that is not an address", { meta: meta({ replyTo: "jane" }) }],
    ["an os with a line break", { meta: meta({ os: "macOS\nBcc: x@y.z" }) }],
    ["a missing bundle", { bundle: null }],
    ["a bundle sent as text", { bundle: "PK\u0003\u0004" }],
  ])("rejects %s with 400", async (_name, opts) => {
    const { d, put, notify } = deps();
    const res = await handleUpload(upload(opts as Parameters<typeof upload>[0]), d);

    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects a body that is not multipart with 400", async () => {
    const { d } = deps();
    const req = new Request("https://diagnostics.pheeme.email/v1/upload", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zip(),
    });

    expect((await handleUpload(req, d)).status).toBe(400);
  });

  it("answers 429 when the per-IP limit is hit, storing and sending nothing", async () => {
    const { d, put, notify, take } = deps({ limited: true });
    const res = await handleUpload(upload(), d);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(put).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After until UTC midnight when the daily cap is reached", async () => {
    const { d, put, notify } = deps({ capped: true });
    const res = await handleUpload(upload(), d);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(8 * 3600 + 30 * 60));
    expect(put).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still answers 204 when the notification fails", async () => {
    const { d, put } = deps({ notifyFails: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleUpload(upload(), d);

    expect(res.status).toBe(204);
    expect(put).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("answers 404 for other paths and 405 for other methods", async () => {
    const { d, limit } = deps();

    expect((await handleUpload(upload({ path: "/" }), d)).status).toBe(404);
    const res = await handleUpload(upload({ method: "GET" }), d);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("takeDailySlot", () => {
  function memory(): KvStorage & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return {
      data,
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
    };
  }

  it("allows exactly the cap per UTC day", async () => {
    const storage = memory();
    const results = [];
    for (let i = 0; i < DAILY_CAP + 1; i++) results.push(await takeDailySlot(storage, NOW));

    expect(results.filter(Boolean)).toHaveLength(DAILY_CAP);
    expect(results[results.length - 1]).toBe(false);
    expect(storage.data.get("state")).toEqual({ day: "2026-11-06", count: DAILY_CAP });
  });

  it("starts a fresh count on the next UTC day", async () => {
    const storage = memory();
    const full: DailyCapState = { day: "2026-11-06", count: DAILY_CAP };
    await storage.put("state", full);

    expect(await takeDailySlot(storage, new Date("2026-11-06T23:59:59Z"))).toBe(false);
    expect(await takeDailySlot(storage, new Date("2026-11-07T00:00:00Z"))).toBe(true);
    expect(storage.data.get("state")).toEqual({ day: "2026-11-07", count: 1 });
  });
});

describe("secondsUntilUtcMidnight", () => {
  it("counts whole seconds to the next UTC midnight, at least 1", () => {
    expect(secondsUntilUtcMidnight(new Date("2026-11-06T00:00:00Z"))).toBe(86400);
    expect(secondsUntilUtcMidnight(new Date("2026-11-06T23:59:59.500Z"))).toBe(1);
  });
});
