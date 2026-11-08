import { describe, expect, it } from "vitest";
import { format, summarize } from "./installs.mjs";

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
