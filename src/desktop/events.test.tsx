import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useAccountStore } from "../store/accountStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useSettingsStore } from "../settings/settingsStore";
import { useModStore } from "../mods/store";
import { openNotificationTarget, useDesktopEvents } from "./events";
import type { ThreadTarget } from "./api";

beforeEach(() => {
  __resetUiStoreForTests();
  useAccountStore.setState({
    accounts: [{ id: "a", email: "a@example.com", displayName: null, synced: true, clientId: "c" }],
  });
});

test("opens the owning account and exact conversation, closing overlays and search", () => {
  useUiStore.getState().setSearch("unrelated");
  useSettingsStore.getState().openSettings("notifications");
  useModStore.getState().openPanel("example");
  expect(openNotificationTarget({ accountId: "a", threadId: "reply" })).toBe(true);
  expect(useUiStore.getState()).toMatchObject({
    mailbox: { accountId: "a", labelId: "ALL" },
    openThread: "a:reply",
    searchText: "",
  });
  expect(useSettingsStore.getState().open).toBe(false);
  expect(useModStore.getState().panel).toBeNull();
  expect(openNotificationTarget({ accountId: "removed", threadId: "t" })).toBe(false);
  expect(useUiStore.getState().openThread).toBe("a:reply");
});

test("queues an early startup click until accounts are ready; handles later clicks and cleans up", async () => {
  let pending: ThreadTarget | null = { accountId: "a", threadId: "early" };
  const take = vi.fn(() => {
    const target = pending;
    pending = null;
    return target;
  });
  mockIPC((command) => (command === "take_notification_target" ? take() : undefined), {
    shouldMockEvents: true,
  });
  const showMail = vi.fn();
  const { rerender, unmount } = renderHook(({ ready }) => useDesktopEvents(ready, showMail), {
    initialProps: { ready: false },
  });
  expect(take).not.toHaveBeenCalled();
  rerender({ ready: true });
  await waitFor(() => expect(useUiStore.getState().openThread).toBe("a:early"));
  pending = { accountId: "a", threadId: "later" };
  await emit("desktop:open-thread");
  await waitFor(() => expect(useUiStore.getState().openThread).toBe("a:later"));
  expect(showMail).toHaveBeenCalledTimes(2);
  unmount();
  pending = { accountId: "a", threadId: "after-unmount" };
  await emit("desktop:open-thread");
  expect(pending).not.toBeNull();
});
