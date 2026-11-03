import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { useAccountStore } from "./accountStore";

const account = (id: string, synced: boolean): AccountInfo => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  clientId: "c.apps.googleusercontent.com",
  synced,
});

beforeEach(() => useAccountStore.setState({ accounts: [account("a", false), account("b", false)], loaded: true, error: null }));

test("markSynced flips one account and leaves the rest", () => {
  const before = useAccountStore.getState().accounts;
  useAccountStore.getState().markSynced("b");
  const after = useAccountStore.getState().accounts;
  expect(after.map((a) => [a.id, a.synced])).toEqual([["a", false], ["b", true]]);
  expect(after[0]).toBe(before[0]);
  // Already synced, or unknown: nothing changes.
  useAccountStore.getState().markSynced("b");
  useAccountStore.getState().markSynced("zzz");
  expect(useAccountStore.getState().accounts).toBe(after);
});

test("sync:completed marks that account synced", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  await emit("sync:completed", { accountId: "a" });
  await vi.waitFor(() => expect(useAccountStore.getState().accounts.find((a) => a.id === "a")?.synced).toBe(true));
  expect(useAccountStore.getState().accounts.find((a) => a.id === "b")?.synced).toBe(false);
  stop();
});
