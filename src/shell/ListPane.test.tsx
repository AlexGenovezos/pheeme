import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { registry } from "../keyboard/registry";
import type { ThreadSummary } from "../lib/tauri";
import { ALL_INBOXES, categoryMailbox } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { ListPane } from "./ListPane";

const rows: ThreadSummary[] = Array.from({ length: 50 }, (_, i) => ({
  id: `t${i}`,
  accountId: "a1",
  subject: `Subject ${i}`,
  snippet: null,
  fromName: null,
  fromAddress: "sender@example.test",
  date: 1000 - i,
  unread: i < 31,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
}));

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetLabelStoreForTests();
  useAccountStore.setState({ accounts: [] });
  mockIPC(() => undefined, { shouldMockEvents: true });
});

afterEach(() => registry.clear());

test("the Updates header uses the whole mailbox count across paging and count refreshes", () => {
  useUiStore.setState({ mailbox: categoryMailbox("a1", "CATEGORY_UPDATES") });
  useLabelStore.setState({ categoryCounts: { a1: { CATEGORY_UPDATES: 50 } } });
  render(<ListPane />);
  act(() => useMailStore.setState({ threads: rows }));
  expect(screen.getByText("50 unread")).toBeInTheDocument();
  expect(screen.queryByText("31 unread")).not.toBeInTheDocument();

  act(() => useMailStore.setState({ threads: [...rows, { ...rows[0], id: "older" }] }));
  expect(screen.getByText("50 unread")).toBeInTheDocument();

  act(() => useLabelStore.setState({ categoryCounts: { a1: { CATEGORY_UPDATES: 49 } } }));
  expect(screen.getByText("49 unread")).toBeInTheDocument();

  act(() => useLabelStore.setState({ categoryCounts: { a1: {} } }));
  expect(screen.queryByText(/\d+ unread/)).not.toBeInTheDocument();
});

test("switching mailboxes selects their own unread totals", () => {
  useLabelStore.setState({
    allInboxUnread: 80,
    categoryCounts: { a1: { CATEGORY_PERSONAL: 30 }, a2: { CATEGORY_PERSONAL: 5 } },
    counts: { a1: { STARRED: { unread: 7, total: 20 }, Label_1: { unread: 4, total: 10 } } },
  });
  render(<ListPane />);
  expect(screen.getByText("80 unread")).toBeInTheDocument();

  for (const [mailbox, unread] of [
    [categoryMailbox("a1", "CATEGORY_PERSONAL"), 30],
    [categoryMailbox("a2", "CATEGORY_PERSONAL"), 5],
    [{ accountId: "a1", labelId: "STARRED" }, 7],
    [{ accountId: "a1", labelId: "Label_1" }, 4],
    [ALL_INBOXES, 80],
  ] as const) {
    act(() => useUiStore.getState().setMailbox(mailbox));
    expect(screen.getByText(`${unread} unread`)).toBeInTheDocument();
  }
});
