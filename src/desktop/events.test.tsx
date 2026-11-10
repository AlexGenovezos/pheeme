import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useAccountStore } from "../store/accountStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useSettingsStore } from "../settings/settingsStore";
import { useModStore } from "../mods/store";
import { displayZone, useCalendarStore } from "../calendar/calendarStore";
import { dateOf } from "../calendar/dates";
import { createCalendarHandlers } from "../preview/calendar";
import { openNotificationTarget, useDesktopEvents } from "./events";
import type { NotifyTarget } from "./api";

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
  useCalendarStore.setState({ mode: "calendar" });
  expect(openNotificationTarget({ kind: "thread", accountId: "a", threadId: "reply" })).toBe(true);
  expect(useCalendarStore.getState().mode).toBe("mail");
  expect(useUiStore.getState()).toMatchObject({
    mailbox: { accountId: "a", labelId: "ALL" },
    openThread: "a:reply",
    searchText: "",
  });
  expect(useSettingsStore.getState().open).toBe(false);
  expect(useModStore.getState().panel).toBeNull();
  expect(openNotificationTarget({ kind: "thread", accountId: "removed", threadId: "t" })).toBe(
    false,
  );
  expect(useUiStore.getState().openThread).toBe("a:reply");
});

test("queues an early startup click until accounts are ready; handles later clicks and cleans up", async () => {
  let pending: NotifyTarget | null = { kind: "thread", accountId: "a", threadId: "early" };
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
  pending = { kind: "thread", accountId: "a", threadId: "later" };
  await emit("desktop:open-thread");
  await waitFor(() => expect(useUiStore.getState().openThread).toBe("a:later"));
  expect(showMail).toHaveBeenCalledTimes(2);
  unmount();
  pending = { kind: "thread", accountId: "a", threadId: "after-unmount" };
  await emit("desktop:open-thread");
  expect(pending).not.toBeNull();
});

test("a reminder opens Calendar mode on the event's day with its popover open", async () => {
  // Wednesday 2026-11-11, noon; the preview's Design review is on Thursday the 12th.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 11, 12));
  const accounts = [
    { id: "acc-personal", email: "avery@example.com" },
    { id: "acc-work", email: "avery@example.org" },
  ];
  useAccountStore.setState({ accounts: accounts as never });
  useCalendarStore.setState({ mode: "mail", accounts: null, events: null, open: null });
  const handlers = createCalendarHandlers(accounts, null, Date.now()) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  let accountReads = 0;
  mockIPC((command, args) => {
    // Calendar's mount reads accounts too; that later read answers last.
    if (command === "calendar_accounts" && ++accountReads === 2)
      return new Promise((resolve) => setTimeout(() => resolve(handlers[command]()), 50));
    return handlers[command]?.((args ?? {}) as Record<string, unknown>);
  });
  try {
    expect(
      openNotificationTarget({
        kind: "event",
        accountId: "acc-work",
        calendarId: "avery@example.org",
        eventId: "design-review",
      }),
    ).toBe(true);
    expect(useCalendarStore.getState().mode).toBe("calendar");
    void useCalendarStore.getState().loadAccounts(); // as CalendarScreen does when it mounts
    await waitFor(() => expect(useCalendarStore.getState().open?.event.id).toBe("design-review"));
    const { open, anchor, accounts: loaded } = useCalendarStore.getState();
    expect(anchor).toBe(dateOf(open!.event.start.ms!, displayZone(loaded)));
    expect(anchor).toBe("2026-11-12");
    // Nothing moves it back to today once both reads are in.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(useCalendarStore.getState().anchor).toBe("2026-11-12");
  } finally {
    vi.useRealTimers();
  }
});
