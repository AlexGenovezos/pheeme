// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { handleUsage, MAX_USAGE_BYTES } from "./usage";
import type { UsageDeps, UsageRecord } from "./types";

const NOW = new Date("2026-11-16T09:00:00Z");
const ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

function body(overrides: Record<string, unknown> = {}) {
  return {
    installId: ID,
    day: "2026-11-15",
    version: "0.28.0",
    os: "macos",
    arch: "aarch64",
    accounts: 2,
    screens: [
      { name: "calendar.week", opens: 3, ms: 120000 },
      { name: "mail.inbox", opens: 9, ms: 3_600_000 },
    ],
    commands: [{ id: "go.inbox", key: 4, palette: 1, button: 0 }],
    rebound: [
      { id: "go.inbox", key: "g h" },
      { id: "calendar.today", key: null },
    ],
    ...overrides,
  };
}

function report(opts: { json?: unknown; raw?: string; method?: string } = {}): Request {
  const url = "https://diagnostics.pheeme.email/v1/usage";
  const method = opts.method ?? "POST";
  const headers = { "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" };
  if (method === "GET") return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: opts.raw ?? JSON.stringify(opts.json ?? body()),
  });
}

function deps(over: { known?: boolean; limited?: boolean } = {}) {
  const put = vi.fn(async () => ({}));
  const get = vi.fn(async () => (over.known === false ? null : { json: async <T>() => ({}) as T }));
  const d: UsageDeps = {
    bucket: { put, get },
    perIp: { limit: async () => ({ success: !over.limited }) },
    now: () => NOW,
  };
  return { d, put, get };
}

function written(put: ReturnType<typeof deps>["put"]): { key: string; record: UsageRecord } {
  const [key, bytes] = put.mock.calls[0] as unknown as [string, ArrayBuffer];
  return { key, record: JSON.parse(new TextDecoder().decode(bytes)) };
}

describe("handleUsage", () => {
  it("stores one report per install and day, only the known fields", async () => {
    const { d, put, get } = deps();
    const res = await handleUsage(report({ json: body({ extra: "dropped" }) }), d);
    expect(res.status).toBe(204);
    expect(get).toHaveBeenCalledWith(`installs/${ID}.json`);
    const { key, record } = written(put);
    expect(key).toBe(`usage/2026-11-15/${ID}.json`);
    expect(record).toEqual({ ...body(), installId: undefined, receivedAt: NOW.toISOString() });
    expect("installId" in record).toBe(false);
  });

  it("refuses an install that never pinged", async () => {
    const { d, put } = deps({ known: false });
    expect((await handleUsage(report(), d)).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ["a name that isn't an app id", { screens: [{ name: "Label: Taxes", opens: 1, ms: 1 }] }],
    ["a negative count", { commands: [{ id: "go.inbox", key: -1, palette: 0, button: 0 }] }],
    ["more than a day on screen", { screens: [{ name: "mail.inbox", opens: 1, ms: 90_000_000 }] }],
    ["a day too old", { day: "2026-10-01" }],
    ["a day in the future", { day: "2026-11-20" }],
    ["a day that doesn't exist", { day: "2026-02-30" }],
    ["a bad install ID", { installId: "not-a-uuid" }],
    ["a rebound key with a line break", { rebound: [{ id: "go.inbox", key: "g\nh" }] }],
    ["no screens list", { screens: undefined }],
  ])("refuses %s", async (_, overrides) => {
    const { d, put } = deps();
    expect((await handleUsage(report({ json: body(overrides) }), d)).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses non-JSON, other methods, floods and oversized bodies", async () => {
    expect((await handleUsage(report({ raw: "{" }), deps().d)).status).toBe(400);
    expect((await handleUsage(report({ method: "GET" }), deps().d)).status).toBe(405);
    expect((await handleUsage(report(), deps({ limited: true }).d)).status).toBe(429);
    const big = JSON.stringify(body({ pad: "x".repeat(MAX_USAGE_BYTES) }));
    expect((await handleUsage(report({ raw: big }), deps().d)).status).toBe(413);
  });
});
