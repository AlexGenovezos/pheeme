// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { handlePing } from "./ping";
import type { InstallRecord, PingDeps } from "./types";

const NOW = new Date("2026-11-07T15:30:00Z");
const ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

function body(overrides: Record<string, unknown> = {}) {
  return {
    installId: ID,
    version: "0.16.0",
    os: "macos",
    osVersion: "macOS 15.1",
    arch: "aarch64",
    ...overrides,
  };
}

function ping(
  opts: { json?: unknown; raw?: string; method?: string; contentType?: string } = {},
): Request {
  const url = "https://diagnostics.pheeme.email/v1/ping";
  const method = opts.method ?? "POST";
  const headers = {
    "cf-connecting-ip": "203.0.113.7",
    "content-type": opts.contentType ?? "application/json",
  };
  if (method === "GET") return new Request(url, { method, headers });
  const text = opts.raw ?? JSON.stringify(opts.json ?? body());
  return new Request(url, { method, headers, body: text });
}

function deps(over: { limited?: boolean; stored?: Partial<InstallRecord> | "garbage" } = {}) {
  const put = vi.fn(async () => ({}));
  const get = vi.fn(async () => {
    if (over.stored === undefined) return null;
    const stored = over.stored;
    return {
      json: async <T>() => {
        if (stored === "garbage") throw new SyntaxError("bad json");
        return stored as T;
      },
    };
  });
  const limit = vi.fn(async () => ({ success: !over.limited }));
  const d: PingDeps = { bucket: { put, get }, perIp: { limit }, now: () => NOW };
  return { d, put, get, limit };
}

function written(put: ReturnType<typeof deps>["put"]): { key: string; record: InstallRecord } {
  const [key, bytes] = put.mock.calls[0] as unknown as [string, ArrayBuffer];
  return { key, record: JSON.parse(new TextDecoder().decode(bytes)) };
}

describe("handlePing", () => {
  it("stores one record per install with the machine details", async () => {
    const { d, put } = deps();
    const res = await handlePing(ping(), d);
    expect(res.status).toBe(204);
    const { key, record } = written(put);
    expect(key).toBe(`installs/${ID}.json`);
    expect(record).toEqual({
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
      version: "0.16.0",
      os: "macos",
      osVersion: "macOS 15.1",
      arch: "aarch64",
    });
  });

  it("keeps the first-seen time of an install it already knows", async () => {
    const { d, put } = deps({ stored: { firstSeen: "2026-10-01T08:00:00.000Z" } });
    await handlePing(ping(), d);
    const { record } = written(put);
    expect(record.firstSeen).toBe("2026-10-01T08:00:00.000Z");
    expect(record.lastSeen).toBe(NOW.toISOString());
  });

  it("starts over when the stored record is unreadable", async () => {
    const { d, put } = deps({ stored: "garbage" });
    expect((await handlePing(ping(), d)).status).toBe(204);
    expect(written(put).record.firstSeen).toBe(NOW.toISOString());
  });

  it("never stores the IP address or extra fields", async () => {
    const { d, put } = deps();
    await handlePing(ping({ json: body({ email: "jane@gmail.com" }) }), d);
    const [, bytes, options] = put.mock.calls[0] as unknown as [string, ArrayBuffer, object];
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain("jane");
    expect(JSON.stringify(options)).not.toContain("203.0.113.7");
  });

  it.each([
    ["a non-UUID install ID", body({ installId: "../../2026-11-06/x" })],
    ["an uppercase install ID", body({ installId: ID.toUpperCase() })],
    ["a missing field", body({ osVersion: undefined })],
    ["an empty field", body({ arch: "" })],
    ["a line break", body({ osVersion: "macOS\n15.1" })],
    ["a long field", body({ version: "x".repeat(101) })],
    ["a non-object", [ID]],
  ])("refuses %s", async (_, json) => {
    const { d, put } = deps();
    expect((await handlePing(ping({ json }), d)).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses bad JSON, the wrong type and oversized bodies", async () => {
    const { d, put } = deps();
    expect((await handlePing(ping({ raw: "{" }), d)).status).toBe(400);
    expect((await handlePing(ping({ contentType: "text/plain" }), d)).status).toBe(400);
    const big = JSON.stringify(body({ pad: "x".repeat(3000) }));
    expect((await handlePing(ping({ raw: big }), d)).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("answers 405 to other methods and 429 over the per-IP limit", async () => {
    const get = await handlePing(ping({ method: "GET" }), deps().d);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const { d, put } = deps({ limited: true });
    const limited = await handlePing(ping(), d);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(put).not.toHaveBeenCalled();
  });
});
