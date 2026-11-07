import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GmailSearchPage, SearchPage, ThreadSummary } from "../lib/tauri";
import { __resetMailStoreForTests, newOp, useMailStore } from "./mailStore";

const row = (id: string, accountId = "a", date = 1): ThreadSummary => ({
  id,
  accountId,
  date,
  subject: id,
  snippet: null,
  fromName: null,
  fromAddress: null,
  unread: true,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
});
const local = (...threads: ThreadSummary[]): SearchPage => ({ threads, next: null, local: true });
const remote = (...threads: ThreadSummary[]): GmailSearchPage => ({
  threads,
  next: {},
  failed: [],
});
const query = (search = "invoice", accountIds = ["a", "b"]) => ({
  search,
  accountIds,
  labelId: "ALL",
});
const store = () => useMailStore.getState();
const keys = () => store().threads.map((t) => `${t.accountId}:${t.id}`);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  __resetMailStoreForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  __resetMailStoreForTests();
  vi.useRealTimers();
});
const startGmail = () => vi.advanceTimersByTimeAsync(250);

test("cached hits render before Gmail; merging retains their positions and de-duplicates by account", async () => {
  const gmail = deferred<GmailSearchPage>();
  mockIPC((cmd) => (cmd === "search_messages" ? local(row("same"), row("local")) : gmail.promise));
  const loading = store().load(query());
  await startGmail();
  expect(keys()).toEqual(["a:same", "a:local"]);
  expect(store().loading).toBe(false);
  expect(store().search?.remoteLoading).toBe(true);
  gmail.resolve(remote(row("new", "a", 999), row("same"), row("same", "b"), row("new")));
  await loading;
  expect(keys()).toEqual(["a:same", "a:local", "a:new", "b:same"]);
});

test("a fast Gmail response still waits for the cached page before appending", async () => {
  const cached = deferred<SearchPage>();
  mockIPC((cmd) => (cmd === "search_messages" ? cached.promise : remote(row("gmail"))));
  const loading = store().load(query());
  await startGmail();
  expect(keys()).toEqual([]);
  cached.resolve(local(row("cached")));
  await loading;
  expect(keys()).toEqual(["a:cached", "a:gmail"]);
});

test("typing searches locally on each edit but only sends the final query to Gmail", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_gmail") {
      calls.push(args);
      return remote();
    }
    return local();
  });
  const a = store().load(query("inv"));
  const b = store().load(query("invoice from:alex@example.com"));
  await startGmail();
  await Promise.all([a, b]);
  expect(calls).toEqual([
    { accountIds: ["a", "b"], query: "invoice from:alex@example.com", pageTokens: null },
  ]);
});

test("editing keeps the last search page until its replacement arrives without paging the old cursor", async () => {
  const cached = deferred<SearchPage>();
  const cursor = { lastMessageDate: 1, accountId: "a", threadId: "old" };
  mockIPC((cmd, args) => {
    if (cmd === "search_gmail") return remote();
    return (args as { query: string }).query === "inv"
      ? { ...local(row("old")), next: cursor }
      : cached.promise;
  });
  const first = store().load(query("inv"));
  await startGmail();
  await first;

  const edited = store().load(query("invoice"));
  expect(keys()).toEqual(["a:old"]);
  expect(store().loadedQuery).toEqual(query("inv"));
  expect(store().next).toBeNull();
  await store().loadMore();
  cached.resolve(local(row("new")));
  await startGmail();
  await edited;
  expect(keys()).toEqual(["a:new"]);
  expect(store().loadedQuery).toEqual(query("invoice"));
});

test("a failed replacement search clears old matches before showing Gmail results", async () => {
  mockIPC((cmd, args) => {
    const old = (args as { query: string }).query === "inv";
    if (cmd === "search_gmail") return old ? remote() : remote(row("new"));
    if (old) return local(row("old"));
    throw { code: "internal", message: "Cache unavailable" };
  });
  const first = store().load(query("inv"));
  await startGmail();
  await first;
  const edited = store().load(query("invoice"));
  await startGmail();
  await edited;
  expect(keys()).toEqual(["a:new"]);
  expect(store().error?.message).toBe("Cache unavailable");
});

test("changing search accounts clears old matches while the new scope loads", async () => {
  const cached = deferred<SearchPage>();
  mockIPC((cmd, args) => {
    if (cmd === "search_gmail") return remote();
    return (args as { accountIds: string[] }).accountIds.includes("a")
      ? local(row("old"))
      : cached.promise;
  });
  const first = store().load(query());
  await startGmail();
  await first;
  const scoped = store().load(query("invoice", ["b"]));
  expect(keys()).toEqual([]);
  cached.resolve(local(row("new", "b")));
  await startGmail();
  await scoped;
  expect(keys()).toEqual(["b:new"]);
});

test("late responses cannot replace a newer query or a mailbox after leaving search", async () => {
  const cached = deferred<SearchPage>();
  const gmail = deferred<GmailSearchPage>();
  mockIPC((cmd, args) => {
    if (cmd === "list_threads") return { threads: [row("inbox")], next: null };
    if ((args as { query: string }).query === "slow")
      return cmd === "search_messages" ? cached.promise : gmail.promise;
    return cmd === "search_messages" ? local(row("fast")) : remote();
  });
  const slow = store().load(query("slow"));
  await startGmail();
  const fast = store().load(query("fast", ["b"]));
  await startGmail();
  await fast;
  expect(keys()).toEqual(["a:fast"]);
  await store().load({ labelId: "INBOX", accountIds: ["a"] });
  cached.resolve(local(row("stale-local")));
  gmail.resolve(remote(row("stale-gmail")));
  await slow;
  expect(keys()).toEqual(["a:inbox"]);
  expect(store().search).toBeNull();
});

test("paging uses independent local cursors and only Gmail accounts with remaining tokens", async () => {
  const cursor = { lastMessageDate: 1, accountId: "a", threadId: "first" };
  const calls: [string, unknown][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    const a = args as { before: unknown; pageTokens: unknown };
    if (cmd === "search_messages")
      return a.before ? local(row("second")) : { ...local(row("first")), next: cursor };
    return a.pageTokens
      ? remote(row("third", "b"))
      : { ...remote(row("first")), next: { b: "page-b" } };
  });
  const loading = store().load(query());
  await startGmail();
  await loading;
  await Promise.all([store().loadMore(), store().loadMore()]);
  expect(calls).toContainEqual([
    "search_messages",
    { accountIds: ["a", "b"], query: "invoice", before: cursor, limit: null },
  ]);
  expect(calls).toContainEqual([
    "search_gmail",
    { accountIds: ["b"], query: "invoice", pageTokens: { b: "page-b" } },
  ]);
  expect(calls.filter(([cmd]) => cmd === "search_gmail")).toHaveLength(2);
  expect(keys()).toEqual(["a:first", "a:second", "b:third"]);
});

test("partial Gmail failure retries only failed accounts without losing successful page tokens", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_messages") return local(row("cached"));
    calls.push(args);
    return calls.length === 1
      ? { ...remote(row("online")), next: { a: "next-a" }, failed: ["b"] }
      : remote(row("recovered", "b"));
  });
  const loading = store().load(query());
  await startGmail();
  await loading;
  expect(store().search?.failed).toEqual({ b: null });
  await store().retryGmail();
  expect(calls[1]).toEqual({ accountIds: ["b"], query: "invoice", pageTokens: null });
  expect(store().search?.remoteNext).toEqual({ a: "next-a" });
  expect(store().search?.remoteError).toBeNull();
  expect(keys()).toEqual(["a:cached", "a:online", "b:recovered"]);
});

test("a failed Gmail page is retried at the same token, without an automatic retry loop", async () => {
  let calls = 0;
  const argsSeen: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_messages") return local(row("cached"));
    argsSeen.push(args);
    if (++calls === 1) return { ...remote(), next: { a: "page-a" } };
    if (calls === 2) throw { code: "network", message: "Offline" };
    return remote(row("recovered"));
  });
  const loading = store().load(query());
  await startGmail();
  await loading;
  await store().loadMore();
  expect(keys()).toEqual(["a:cached"]);
  expect(store().search?.remoteNext).toEqual({});
  expect(store().search?.failed).toEqual({ a: "page-a" });
  await store().loadMore();
  expect(calls).toBe(2);
  await store().retryGmail();
  expect(argsSeen[2]).toEqual(argsSeen[1]);
  expect(keys()).toEqual(["a:cached", "a:recovered"]);
});

test("Gmail-only syntax works, and sync reload retains those hits without another network search", async () => {
  let gmailCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "search_messages") return { ...local(), local: false };
    gmailCalls++;
    return remote(row("gmail-only"));
  });
  const loading = store().load(query("invoice OR receipt"));
  await startGmail();
  await loading;
  await store().reload();
  expect(keys()).toEqual(["a:gmail-only"]);
  expect(store().search?.local).toBe(false);
  expect(gmailCalls).toBe(1);
});

test("a local failure doesn't prevent Gmail results from being shown or retained on reload", async () => {
  mockIPC((cmd) => {
    if (cmd === "search_messages") throw { code: "internal", message: "Cache unavailable" };
    return remote(row("gmail"));
  });
  const loading = store().load(query());
  await startGmail();
  await loading;
  expect(keys()).toEqual(["a:gmail"]);
  expect(store().error?.message).toBe("Cache unavailable");
  await store().reload();
  expect(keys()).toEqual(["a:gmail"]);
});

test("optimistic flags and removals survive late Gmail results and local reloads", async () => {
  const gmail = deferred<GmailSearchPage>();
  mockIPC((cmd) => (cmd === "search_messages" ? local(row("read"), row("trash")) : gmail.promise));
  const loading = store().load(query());
  await startGmail();
  const op = newOp();
  store().patch(["a:read"], (t) => ({ ...t, unread: false }), op);
  store().remove(["a:trash"], op);
  await store().reload();
  gmail.resolve(remote(row("read"), row("trash")));
  await loading;
  expect(keys()).toEqual(["a:read"]);
  expect(store().threads[0].unread).toBe(false);
});

test("cached results still update from sync after Gmail finishes", async () => {
  let unread = true;
  mockIPC(
    (cmd) =>
      cmd === "search_messages" ? local({ ...row("match"), unread }) : remote(row("match")),
    { shouldMockEvents: true },
  );
  const loading = store().load(query());
  await startGmail();
  await loading;
  const stop = await store().subscribe();
  unread = false;
  await emit("sync:messages_updated", {
    accountId: "a",
    added: [],
    removed: [],
    modified: ["match"],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(store().threads[0].unread).toBe(false);
  stop();
});

test("a removed Gmail-only result is evicted by sync and cannot survive a cache reload", async () => {
  mockIPC(
    (cmd) => (cmd === "search_messages" ? { ...local(), local: false } : remote(row("removed"))),
    { shouldMockEvents: true },
  );
  const loading = store().load(query("invoice OR receipt"));
  await startGmail();
  await loading;
  const stop = await store().subscribe();
  await emit("sync:messages_updated", {
    accountId: "a",
    added: [],
    removed: ["removed"],
    modified: [],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(keys()).toEqual([]);
  stop();
});

test("failed actions roll back Gmail-only results while successful actions survive reload", async () => {
  mockIPC((cmd) =>
    cmd === "search_messages" ? { ...local(), local: false } : remote(row("read"), row("trash")),
  );
  const loading = store().load(query("invoice OR receipt"));
  await startGmail();
  await loading;
  const read = newOp();
  const trash = newOp();
  store().patch(["a:read"], (t) => ({ ...t, unread: false }), read);
  store().remove(["a:trash"], trash);
  await store().reload();
  expect(keys()).toEqual(["a:read"]);
  expect(store().threads[0].unread).toBe(false);
  store().settle(read, ["a:read"], true);
  store().settle(trash, ["a:trash"], true);
  await store().reload();
  expect(keys()).toEqual(["a:read", "a:trash"]);
  expect(store().threads[0].unread).toBe(true);
  const success = newOp();
  store().patch(["a:read"], (t) => ({ ...t, unread: false }), success);
  store().remove(["a:trash"], success);
  store().settle(success);
  await store().reload();
  expect(keys()).toEqual(["a:read"]);
  expect(store().threads[0].unread).toBe(false);
});

test("a late Gmail page cannot resurrect a successfully trashed search hit", async () => {
  const gmail = deferred<GmailSearchPage>();
  mockIPC((cmd) => (cmd === "search_messages" ? local(row("trash")) : gmail.promise));
  const loading = store().load(query());
  await startGmail();
  const op = newOp();
  store().remove(["a:trash"], op);
  store().settle(op);
  gmail.resolve(remote(row("trash")));
  await loading;
  expect(keys()).toEqual([]);
});

test("sync rollback refreshes flags on Gmail-only matches from the cached thread", async () => {
  mockIPC(
    (cmd) => {
      if (cmd === "search_messages") return { ...local(), local: false };
      if (cmd === "get_thread") return { thread: row("match"), messages: [] };
      return remote(row("match"));
    },
    { shouldMockEvents: true },
  );
  const loading = store().load(query("invoice OR receipt"));
  await startGmail();
  await loading;
  const op = newOp();
  store().patch(["a:match"], (t) => ({ ...t, unread: false }), op);
  store().settle(op);
  const stop = await store().subscribe();
  await emit("sync:messages_updated", {
    accountId: "a",
    added: [],
    removed: [],
    modified: ["match"],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(store().threads[0].unread).toBe(true);
  stop();
});

test.each([false, true])(
  "Gmail rejecting accepted trash restores Gmail-only results (mixed labels: %s)",
  async (mixed) => {
    let trashed = false;
    mockIPC(
      (cmd) => {
        if (cmd === "search_messages") return { ...local(), local: false };
        if (cmd === "get_thread")
          return {
            thread: row("match"),
            messages: [
              { labelIds: trashed ? ["TRASH"] : ["INBOX"] },
              ...(mixed ? [{ labelIds: ["TRASH"] }] : []),
            ],
          };
        return remote(row("match"));
      },
      { shouldMockEvents: true },
    );
    const loading = store().load(query("invoice OR receipt"));
    await startGmail();
    await loading;
    const stop = await store().subscribe();
    const op = newOp();
    store().remove(["a:match"], op);
    trashed = true;
    // The IPC command has accepted the write into the outbox, not confirmed Gmail's acceptance.
    store().settle(op);
    const changed = () =>
      emit("sync:messages_updated", {
        accountId: "a",
        added: [],
        removed: [],
        modified: ["match"],
      });
    await changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(keys()).toEqual([]);
    // Later Gmail rejects the write and the outbox restores the cached labels.
    trashed = false;
    await changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(keys()).toEqual(["a:match"]);
    await store().reload();
    expect(keys()).toEqual(["a:match"]);
    stop();
  },
);
