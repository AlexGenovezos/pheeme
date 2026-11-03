import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { ThreadPage, ThreadSummary } from "../lib/tauri";
import { threadKey } from "../mail/mailboxes";
import { __resetMailStoreForTests, newOp, useMailStore } from "./mailStore";

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
const page = (...ids: string[]): ThreadPage => ({
  threads: ids.map((id) => summary(id)),
  next: null,
});
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
  mockIPC((cmd) => (cmd === "list_threads" ? page(`t${++version}`) : undefined), {
    shouldMockEvents: true,
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  expect(ids()).toEqual(["t1"]);
  const stop = await useMailStore.getState().subscribe();
  await emit("sync:messages_updated", { accountId: "a", added: ["t2"], removed: [], modified: [] });
  await vi.waitFor(() => expect(ids()).toEqual(["t2"]));
  stop();
});

/** `n` distinct threads, numbered from `from`, newest first. */
const rows = (from: number, n: number, accountId = "a") =>
  Array.from({ length: n }, (_, i) => ({
    ...summary(`t${from + i}`, accountId),
    date: 1000 - (from + i),
  }));
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
    if ((args as { before?: unknown }).before)
      return new Promise<ThreadPage>((resolve) => (release = resolve));
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

test("a failed first page for a new mailbox shows its error, not the old mailbox's rows, and paging stays off", async () => {
  const calls: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    const a = args as Record<string, unknown>;
    calls.push(a);
    if (a.labelId === "SENT") throw { code: "internal", message: "Sent is unavailable" };
    return { threads: rows(0, 50), next: cursorAfter("t49") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "SENT" });
  expect(useMailStore.getState().error).toEqual({
    code: "internal",
    message: "Sent is unavailable",
  });
  expect(useMailStore.getState().query?.labelId).toBe("SENT");
  expect(useMailStore.getState().threads).toEqual([]);
  expect(useMailStore.getState().next).toBeNull();

  const before = calls.length;
  await useMailStore.getState().loadMore();
  expect(calls).toHaveLength(before);
  expect(useMailStore.getState().threads).toEqual([]);
  expect(useMailStore.getState().error?.message).toBe("Sent is unavailable");
});

test("switching mailboxes keeps the old rows until the new first page arrives", async () => {
  let release: (p: ThreadPage) => void = () => {};
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    if ((args as { labelId: string }).labelId === "SENT")
      return new Promise<ThreadPage>((resolve) => (release = resolve));
    return { threads: rows(0, 2), next: cursorAfter("t1") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  const switching = useMailStore.getState().load({ accountIds: ["a"], labelId: "SENT" });
  expect(ids()).toEqual(["t0", "t1"]);
  // Paging is off while the switch is in flight.
  await useMailStore.getState().loadMore();
  release({ threads: rows(10, 1), next: null });
  await switching;
  expect(ids()).toEqual(["t10"]);
});

test("a failed reload of the same mailbox keeps its rows and cursor", async () => {
  let fail = false;
  mockIPC((cmd) => {
    if (cmd !== "list_threads") return undefined;
    if (fail) throw { code: "internal", message: "Database busy" };
    return { threads: rows(0, 2), next: cursorAfter("t1") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  fail = true;
  await useMailStore.getState().reload();
  expect(useMailStore.getState().error?.code).toBe("internal");
  expect(ids()).toEqual(["t0", "t1"]);
  expect(useMailStore.getState().next).toEqual(cursorAfter("t1"));
});

test("patch rewrites only the rows named by key", async () => {
  mockIPC((cmd) =>
    cmd === "list_threads"
      ? { threads: [summary("t1", "a"), summary("t1", "b"), summary("t2", "a")], next: null }
      : undefined,
  );
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  useMailStore.getState().patch(["b:t1", "a:t2"], (t) => ({ ...t, unread: true }));
  expect(useMailStore.getState().threads.map((t) => [key(t), t.unread])).toEqual([
    ["a:t1", false],
    ["b:t1", true],
    ["a:t2", true],
  ]);
});

test("remove drops rows by key across accounts", async () => {
  mockIPC((cmd) =>
    cmd === "list_threads"
      ? { threads: [summary("t1", "a"), summary("t1", "b"), summary("t2", "b")], next: null }
      : undefined,
  );
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  useMailStore.getState().remove(["b:t1", "a:t9"]);
  expect(useMailStore.getState().threads.map(key)).toEqual(["a:t1", "b:t2"]);
});

test("pending changes survive loads, reloads and pages until settled", async () => {
  const old = (): ThreadPage => ({
    threads: [summary("t1"), summary("t2"), summary("t3", "b")],
    next: null,
  });
  mockIPC((cmd) => (cmd === "list_threads" ? old() : undefined));
  const store = useMailStore.getState();
  await store.load({ accountIds: ["a", "b"], labelId: "INBOX" });

  const archive = newOp();
  const star = newOp();
  useMailStore.getState().remove(["a:t1", "b:t3"], archive);
  useMailStore.getState().patch(["a:t2"], (t) => ({ ...t, starred: true }), star);
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([["a:t2", true]]);

  // The server hasn't heard yet, so these answers still say the old thing.
  await useMailStore.getState().reload();
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([["a:t2", true]]);
  await useMailStore.getState().load({ accountIds: ["a", "b"], labelId: "INBOX" });
  expect(useMailStore.getState().threads.map(key)).toEqual(["a:t2"]);

  // One command settling releases only its own changes.
  useMailStore.getState().settle(archive);
  await useMailStore.getState().reload();
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([
    ["a:t1", false],
    ["a:t2", true],
    ["b:t3", false],
  ]);
  useMailStore.getState().settle(star);
  await useMailStore.getState().reload();
  expect(useMailStore.getState().threads.every((t) => !t.starred)).toBe(true);
});

test("pending changes also cover rows that arrive on a later page, and apply in the order made", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") return undefined;
    return (args as { before?: unknown }).before
      ? page("t2")
      : { threads: [summary("t1")], next: cursorAfter("t1") };
  });
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  useMailStore.getState().patch(["a:t2"], (t) => ({ ...t, starred: true }), newOp());
  useMailStore.getState().patch(["a:t2"], (t) => ({ ...t, starred: false }), newOp());
  useMailStore.getState().remove(["a:t1"], newOp());
  await useMailStore.getState().loadMore();
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([
    ["a:t2", false],
  ]);
});

test("a pending removal is held only for the query it was made in, and settling can be per row", async () => {
  mockIPC((cmd) => (cmd === "list_threads" ? page("t1", "t2") : undefined));
  const inbox = { accountIds: ["a"], labelId: "INBOX" };
  await useMailStore.getState().load(inbox);
  const archive = newOp();
  useMailStore.getState().remove(["a:t1"], archive);
  const flag = newOp();
  useMailStore.getState().patch(["a:t1", "a:t2"], (t) => ({ ...t, starred: true }), flag);

  // Another mailbox still lists it (flag changes follow it everywhere).
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "ALL" });
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([
    ["a:t1", true],
    ["a:t2", true],
  ]);
  await useMailStore.getState().load(inbox);
  expect(ids()).toEqual(["t2"]);

  // Settling one row leaves the other's change held.
  useMailStore.getState().settle(flag, ["a:t1"]);
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "ALL" });
  expect(useMailStore.getState().threads.map((t) => [key(t), t.starred])).toEqual([
    ["a:t1", false],
    ["a:t2", true],
  ]);
});

test("changes without an op are not held across reloads", async () => {
  mockIPC((cmd) => (cmd === "list_threads" ? page("t1") : undefined));
  await useMailStore.getState().load({ accountIds: ["a"], labelId: "INBOX" });
  useMailStore.getState().remove(["a:t1"]);
  await useMailStore.getState().reload();
  expect(ids()).toEqual(["t1"]);
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
