import { describe, expect, it } from "vitest";
import { format, parseKey, recentKeys, summarize } from "./usage.mjs";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

const report = (installId, day, over = {}) => ({
  installId,
  day,
  version: "0.28.0",
  os: "macos",
  arch: "aarch64",
  accounts: 1,
  screens: [],
  commands: [],
  rebound: [],
  ...over,
});

describe("usage report", () => {
  it("reads the day and install from a key", () => {
    expect(parseKey(`usage/2026-11-15/${A}.json`)).toEqual({ day: "2026-11-15", installId: A });
    expect(parseKey(`installs/${A}.json`)).toBeNull();
    expect(
      recentKeys(
        [`usage/2026-11-15/${A}.json`, `usage/2026-10-01/${A}.json`],
        7,
        new Date("2026-11-16T12:00:00Z"),
      ),
    ).toEqual([`usage/2026-11-15/${A}.json`]);
  });

  it("adds up screens and commands across installs and days", () => {
    const s = summarize([
      report(A, "2026-11-14", {
        screens: [{ name: "mail.inbox", opens: 2, ms: 3_600_000 }],
        commands: [{ id: "go.inbox", key: 3, palette: 1, button: 0 }],
        rebound: [{ id: "go.inbox", key: "g h" }],
      }),
      report(A, "2026-11-15", {
        accounts: 2,
        screens: [{ name: "mail.inbox", opens: 1, ms: 1_800_000 }],
        rebound: [{ id: "go.inbox", key: "g j" }],
      }),
      report(B, "2026-11-15", {
        screens: [{ name: "calendar.week", opens: 1, ms: 60_000 }],
        commands: [{ id: "go.inbox", key: 0, palette: 0, button: 4 }],
        rebound: [{ id: "calendar.today", key: null }],
      }),
    ]);
    expect(s.installs).toBe(2);
    expect(s.screens[0]).toEqual({
      name: "mail.inbox",
      installs: 1,
      opens: 3,
      hours: 1.5,
      minutesPerDay: 45,
    });
    expect(s.commands).toEqual([
      { name: "go.inbox", installs: 2, total: 8, key: 3, palette: 1, button: 4 },
    ]);
    // Rebindings and accounts come from each install's latest day.
    expect(s.rebound).toEqual([
      { name: "calendar.today", installs: 1, keys: [{ key: "(removed)", installs: 1 }] },
      { name: "go.inbox", installs: 1, keys: [{ key: "g j", installs: 1 }] },
    ]);
    expect(s.accounts).toEqual([
      { accounts: 1, installs: 1 },
      { accounts: 2, installs: 1 },
    ]);
    expect(format(s, 30)).toContain("go.inbox");
  });
});
