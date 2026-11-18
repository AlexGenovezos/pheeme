import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SyncProgress } from "../lib/tauri";
import {
  __resetDownloadForTests,
  DOWNLOAD_DONE_MS,
  DOWNLOAD_POLL_MS,
  summarizeDownload,
  useDownloadStore,
} from "./downloadStore";

const row = (
  accountId: string,
  syncedMessages: number,
  totalMessages: number | null,
  complete = false,
): SyncProgress => ({
  accountId,
  syncedMessages,
  totalMessages,
  downloadedMessages: syncedMessages,
  complete,
});

beforeEach(() => __resetDownloadForTests());
afterEach(() => {
  __resetDownloadForTests();
  vi.useRealTimers();
});

test("summarizes only the accounts still downloading", () => {
  expect(summarizeDownload([row("a", 10, 10, true)])).toBeNull();
  expect(summarizeDownload([row("a", 10, 10, true), row("b", 250, 1000)])).toEqual({
    accountIds: ["b"],
    synced: 250,
    total: 1000,
    percent: 25,
  });
  expect(summarizeDownload([row("a", 100, 1000), row("b", 300, 1000)])?.percent).toBe(20);
});

test("never says 100% before the last page, and has no percent until every size is known", () => {
  expect(summarizeDownload([row("a", 1000, 1000)])?.percent).toBe(99);
  expect(summarizeDownload([row("a", 1200, 1000)])?.percent).toBe(99);
  expect(summarizeDownload([row("a", 10, 1000), row("b", 5, null)])).toMatchObject({
    total: null,
    percent: null,
  });
});

/** A backend whose progress the test sets, counting how often it was asked. */
function backend(initial: SyncProgress[]) {
  const state = { progress: initial, asked: 0 };
  mockIPC(
    (cmd) => {
      if (cmd !== "get_sync_progress") return undefined;
      state.asked++;
      return state.progress;
    },
    { shouldMockEvents: true },
  );
  return state;
}

test("polls while downloading, stops when done, and says so for a few seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const server = backend([row("a", 500, 1000)]);
  const stop = await useDownloadStore.getState().subscribe();
  await vi.waitFor(() => expect(useDownloadStore.getState().progress).not.toBeNull());
  expect(server.asked).toBe(1);

  server.progress = [row("a", 800, 1000)];
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS);
  expect(useDownloadStore.getState().progress?.[0]?.syncedMessages).toBe(800);

  server.progress = [row("a", 1004, 1004, true)];
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS);
  expect(useDownloadStore.getState().finished).toEqual({ total: 1004 });
  const asked = server.asked;
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 5);
  expect(server.asked).toBe(asked);
  expect(useDownloadStore.getState().finished).toBeNull();
  expect(DOWNLOAD_POLL_MS * 5).toBeGreaterThan(DOWNLOAD_DONE_MS);
  stop();
});

test("asks again when a sync starts, which is how a new account's download begins", async () => {
  const server = backend([row("a", 10, 10, true)]);
  const stop = await useDownloadStore.getState().subscribe();
  await vi.waitFor(() => expect(useDownloadStore.getState().progress).not.toBeNull());
  expect(summarizeDownload(useDownloadStore.getState().progress!)).toBeNull();

  server.progress = [row("a", 10, 10, true), row("b", 0, null)];
  await emit("sync:started", { accountId: "b" });
  await vi.waitFor(() =>
    expect(summarizeDownload(useDownloadStore.getState().progress!)?.accountIds).toEqual(["b"]),
  );
  stop();
});

test("closing the card hides those downloads only; a closed card doesn't announce it finished", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const server = backend([row("a", 5, 10)]);
  const stop = await useDownloadStore.getState().subscribe();
  await vi.waitFor(() => expect(useDownloadStore.getState().progress).not.toBeNull());
  useDownloadStore.getState().dismiss();
  expect(useDownloadStore.getState().dismissed).toEqual(["a"]);

  server.progress = [row("a", 10, 10, true)];
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS);
  expect(useDownloadStore.getState().finished).toBeNull();
  stop();
});

test("an earlier subscription stopping late doesn't stop a later one (StrictMode)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const server = backend([row("a", 5, 10)]);
  const first = useDownloadStore.getState().subscribe();
  const second = await useDownloadStore.getState().subscribe();
  (await first)();
  await vi.waitFor(() => expect(useDownloadStore.getState().progress).not.toBeNull());
  const asked = server.asked;
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS);
  expect(server.asked).toBeGreaterThan(asked);
  second();
  const after = server.asked;
  await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 3);
  expect(server.asked).toBe(after);
});
