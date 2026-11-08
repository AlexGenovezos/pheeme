import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import type { MessageDetail, ThreadDetail, ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { stubLayout } from "../test/layout";
import { copyOpenConversationCode } from "./CodeCard";
import { threadKey } from "./mailboxes";
import { ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";
import { LIST_CODE_MAX_AGE } from "./verificationCode";

const KEY = threadKey("a1", "t1");
const NOW = Date.now();

const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "t1",
  accountId: "a1",
  subject: "Your temporary login code",
  snippet: "Enter this temporary verification code to continue: 779693",
  fromName: "Lumen",
  fromAddress: "noreply@lumen.example",
  date: NOW - 60_000,
  unread: true,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
  systemLabelIds: ["INBOX"],
  ...over,
});

const message = (over: Partial<MessageDetail> = {}): MessageDetail => ({
  id: "m1",
  threadId: "t1",
  fromName: "Lumen",
  fromAddress: "noreply@lumen.example",
  to: [{ name: null, address: "me@example.com" }],
  cc: [],
  subject: "Your temporary login code",
  snippet: "Enter this temporary verification code to continue: 779693",
  date: NOW - 60_000,
  bodyHtml: null,
  hasRemoteContent: false,
  declaresDarkMode: false,
  bodyAvailable: true,
  bodyText: "Enter this temporary verification code to continue: 779693",
  unread: false,
  starred: false,
  labelIds: ["INBOX"],
  hasAttachment: false,
  attachments: [],
  ...over,
});

const open = (messages: MessageDetail[]) => {
  const detail: ThreadDetail = { thread: summary(), messages, bodyError: null };
  useThreadStore.setState({ details: new Map([[KEY, detail]]) });
  useUiStore.setState({ openThread: KEY });
};

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
let restoreLayout: () => void;

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetThreadStoreForTests();
  __resetLabelStoreForTests();
  __resetMailStoreForTests();
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "me@example.com", displayName: null, clientId: "c", synced: true },
    ],
  });
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  mockIPC(() => undefined, { shouldMockEvents: true });
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  restoreLayout = stubLayout();
});
afterEach(() => restoreLayout());

const toasts = () => useToastStore.getState().toasts.map((t) => t.title);

test("a code email shows the code on a card above the conversation, and Copy code copies it", async () => {
  open([message()]);
  render(
    <ToastProvider>
      <ThreadView />
    </ToastProvider>,
  );

  const card = screen.getByRole("region", { name: "Verification code" });
  expect(card).toHaveTextContent("779693");
  fireEvent.click(screen.getByRole("button", { name: /Copy code/ }));
  expect(writeText).toHaveBeenCalledWith("779693");
  await waitFor(() => expect(toasts()).toContain("Copied 779693"));
});

test("an ordinary email shows no card", () => {
  open([
    message({ subject: "Lunch", snippet: "Order #123456 shipped", bodyText: "Order #123456" }),
  ]);
  render(<ThreadView />);
  expect(screen.queryByRole("region", { name: "Verification code" })).toBeNull();
});

test("the copy command copies the open conversation's code, or says there is none", async () => {
  open([message()]);
  act(() => copyOpenConversationCode());
  expect(writeText).toHaveBeenCalledWith("779693");

  open([message({ subject: "Lunch", snippet: "See you at noon", bodyText: "See you at noon" })]);
  act(() => copyOpenConversationCode());
  expect(writeText).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(toasts()).toContain("No verification code in this conversation"));
});

test("the list row offers a recent code; clicking it copies without opening the conversation", () => {
  useMailStore.setState({
    threads: [summary(), summary({ id: "t2", date: NOW - 2 * 60 * 60_000 })],
  });
  render(<ThreadList title="Inbox" onRowAction={vi.fn()} rowMenu={() => []} />);

  const chips = screen.getAllByRole("button", { name: "Copy verification code 779693" });
  expect(chips).toHaveLength(1);
  fireEvent.click(chips[0]);
  expect(writeText).toHaveBeenCalledWith("779693");
  expect(useUiStore.getState().openThread).toBeNull();
});

test("compact rows keep the code chip on the subject line", () => {
  useUiStore.setState({ listDensity: "compact" });
  useMailStore.setState({ threads: [summary()] });
  render(<ThreadList title="Inbox" onRowAction={vi.fn()} rowMenu={() => []} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy verification code 779693" }));
  expect(writeText).toHaveBeenCalledWith("779693");
});

test("the list chip goes away once the code is an hour old, without anything else re-rendering", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    useMailStore.setState({ threads: [summary({ date: Date.now() - LIST_CODE_MAX_AGE + 1000 })] });
    render(<ThreadList title="Inbox" onRowAction={vi.fn()} rowMenu={() => []} />);
    expect(screen.getByRole("button", { name: "Copy verification code 779693" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole("button", { name: "Copy verification code 779693" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
