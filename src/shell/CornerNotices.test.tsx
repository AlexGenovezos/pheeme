import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountInfo, SyncProgress } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetDownloadForTests, useDownloadStore } from "../store/downloadStore";
import { CornerNotices } from "./CornerNotices";

const account = (id: string, email: string): AccountInfo => ({
  id,
  email,
  displayName: null,
  clientId: "c.apps.googleusercontent.com",
  synced: true,
  color: 1,
});
const ONE = account("a1", "me@home.test");
const TWO = account("a2", "me@work.test");

const downloading = (accountId: string): SyncProgress => ({
  accountId,
  syncedMessages: 500,
  totalMessages: 9000,
  downloadedMessages: 500,
  complete: false,
});

beforeEach(() => {
  __resetDownloadForTests();
  useAccountStore.setState({
    accounts: [ONE, TWO],
    loaded: true,
    error: null,
    syncErrors: {},
    slowSync: {},
    offline: false,
  });
});
afterEach(() => __resetDownloadForTests());

const card = (title: string | HTMLElement) =>
  (typeof title === "string" ? screen.getByText(title) : title).closest(".ui-toast") as HTMLElement;

test("a failed sync names the account in the corner until that account syncs", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  render(<CornerNotices />);
  await act(() =>
    emit("sync:error", { accountId: "a2", code: "network", message: "Gmail didn't answer" }),
  );
  const failed = await screen.findByText("Couldn't sync me@work.test");
  expect(within(card("Couldn't sync me@work.test")).getByText("Gmail didn't answer")).toBeVisible();
  expect(failed.closest("[role=status]")).toBeInTheDocument();
  await act(() => emit("sync:completed", { accountId: "a2" }));
  await waitFor(() =>
    expect(screen.queryByText("Couldn't sync me@work.test")).not.toBeInTheDocument(),
  );
  stop();
});

test("a closed failure stays closed until a different one arrives", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  render(<CornerNotices />);
  await act(() => emit("sync:error", { accountId: "a1", code: "server", message: "Gmail broke" }));
  fireEvent.click(
    within(card("Couldn't sync me@home.test")).getByRole("button", { name: "Dismiss" }),
  );
  expect(screen.queryByText("Couldn't sync me@home.test")).not.toBeInTheDocument();
  await act(() => emit("sync:error", { accountId: "a1", code: "server", message: "Gmail broke" }));
  expect(screen.queryByText("Couldn't sync me@home.test")).not.toBeInTheDocument();
  await act(() =>
    emit("sync:error", { accountId: "a1", code: "server", message: "Gmail broke again" }),
  );
  expect(await screen.findByText("Gmail broke again")).toBeInTheDocument();
  stop();
});

test("a closed failure shows again if it comes back after the account synced", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  render(<CornerNotices />);
  await act(() => emit("sync:error", { accountId: "a1", code: "server", message: "Gmail broke" }));
  fireEvent.click(
    within(card("Couldn't sync me@home.test")).getByRole("button", { name: "Dismiss" }),
  );
  await act(() => emit("sync:completed", { accountId: "a1" }));
  await act(() => emit("sync:error", { accountId: "a1", code: "server", message: "Gmail broke" }));
  expect(await screen.findByText("Couldn't sync me@home.test")).toBeInTheDocument();
  stop();
});

test("sync cards and the download card step aside while a dialog is open", () => {
  useAccountStore.setState({ offline: true });
  useDownloadStore.setState({ progress: [downloading("a1")], episode: ["a1"] });
  render(<CornerNotices />);
  expect(card("You're offline")).toHaveClass("ui-toast--waits");
  expect(card("Downloading your mailbox")).toHaveClass("ui-toast--waits");
});

test("a signed-out account offers Sign in again and can't be closed", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  render(<CornerNotices />);
  await act(() =>
    emit("sync:error", { accountId: "a1", code: "signed_out", message: "Google signed out" }),
  );
  const signedOut = card(await screen.findByText("Google signed out me@home.test"));
  expect(within(signedOut).queryByRole("button", { name: "Dismiss" })).toBeNull();
  fireEvent.click(within(signedOut).getByRole("button", { name: "Sign in again" }));
  expect(useAccountStore.getState().reconnecting).toBe("a1");
  stop();
});

test("offline, one card replaces every account's network failure until Google answers", async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  const stop = await useAccountStore.getState().subscribe();
  render(<CornerNotices />);
  await act(() =>
    emit("sync:error", { accountId: "a2", code: "network", message: "Gmail didn't answer" }),
  );
  await screen.findByText("Couldn't sync me@work.test");

  await act(() => emit("network:status", { online: false }));
  expect(await screen.findByText("You're offline")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't sync me@work.test")).not.toBeInTheDocument();
  expect(within(card("You're offline")).queryByRole("button", { name: "Dismiss" })).toBeNull();

  await act(() => emit("network:status", { online: true }));
  await waitFor(() => expect(screen.queryByText("You're offline")).not.toBeInTheDocument());
  stop();
});

describe("slow sync card", () => {
  const title = "Gmail is slowing sync";
  const contended = "Another device may be syncing this account. Pheeme carries on by itself.";
  const usage = (refused: number, units: number) => ({
    limitPerMinute: 250,
    minutes: [0, 1].map((i) => ({
      startMs: i,
      units: { newMail: units, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
      refused: i === 1 ? refused : 0,
    })),
  });
  const withUsage = (value: unknown) =>
    mockIPC((cmd) => (cmd === "gmail_quota_usage" ? value : undefined), {
      shouldMockEvents: true,
    });

  test("one card for several slow accounts, plain when this Pheeme could have hit the limit", async () => {
    withUsage(usage(2, 200));
    const stop = await useAccountStore.getState().subscribe();
    render(<CornerNotices />);
    await act(() => emit("sync:rate_limited", { accountId: "a1", retryInMs: 500 }));
    await act(() => emit("sync:rate_limited", { accountId: "a2", retryInMs: null }));
    expect(await screen.findAllByText(title)).toHaveLength(1);
    expect(screen.queryByText(contended)).not.toBeInTheDocument();
    stop();
  });

  test("says another device when the numbers show this Pheeme was far under the limit", async () => {
    withUsage(usage(2, 10));
    const stop = await useAccountStore.getState().subscribe();
    render(<CornerNotices />);
    await act(() => emit("sync:rate_limited", { accountId: "a1", retryInMs: null }));
    expect(await screen.findByText(contended)).toBeInTheDocument();
    stop();
  });

  test("leaves a downloading account to the download card, and never blames another device", async () => {
    withUsage(usage(2, 10));
    useDownloadStore.setState({ progress: [downloading("a1")] });
    const stop = await useAccountStore.getState().subscribe();
    render(<CornerNotices />);
    await act(() => emit("sync:rate_limited", { accountId: "a1", retryInMs: null }));
    await waitFor(() => expect(useAccountStore.getState().slowSync.a1?.contended).toBe(true));
    expect(
      screen.getByText("Gmail is slowing the download. It carries on by itself."),
    ).toBeInTheDocument();
    expect(screen.queryByText(title)).not.toBeInTheDocument();

    // Closing the download card hands the slowdown back, still without blaming another device.
    fireEvent.click(
      within(card("Downloading your mailbox")).getByRole("button", { name: "Dismiss" }),
    );
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByText(contended)).not.toBeInTheDocument();
    stop();
  });

  test("goes away 3 minutes after the last refusal", async () => {
    withUsage(usage(2, 200));
    const stop = await useAccountStore.getState().subscribe();
    render(<CornerNotices />);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(() => emit("sync:rate_limited", { accountId: "a1", retryInMs: null }));
      expect(screen.getByText(title)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3 * 60_000 + 1));
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      stop();
    }
  });

  test("stays hidden while offline", async () => {
    withUsage(usage(2, 200));
    const stop = await useAccountStore.getState().subscribe();
    render(<CornerNotices />);
    await act(() => emit("network:status", { online: false }));
    await screen.findByText("You're offline");
    await act(() => emit("sync:rate_limited", { accountId: "a1", retryInMs: null }));
    await waitFor(() => expect(useAccountStore.getState().slowSync).toHaveProperty("a1"));
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    stop();
  });
});

test("nothing about sync shows before an account is connected", () => {
  useAccountStore.setState({ accounts: [], offline: true });
  useDownloadStore.setState({ progress: [downloading("a1")] });
  const { container } = render(<CornerNotices />);
  expect(container).toBeEmptyDOMElement();
});
