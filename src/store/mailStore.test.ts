import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { ThreadPage, ThreadSummary } from "../lib/tauri";
import { threadKey } from "../mail/mailboxes";
import { __resetMailStoreForTests, useMailStore } from "./mailStore";

const summary = (id: string, accountId = "a"): ThreadSummary => ({
  id,
  accountId,
  subject: `Subject ${id}`,
  snippet: null,
  fromName: null,
  fromAddress: "x@example.com",
  date: 1,
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
});
const page = (...ids: string[]): ThreadPage => ({ threads: ids.map((id) => summary(id)), next: null });
const ids = () => useMailStore.getState().threads.map((t) => t.id);

beforeEach(() => __resetMailStoreForTests());

test("loads threads for the active mailbox across accounts", async () => {
  const calls: [string, unknown][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    return cmd === "list_threads" ? page("t1", "t2") : undefined;
  });
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  expect(calls).toEqual([["list_threads", { accountIds: ["a", "b"], labelId: "INBOX" }]]);
  expect(ids()).toEqual(["t1", "t2"]);
});

test("reloads on sync:messages_updated", async () => {
  let version = 0;
  mockIPC((cmd) => (cmd === "list_threads" ? page(`t${++version}`) : undefined), { shouldMockEvents: true });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  expect(ids()).toEqual(["t1"]);
  const stop = await useMailStore.getState().subscribe();
  await emit("sync:messages_updated", { accountId: "a", added: ["t2"], removed: [], modified: [] });
  await vi.waitFor(() => expect(ids()).toEqual(["t2"]));
  stop();
});

/** `n` distinct threads, numbered from `from`, newest first. */
const rows = (from: number, n: number, accountId = "a") =>
  Array.from({ length: n }, (_, i) => ({ ...summary(`t${from + i}`, accountId), date: 1000 - (from + i) }));
const cursorAfter = (id: string) => ({ lastMessageDate: 0, accountId: "a", threadId: id });
const key = (t: ThreadSummary) => threadKey(t.accountId, t.id);

test("reload keeps the loaded depth", async () => {
  const calls: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    const a = args as Record<string, unknown>;
    calls.push(a);
    if (a.before) return { threads: rows(50, 50), next: null };
    if (a.limit === 100) return { threads: rows(0, 100), next: cursorAfter("t99") };
    return { threads: rows(0, 50), next: cursorAfter("t49") };
  });
  const store = useMailStore.getState();
  await store.load({ accountIds: ["a"], labelId: "INBOX" });
  await useMailStore.getState().loadMore();
  expect(useMailStore.getState().threads).toHaveLength(100);
  await useMailStore.getState().reload();
  const last = calls[calls.length - 1];
  expect(last).toMatchObject({ accountIds: ["a"], labelId: "INBOX", limit: 100 });
  expect(last).not.toHaveProperty("before");
  expect(useMailStore.getState().threads).toHaveLength(100);
  expect(useMailStore.getState().next).toEqual(cursorAfter("t99"));
});

test("reload clamps the depth to 50..500", async () => {
  const limits: unknown[] = [];
  let size = 3;
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    limits.push((args as { limit?: number }).limit);
    return { threads: rows(0, size), next: null };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  await useMailStore.getState().reload();
  size = 800;
  await useMailStore.getState().reload();
  await useMailStore.getState().reload();
  expect(limits).toEqual([undefined, 50, 50, 500]);
});

test("loadMore appends and is idempotent while in flight", async () => {
  const calls: Record<string, unknown>[] = [];
  let release: (p: ThreadPage) => void = () => {};
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    const a = args as Record<string, unknown>;
    calls.push(a);
    if (!a.before) return { threads: rows(0, 50), next: cursorAfter("t49") };
    return new Promise<ThreadPage>((resolve) => (release = resolve));
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  const first = useMailStore.getState().loadMore();
  const second = useMailStore.getState().loadMore();
  expect(useMailStore.getState().loading).toBe(true);
  release({ threads: rows(50, 50), next: null });
  await Promise.all([first, second]);
  expect(calls.filter((c) => c.before)).toEqual([
    { accountIds: ["a"], labelId: "INBOX", before: cursorAfter("t49") },
  ]);
  expect(useMailStore.getState().threads.map((t) => t.id)).toEqual(rows(0, 100).map((t) => t.id));
  expect(useMailStore.getState().next).toBeNull();
  expect(useMailStore.getState().loading).toBe(false);
});

test("loadMore does nothing without a next cursor", async () => {
  let calls = 0;
  mockIPC((cmd) => {
    if (cmd === "list_threads") calls++;
    return page("t1");
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  await useMailStore.getState().loadMore();
  expect(calls).toBe(1);
});

test("loadMore skips rows it already has", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    return (args as { before?: unknown }).before
      ? { threads: rows(1, 3), next: null }
      : { threads: rows(0, 2), next: cursorAfter("t1") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  await useMailStore.getState().loadMore();
  expect(ids()).toEqual(["t0", "t1", "t2", "t3"]);
});

test("a reload during loadMore wins; the late page is dropped", async () => {
  let release: (p: ThreadPage) => void = () => {};
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    if ((args as { before?: unknown }).before) return new Promise<ThreadPage>((resolve) => (release = resolve));
    return { threads: rows(0, 2), next: cursorAfter("t1") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  const more = useMailStore.getState().loadMore();
  await useMailStore.getState().reload();
  release({ threads: rows(2, 5), next: null });
  await more;
  expect(ids()).toEqual(["t0", "t1"]);
  expect(useMailStore.getState().next).toEqual(cursorAfter("t1"));
});

test("patch rewrites only the rows named by key", async () => {
  mockIPC((cmd) => (cmd === "list_threads" ? { threads: [summary("t1", "a"), summary("t1", "b"), summary("t2", "a")], next: null } : undefined));
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  useMailStore.getState().patch(["b:t1", "a:t2"], (t) => ({ ...t, unread: true }));
  expect(useMailStore.getState().threads.map((t) => [key(t), t.unread])).toEqual([
    ["a:t1", false],
    ["b:t1", true],
    ["a:t2", true],
  ]);
});

test("remove drops rows by key across accounts", async () => {
  mockIPC((cmd) => (cmd === "list_threads" ? { threads: [summary("t1", "a"), summary("t1", "b"), summary("t2", "b")], next: null } : undefined));
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  useMailStore.getState().remove(["b:t1", "a:t9"]);
  expect(useMailStore.getState().threads.map(key)).toEqual(["a:t1", "b:t2"]);
});

test("ignores a stale response", async () => {
  const pending: Record<string, (p: ThreadPage) => void> = {};
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    const label = (args as { labelId: string }).labelId;
    return new Promise<ThreadPage>((resolve) => (pending[label] = resolve));
  });
  const slow = useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  const fast = useMailStore.getState().load({ accountIds: ["a"], labelId: "SENT" });
  await vi.waitFor(() => expect(Object.keys(pending)).toEqual(["INBOX", "SENT"]));
  pending.SENT(page("sent-1"));
  await fast;
  pending.INBOX(page("inbox-1"));
  await slow;
  expect(ids()).toEqual(["sent-1"]);
  expect(useMailStore.getState().query?.labelId).toBe("SENT");
});
