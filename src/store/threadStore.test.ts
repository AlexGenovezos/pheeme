import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { ThreadDetail } from "../lib/tauri";
import { __resetThreadStoreForTests, DETAIL_CACHE_SIZE, useThreadStore } from "./threadStore";
import { __resetUiStoreForTests, useUiStore } from "./uiStore";

const detail = (id: string, accountId = "a", subject = `Subject ${id}`): ThreadDetail => ({
  thread: {
    id,
    accountId,
    subject,
    snippet: null,
    fromName: null,
    fromAddress: null,
    date: 1,
    unread: false,
    starred: false,
    hasAttachment: false,
    messageCount: 1,
  },
  messages: [],
});

const store = () => useThreadStore.getState();
const cached = () => [...store().details.keys()];

/** get_thread answers from `threads`; anything absent is not_found. Records every request. */
function backend(threads: Record<string, ThreadDetail>) {
  const requests: string[] = [];
  mockIPC(
    (cmd, args) => {
      if (cmd !== "get_thread") return undefined;
      const { accountId, threadId } = args as { accountId: string; threadId: string };
      requests.push(`${accountId}:${threadId}`);
      const found = threads[`${accountId}:${threadId}`];
      if (!found) throw { code: "not_found", message: "That conversation isn't on this device." };
      return found;
    },
    { shouldMockEvents: true },
  );
  return requests;
}

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetThreadStoreForTests();
});

test("load fetches once, caches, and dedupes a request already in flight", async () => {
  const requests = backend({ "a:t1": detail("t1") });
  await Promise.all([store().load("a:t1"), store().load("a:t1")]);
  await store().load("a:t1");
  expect(requests).toEqual(["a:t1"]);
  expect(store().details.get("a:t1")?.thread.id).toBe("t1");
});

test("LRU keeps 30", async () => {
  const all = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`a:t${i}`, detail(`t${i}`)]));
  backend(all);
  expect(DETAIL_CACHE_SIZE).toBe(30);
  for (let i = 0; i < 30; i++) await store().load(`a:t${i}`);
  // Touching t0 makes it the most recent, so t1 is the oldest and goes first.
  await store().load("a:t0");
  await store().load("a:t30");
  expect(cached()).toHaveLength(30);
  expect(cached()).toContain("a:t0");
  expect(cached()).not.toContain("a:t1");
  for (let i = 31; i < 35; i++) await store().load(`a:t${i}`);
  expect(cached()).toHaveLength(30);
  expect(cached()).toContain("a:t34");
  expect(cached()).toContain("a:t0");
});

test("not_found keeps a per-key error and no detail", async () => {
  backend({ "a:t2": detail("t2") });
  await store().load("a:t1");
  expect(store().details.has("a:t1")).toBe(false);
  expect(store().errors["a:t1"]).toEqual({ code: "not_found", message: "That conversation isn't on this device." });
  // Other threads are unaffected, and a later successful load clears the error.
  await store().load("a:t2");
  expect(store().errors["a:t2"]).toBeUndefined();
});

test("a load that joins a prefetch in flight reports its failure", async () => {
  let fail: (e: unknown) => void = () => {};
  mockIPC((cmd) => (cmd === "get_thread" ? new Promise((_, reject) => (fail = reject)) : undefined));
  store().prefetch(["a:t1"]);
  const loading = store().load("a:t1");
  fail({ code: "not_found", message: "That conversation isn't on this device." });
  await loading;
  expect(store().details.has("a:t1")).toBe(false);
  expect(store().errors["a:t1"]?.code).toBe("not_found");
});

test("a prefetch nobody joined still fails quietly", async () => {
  let fail: (e: unknown) => void = () => {};
  mockIPC((cmd) => (cmd === "get_thread" ? new Promise((_, reject) => (fail = reject)) : undefined));
  store().prefetch(["a:t1"]);
  fail({ code: "not_found", message: "gone" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store().errors).toEqual({});
});

test("a successful load clears an earlier error", async () => {
  const threads: Record<string, ThreadDetail> = {};
  backend(threads);
  await store().load("a:t1");
  expect(store().errors["a:t1"]).toBeDefined();
  threads["a:t1"] = detail("t1");
  await store().load("a:t1");
  expect(store().errors["a:t1"]).toBeUndefined();
  expect(store().details.has("a:t1")).toBe(true);
});

test("prefetch loads the keys it doesn't have and stays quiet about failures", async () => {
  const requests = backend({ "a:t1": detail("t1"), "a:t2": detail("t2") });
  await store().load("a:t1");
  store().prefetch(["a:t1", "a:t2", "a:missing"]);
  await vi.waitFor(() => expect(requests).toEqual(["a:t1", "a:t2", "a:missing"]));
  await vi.waitFor(() => expect(cached()).toEqual(["a:t1", "a:t2"]));
  expect(store().errors).toEqual({});
});

test("evict drops the listed threads of one account and their errors", async () => {
  backend({ "a:t1": detail("t1"), "b:t1": detail("t1", "b"), "a:t2": detail("t2") });
  await Promise.all([store().load("a:t1"), store().load("b:t1"), store().load("a:t2"), store().load("a:gone")]);
  store().evict("a", ["t1", "gone"]);
  expect(cached().sort()).toEqual(["a:t2", "b:t1"]);
  expect(store().errors).toEqual({});
});

test("evicting a thread discards a response still in flight for it", async () => {
  let release: (d: ThreadDetail) => void = () => {};
  mockIPC((cmd) => (cmd === "get_thread" ? new Promise<ThreadDetail>((resolve) => (release = resolve)) : undefined));
  const pending = store().load("a:t1");
  store().evict("a", ["t1"]);
  release(detail("t1"));
  await pending;
  expect(cached()).toEqual([]);
});

test("evicts and reloads the open thread on messages_updated", async () => {
  const threads: Record<string, ThreadDetail> = {
    "a:t1": detail("t1", "a", "Before"),
    "a:t2": detail("t2"),
    "b:t1": detail("t1", "b"),
  };
  const requests = backend(threads);
  const stop = await store().subscribe();
  await Promise.all([store().load("a:t1"), store().load("a:t2"), store().load("b:t1")]);
  useUiStore.getState().setOpenThread("a:t1");
  requests.length = 0;

  threads["a:t1"] = detail("t1", "a", "After");
  await emit("sync:messages_updated", { accountId: "a", added: [], removed: [], modified: ["t1", "t2"] });
  await vi.waitFor(() => expect(store().details.get("a:t1")?.thread.subject).toBe("After"));
  // Only the open thread is re-requested; the other evicted thread waits until someone opens it.
  expect(requests).toEqual(["a:t1"]);
  expect(cached().sort()).toEqual(["a:t1", "b:t1"]);
  stop();
});

test("a thread removed by sync while open ends in not_found with no detail", async () => {
  const threads: Record<string, ThreadDetail> = { "a:t1": detail("t1") };
  backend(threads);
  const stop = await store().subscribe();
  await store().load("a:t1");
  useUiStore.getState().setOpenThread("a:t1");

  delete threads["a:t1"];
  await emit("sync:messages_updated", { accountId: "a", added: [], removed: ["t1"], modified: [] });
  await vi.waitFor(() => expect(store().errors["a:t1"]?.code).toBe("not_found"));
  expect(store().details.has("a:t1")).toBe(false);
  stop();
});

test("a transient failure refreshing the open thread keeps its cached detail", async () => {
  const threads: Record<string, ThreadDetail> = { "a:t1": detail("t1", "a", "Cached") };
  let fail = false;
  mockIPC(
    (cmd, args) => {
      if (cmd !== "get_thread") return undefined;
      if (fail) throw { code: "internal", message: "Database busy" };
      const { accountId, threadId } = args as { accountId: string; threadId: string };
      return threads[`${accountId}:${threadId}`];
    },
    { shouldMockEvents: true },
  );
  const stop = await store().subscribe();
  await store().load("a:t1");
  useUiStore.getState().setOpenThread("a:t1");
  fail = true;
  await emit("sync:messages_updated", { accountId: "a", added: [], removed: [], modified: ["t1"] });
  await vi.waitFor(() => expect(store().errors["a:t1"]?.code).toBe("internal"));
  expect(store().details.get("a:t1")?.thread.subject).toBe("Cached");
  stop();
});

test("threads added by sync, or in another account, are left alone", async () => {
  const requests = backend({ "a:t1": detail("t1") });
  const stop = await store().subscribe();
  await store().load("a:t1");
  useUiStore.getState().setOpenThread("a:t1");
  requests.length = 0;
  await emit("sync:messages_updated", { accountId: "a", added: ["t1"], removed: [], modified: [] });
  await emit("sync:messages_updated", { accountId: "b", added: [], removed: ["t1"], modified: ["t1"] });
  // Let the handlers run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(requests).toEqual([]);
  expect(cached()).toEqual(["a:t1"]);
  stop();
});

test("patchDetail rewrites a cached detail in place and ignores one that isn't cached", async () => {
  backend({ "a:t1": detail("t1"), "a:t2": detail("t2") });
  await store().load("a:t1");
  await store().load("a:t2");
  store().patchDetail("a:t1", (d) => ({ ...d, thread: { ...d.thread, subject: "Patched" } }));
  store().patchDetail("a:t9", (d) => d);
  expect(store().details.get("a:t1")?.thread.subject).toBe("Patched");
  expect(cached()).toEqual(["a:t1", "a:t2"]); // recency order is untouched
});

test("a pending detail patch is re-applied to every fetch until it settles", async () => {
  backend({ "a:t1": detail("t1") });
  const tag = (d: ThreadDetail): ThreadDetail => ({ ...d, thread: { ...d.thread, subject: "Optimistic" } });
  store().patchDetail("a:t1", tag, 7); // not cached yet: held for the first fetch
  await store().load("a:t1");
  expect(store().details.get("a:t1")?.thread.subject).toBe("Optimistic");
  store().evict("a", ["t1"]);
  await store().load("a:t1");
  expect(store().details.get("a:t1")?.thread.subject).toBe("Optimistic");

  store().settleDetails(7, ["a:t1"]);
  store().evict("a", ["t1"]);
  await store().load("a:t1");
  expect(store().details.get("a:t1")?.thread.subject).toBe("Subject t1");
});
