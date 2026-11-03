import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { useAccountStore } from "./accountStore";
import { __resetUiStoreForTests, useUiStore } from "./uiStore";

const account = (id: string, synced: boolean): AccountInfo => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  clientId: "c.apps.googleusercontent.com",
  synced,
});

beforeEach(() =>
  useAccountStore.setState({
    accounts: [account("a", false), account("b", false)],
    loaded: true,
    error: null,
    syncErrors: {},
  }),
);

test("markSynced flips one account and leaves the rest", () => {
  const before = useAccountStore.getState().accounts;
  useAccountStore.getState().markSynced("b");
  const after = useAccountStore.getState().accounts;
  expect(after.map((a) => [a.id, a.synced])).toEqual([
    ["a", false],
    ["b", true],
  ]);
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
  await vi.waitFor(() =>
    expect(useAccountStore.getState().accounts.find((a) => a.id === "a")?.synced).toBe(true),
  );
  expect(useAccountStore.getState().accounts.find((a) => a.id === "b")?.synced).toBe(false);
  stop();
});

test("sync:error records the failure per account until that account completes a sync", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  await emit("sync:error", { accountId: "a", code: "network", message: "Gmail didn't answer" });
  await emit("sync:error", { accountId: "b", code: "auth", message: "Sign in again" });
  await vi.waitFor(() =>
    expect(useAccountStore.getState().syncErrors).toEqual({
      a: { code: "network", message: "Gmail didn't answer" },
      b: { code: "auth", message: "Sign in again" },
    }),
  );
  await emit("sync:completed", { accountId: "a" });
  await vi.waitFor(() =>
    expect(useAccountStore.getState().syncErrors).toEqual({
      b: { code: "auth", message: "Sign in again" },
    }),
  );
  stop();
});

describe("removing an account reconciles navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetUiStoreForTests();
    mockIPC(() => undefined);
  });

  const browseAccountA = () => {
    useUiStore
      .getState()
      .setMailbox({ accountId: "a", labelId: "INBOX", category: "CATEGORY_SOCIAL" });
    useUiStore.getState().toggleAccountCollapsed("a");
    useUiStore.getState().toggleAccountCollapsed("b");
    useUiStore.setState({ openThread: "a:t1", checked: ["a:t1", "b:t2", "a:t3"], anchor: "a:t3" });
  };

  test("with two or more accounts left it goes to All Inboxes and forgets the removed account", async () => {
    useAccountStore.setState({
      accounts: [account("a", true), account("b", true), account("c", true)],
    });
    browseAccountA();
    expect(useUiStore.getState().activeAccountId).toBe("a");

    await useAccountStore.getState().remove("a");

    const ui = useUiStore.getState();
    expect(ui.mailbox).toEqual({ accountId: null, labelId: "INBOX" });
    expect(ui.openThread).toBeNull();
    expect(ui.checked).toEqual([]);
    expect(ui.activeAccountId).toBeNull();
    expect(ui.collapsedAccounts).toEqual(["b"]);
    expect(JSON.parse(localStorage.getItem("pheeme.layout")!)).toMatchObject({
      activeAccountId: null,
      collapsedAccounts: ["b"],
    });
  });

  test("with one account left it goes to that account's Primary", async () => {
    browseAccountA();
    await useAccountStore.getState().remove("a");
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "b",
      labelId: "INBOX",
      category: "CATEGORY_PERSONAL",
    });
  });

  test("browsing another account, only the removed account's open and checked conversations go", async () => {
    useAccountStore.setState({
      accounts: [account("a", true), account("b", true), account("c", true)],
    });
    useUiStore.getState().setMailbox({ accountId: null, labelId: "INBOX" });
    useUiStore.setState({
      openThread: "a:t1",
      checked: ["a:t1", "b:t2"],
      anchor: "a:t1",
      activeAccountId: "b",
    });

    await useAccountStore.getState().remove("a");

    const ui = useUiStore.getState();
    expect(ui.mailbox).toEqual({ accountId: null, labelId: "INBOX" });
    expect(ui.openThread).toBeNull();
    expect(ui.checked).toEqual(["b:t2"]);
    expect(ui.anchor).toBeNull();
    expect(ui.activeAccountId).toBe("b");

    useUiStore.setState({ openThread: "b:t2" });
    await useAccountStore.getState().remove("c");
    expect(useUiStore.getState().openThread).toBe("b:t2");
    expect(useUiStore.getState().checked).toEqual(["b:t2"]);
  });

  test("a failed removal leaves navigation alone", async () => {
    mockIPC(() => {
      throw { code: "keychain_unavailable", message: "No system keychain is available." };
    });
    browseAccountA();
    await expect(useAccountStore.getState().remove("a")).rejects.toBeDefined();
    expect(useUiStore.getState().mailbox.accountId).toBe("a");
    expect(useUiStore.getState().openThread).toBe("a:t1");
  });
});
