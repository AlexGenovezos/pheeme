import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import { useGlobalShortcuts } from "../keyboard/useCommands";
import type { AccountInfo, GmailSearchPage, SearchPage, ThreadSummary } from "../lib/tauri";
import { ListPane } from "../shell/ListPane";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { stubLayout } from "../test/layout";

const accounts: AccountInfo[] = ["a", "b"].map((id) => ({
  id,
  email: `${id}@example.com`,
  displayName: id,
  clientId: "client",
  synced: true,
}));
const row = (id: string, accountId = "a"): ThreadSummary => ({
  id,
  accountId,
  subject: id,
  snippet: "A matching conversation",
  fromName: "Alex",
  fromAddress: "alex@example.com",
  date: 1,
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
  systemLabelIds: [],
});
const cached = (...threads: ThreadSummary[]): SearchPage => ({ threads, next: null, local: true });
const gmail = (...threads: ThreadSummary[]): GmailSearchPage => ({ threads, next: {}, failed: [] });
let recent: string[];
let calls: [string, Record<string, unknown>][];
let restore: () => void;
let remote: () => GmailSearchPage | Promise<GmailSearchPage>;

function Harness() {
  useGlobalShortcuts();
  return (
    <section className="shell__list">
      <ListPane />
    </section>
  );
}
const input = () => screen.getByRole("searchbox", { name: "Search mail" });
const list = () => screen.getByRole("listbox", { name: "Search results conversations" });
const type = (value: string) => fireEvent.change(input(), { target: { value } });

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  registry.clear();
  useAccountStore.setState({ accounts });
  recent = ["invoice", "from:alex@example.com"];
  calls = [];
  remote = () => gmail(row("Older Gmail match"));
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "list_threads") return { threads: [row("Previous mailbox")], next: null };
    if (cmd === "search_messages")
      return cached(row("Cached invoice", (a.accountIds as string[])[0]));
    if (cmd === "search_gmail") return remote();
    if (cmd === "recent_searches") return [...recent];
    if (cmd === "add_recent_search")
      recent = [String(a.query), ...recent.filter((q) => q !== a.query)].slice(0, 20);
    if (cmd === "remove_recent_search") recent = recent.filter((q) => q !== a.query);
  });
  restore = stubLayout();
});
afterEach(() => {
  __resetMailStoreForTests();
  registry.clear();
  restore();
});

test("typing shows cached rows without waiting for Gmail, then appends Gmail rows and counts results", async () => {
  let resolve!: (page: GmailSearchPage) => void;
  remote = () =>
    new Promise((done) => {
      resolve = done;
    });
  render(<Harness />);
  await screen.findByText("Previous mailbox");
  fireEvent.keyDown(window, { key: "/" });
  expect(input()).toHaveFocus();
  type("invoice");
  expect(await screen.findByText("Cached invoice")).toBeInTheDocument();
  expect(screen.getByText("1+ result")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Searching Gmail");
  const originalRow = within(list()).getByRole("option");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  await act(async () => resolve(gmail(row("Older Gmail match"))));
  expect(await screen.findByText("Older Gmail match")).toBeInTheDocument();
  expect(screen.getByText("2 results")).toBeInTheDocument();
  expect(within(list()).getAllByRole("option")[0]).toBe(originalRow);
});

test("editing a search keeps matching rows mounted until the new cached results arrive", async () => {
  render(<Harness />);
  type("inv");
  await screen.findByText("Cached invoice");
  const originalList = list();
  const originalRow = within(originalList).getByRole("option");
  let resolve!: (page: SearchPage) => void;
  mockIPC((cmd) => {
    if (cmd === "search_messages") return new Promise<SearchPage>((done) => (resolve = done));
    if (cmd === "search_gmail") return gmail();
  });

  type("invoice");
  expect(list()).toBe(originalList);
  expect(within(list()).getByRole("option")).toBe(originalRow);
  await act(async () => resolve(cached(row("Cached invoice"), row("Another invoice"))));
  expect(await screen.findByText("Another invoice")).toBeInTheDocument();
  expect(within(list()).getAllByRole("option")[0]).toBe(originalRow);
});

test("search is account-wide; changing scope clears selection, and clear returns to the previous folder", async () => {
  useUiStore.getState().setMailbox({ accountId: "a", labelId: "SENT" });
  render(<Harness />);
  await screen.findByText("Previous mailbox");
  type("subject:invoice");
  await screen.findByText("Cached invoice");
  expect(calls).toContainEqual([
    "search_messages",
    { accountIds: ["a"], query: "subject:invoice", before: null, limit: null },
  ]);
  expect(screen.getByRole("combobox", { name: "Search accounts" })).toHaveValue("a");
  act(() => useUiStore.getState().checkAll(["a:Cached invoice"]));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  expect(useUiStore.getState().checked).toEqual([]);
  await vi.waitFor(() =>
    expect(calls).toContainEqual([
      "search_messages",
      { accountIds: ["a", "b"], query: "subject:invoice", before: null, limit: null },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(input()).toHaveValue("");
  expect(screen.getByRole("heading", { name: "Sent" })).toBeInTheDocument();
  expect(await screen.findByText("Previous mailbox")).toBeInTheDocument();
  expect(useUiStore.getState().mailbox).toEqual({ accountId: "a", labelId: "SENT" });
});

test("Escape clears search while keeping focus; a mailbox navigation also leaves search", async () => {
  render(<Harness />);
  type("invoice");
  await screen.findByText("Cached invoice");
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(input()).toHaveValue("");
  expect(input()).toHaveFocus();
  type("next search");
  await screen.findByText("Cached invoice");
  act(() => useUiStore.getState().setMailbox({ accountId: "b", labelId: "STARRED" }));
  expect(input()).toHaveValue("");
  expect(screen.getByRole("heading", { name: "Starred" })).toBeInTheDocument();
});

test("recent searches load on focus, can be selected and forgotten, and Enter records a full query", async () => {
  render(<Harness />);
  fireEvent.focus(input());
  const history = await screen.findByRole("region", { name: "Recent searches" });
  expect(within(history).getByRole("button", { name: "invoice" })).toBeInTheDocument();
  fireEvent.click(within(history).getByRole("button", { name: "Forget search: invoice" }));
  await vi.waitFor(() => expect(recent).toEqual(["from:alex@example.com"]));
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "invoice" })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "from:alex@example.com" }));
  expect(input()).toHaveValue("from:alex@example.com");
  type("subject:release has:attachment");
  await screen.findByText("Cached invoice");
  fireEvent.keyDown(input(), { key: "Enter" });
  await vi.waitFor(() => expect(recent[0]).toBe("subject:release has:attachment"));
  expect(list()).toHaveFocus();
});

test("offline Gmail search leaves cached rows usable and offers a retry", async () => {
  remote = () => {
    throw { code: "network", message: "No connection" };
  };
  render(<Harness />);
  type("invoice");
  expect(await screen.findByText("Cached invoice")).toBeInTheDocument();
  const retry = await screen.findByRole("button", { name: "Retry Gmail" });
  expect(screen.getByText("Cached invoice")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Gmail search incomplete");
  remote = () => gmail(row("Recovered match"));
  fireEvent.click(retry);
  expect(await screen.findByText("Recovered match")).toBeInTheDocument();
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry Gmail" })).not.toBeInTheDocument(),
  );
});

test("empty results are honest when Gmail is unavailable, including before first sync", async () => {
  useAccountStore.setState({ accounts: accounts.map((a) => ({ ...a, synced: false })) });
  mockIPC((cmd) => {
    if (cmd === "list_threads") return { threads: [], next: null };
    if (cmd === "search_messages") return cached();
    if (cmd === "search_gmail") throw { code: "network", message: "Offline" };
  });
  render(<Harness />);
  type("uncached query");
  expect(await screen.findByText("Looking for matching mail…")).toBeInTheDocument();
  expect(
    await screen.findByText("No cached matches. Retry Gmail to search the rest of your mail."),
  ).toBeInTheDocument();
  expect(screen.queryByText("No conversations match your search.")).not.toBeInTheDocument();
});

test("Escape from results clears selection first, then returns to the mailbox", async () => {
  render(<Harness />);
  type("invoice");
  await screen.findByText("Cached invoice");
  act(() => useUiStore.getState().checkAll(["a:Cached invoice"]));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useUiStore.getState().checked).toEqual([]);
  expect(input()).toHaveValue("invoice");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(input()).toHaveValue("");
  expect(await screen.findByText("Previous mailbox")).toBeInTheDocument();
});
