import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../keyboard/registry";
import type { UsageBatch } from "../lib/tauri";
import { discardUsageCounts } from "./tracker";
import { useUsageTracking } from "./useUsageTracking";

const recordUsage = vi.hoisted(() => vi.fn<(batch: UsageBatch) => Promise<void>>(async () => {}));
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  recordUsage,
}));

describe("useUsageTracking", () => {
  it("sends commands with how they ran, and nothing counted before the switch changed", () => {
    const reg = createRegistry();
    const { unmount } = renderHook(() => useUsageTracking(reg));
    reg.noteRun("go.inbox", "palette");
    discardUsageCounts(); // usage stats turned off (or back on)
    reg.noteRun("calendar.today", "button");
    reg.setOverrides({ "go.inbox": "g h", "mod:x:y": "q" });
    unmount();

    const calls = recordUsage.mock.calls;
    const batch = calls[calls.length - 1][0];
    expect(batch.commands).toEqual([{ id: "calendar.today", source: "button", count: 1 }]);
    expect(batch.rebound).toEqual([{ id: "go.inbox", key: "g h" }]);
  });
});
