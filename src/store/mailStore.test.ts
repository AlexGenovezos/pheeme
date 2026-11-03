import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { ThreadPage, ThreadSummary } from "../lib/tauri";
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
