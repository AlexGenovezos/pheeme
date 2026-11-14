import { describe, expect, it } from "vitest";
import { format, readAll, summarize, wranglerConfigPath } from "./installs.mjs";

const NOW = new Date("2026-11-07T12:00:00Z");
const record = (over) => ({
  firstSeen: "2026-10-10T09:00:00.000Z",
  lastSeen: "2026-11-07T09:00:00.000Z",
  version: "0.16.0",
  os: "macos",
  osVersion: "macOS 15.1",
  arch: "aarch64",
  ...over,
});

describe("summarize", () => {
  it("counts installs by recency and by machine", () => {
    const s = summarize(
      [
        record(),
        record({ lastSeen: "2026-11-03T09:00:00.000Z", firstSeen: "2026-11-03T09:00:00.000Z" }),
        record({
          lastSeen: "2026-10-20T09:00:00.000Z",
          os: "windows",
          osVersion: "Windows 11 (10.0.26100)",
          arch: "x86_64",
          version: "0.15.0",
        }),
      ],
      NOW,
    );
    expect(s).toMatchObject({ active30d: 3, active7d: 2, active1d: 1, new7d: 1 });
    expect(s.byOs).toEqual([
      ["macos", 2],
      ["windows", 1],
    ]);
    expect(s.byChip).toEqual([
      ["macos ARM / Apple Silicon", 2],
      ["windows Intel / AMD", 1],
    ]);
    expect(s.byVersion[0]).toEqual(["0.16.0", 2]);
    expect(format(s)).toContain("Active installs (last 30 days): 3");
  });

  it("handles no installs", () => {
    expect(summarize([], NOW)).toMatchObject({ active30d: 0, byOs: [] });
  });
});

describe("readAll", () => {
  it("counts failures instead of dropping them, and ignores expired objects", async () => {
    const read = async (key) => {
      if (key === "a") return { os: "macos" };
      if (key === "gone") throw Object.assign(new Error("not found"), { status: 404 });
      if (key === "limited")
        throw Object.assign(new Error("R2 API: 429 slow down"), { status: 429 });
      throw new Error("boom");
    };
    const out = await readAll(["a", "gone", "limited", "bad"], read, 2);
    expect(out.records).toEqual([{ os: "macos" }]);
    expect(out.expired).toBe(1);
    expect(out.failures).toEqual(["limited: R2 API: 429 slow down", "bad: boom"]);
  });
});

describe("wranglerConfigPath", () => {
  it("defaults to the XDG path on Linux and follows the platform elsewhere", () => {
    expect(wranglerConfigPath("linux", {}, "/home/a")).toBe(
      "/home/a/.config/.wrangler/config/default.toml",
    );
    expect(wranglerConfigPath("linux", { XDG_CONFIG_HOME: "/x" }, "/home/a")).toBe(
      "/x/.wrangler/config/default.toml",
    );
    expect(wranglerConfigPath("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Preferences/.wrangler/config/default.toml",
    );
    expect(
      wranglerConfigPath("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a"),
    ).toContain("xdg.config");
    expect(wranglerConfigPath("linux", { WRANGLER_CONFIG_PATH: "/custom.toml" }, "/h")).toBe(
      "/custom.toml",
    );
  });
});
