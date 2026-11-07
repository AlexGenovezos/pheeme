import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, type MailQuery, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { CATEGORIES } from "./mailboxes";
import { setTravelDirection, startPreloading } from "./preload";

const row = (id: string, accountId = "a") => ({ id, accountId, unread: true }) as ThreadSummary;
const rows = Array.from({ length: 50 }, (_, i) => row(String(i)));
const keys = (from: number, count: number, step = 1) =>
  Array.from({ length: count }, (_, i) => `a:${from + i * step}`);
const inbox = { accountIds: ["a"], labelId: "INBOX" };

let prefetch: ReturnType<typeof vi.fn>;
let stop: () => void;
beforeEach(() => {
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetUiStoreForTests();
  useAccountStore.setState({ accounts: [] });
  setTravelDirection(1);
  prefetch = vi.fn();
  useThreadStore.setState({ prefetch });
  mockIPC((cmd) => {
    throw new Error(`unexpected ${cmd}`);
  });
});
afterEach(() => stop());

const show = (query: MailQuery, threads = rows) =>
  useMailStore.setState({ query, loadedQuery: query, threads, loading: false });

test.each([
  inbox,
  { ...inbox, unreadOnly: true },
  { accountIds: ["a"], labelId: "ALL", search: "receipt" },
])("the first twenty rows of the list shown are preloaded (%o)", (query) => {
  stop = startPreloading();
  show(query);
  expect(prefetch).toHaveBeenLastCalledWith(keys(0, 20));
  stop();
  expect(prefetch).toHaveBeenLastCalledWith([]);
});

test("nothing from a list that is being replaced", () => {
  stop = startPreloading();
  useMailStore.setState({
    query: { ...inbox, unreadOnly: true },
    loadedQuery: inbox,
    threads: rows,
  });
  expect(prefetch).not.toHaveBeenCalledWith(expect.arrayContaining(["a:0"]));
  useMailStore.setState({ loadedQuery: { ...inbox, unreadOnly: true }, loading: true });
  expect(prefetch).not.toHaveBeenCalledWith(expect.arrayContaining(["a:0"]));
});

test("while navigating, sixteen rows ahead and four behind, leaning the way the reader goes", () => {
  stop = startPreloading();
  show(inbox);
  useUiStore.setState({ openThread: "a:25" });
  expect(prefetch).toHaveBeenLastCalledWith([...keys(26, 16), ...keys(24, 4, -1)]);
  setTravelDirection(-1);
  useUiStore.setState({ openThread: "a:24" });
  expect(prefetch).toHaveBeenLastCalledWith([...keys(23, 16, -1), ...keys(25, 4)]);
});

test("the first rows of Inbox and each category follow the list, each with its own Unread only", async () => {
  const asked: Array<Record<string, unknown>> = [];
  mockIPC((cmd, args) => {
    if (cmd !== "list_threads") throw new Error(`unexpected ${cmd}`);
    const query = args as Record<string, unknown>;
    asked.push(query);
    return { threads: [row(String(query.alsoLabelId ?? "inbox"))], next: null };
  });
  useAccountStore.setState({ accounts: [{ id: "a" }] as never });
  useUiStore.setState({
    unreadMailboxes: { [JSON.stringify(["a", "INBOX", "CATEGORY_UPDATES"])]: true },
  });
  stop = startPreloading();
  show(inbox, rows.slice(0, 2));
  await vi.waitFor(() =>
    expect(prefetch).toHaveBeenLastCalledWith([
      "a:0",
      "a:1",
      "a:inbox",
      ...CATEGORIES.map((c) => `a:${c.labelId}`),
    ]),
  );
  expect(asked).toHaveLength(1 + CATEGORIES.length);
  expect(asked.every((q) => q.limit === 20)).toBe(true);
  expect(asked.filter((q) => q.unreadOnly).map((q) => q.alsoLabelId)).toEqual(["CATEGORY_UPDATES"]);
});
