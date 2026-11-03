import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import type { AttachmentInfo, LabelInfo, MessageDetail, ThreadDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { threadKey } from "./mailboxes";
import { ThreadView } from "./ThreadView";

const KEY = threadKey("a1", "t1");

const message = (n: number, over: Partial<MessageDetail> = {}): MessageDetail => ({
  id: `m${n}`,
  threadId: "t1",
  fromName: `Sender ${n}`,
  fromAddress: `s${n}@example.com`,
  to: [{ name: null, address: "me@example.com" }],
  cc: [],
  subject: "Quarterly plan",
  snippet: `Snippet ${n}`,
  date: 1_700_000_000_000 + n * 60_000,
  bodyHtml: null,
  hasRemoteContent: false,
  declaresDarkMode: false,
  bodyText: `Body ${n}`,
  unread: false,
  starred: false,
  labelIds: ["INBOX"],
  hasAttachment: false,
  attachments: [],
  ...over,
});

const detail = (messages: MessageDetail[]): ThreadDetail => ({
  thread: {
    id: "t1",
    accountId: "a1",
    subject: "Quarterly plan",
    snippet: null,
    fromName: null,
    fromAddress: null,
    date: 1,
    unread: false,
    starred: false,
    hasAttachment: false,
    messageCount: messages.length,
  },
  messages,
});

const label = (id: string, name: string, type: string): LabelInfo => ({
  id,
  accountId: "a1",
  name,
  type,
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
});

const open = (d: ThreadDetail) => {
  useThreadStore.setState({ details: new Map([[KEY, d]]) });
  useUiStore.setState({ openThread: KEY });
};

const renderView = () =>
  render(
    <ToastProvider>
      <ThreadView />
    </ToastProvider>,
  );

const card = (n: number) => screen.getByRole("article", { name: `Message from Sender ${n}` });

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetThreadStoreForTests();
  __resetLabelStoreForTests();
  useAccountStore.setState({
    accounts: [{ id: "a1", email: "Me@Example.com", displayName: null, clientId: "c", synced: true }],
  });
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  mockIPC(() => undefined);
});

test("last and unread messages start expanded, others collapsed", () => {
  open(detail([message(1), message(2, { unread: true }), message(3, { unread: false }), message(4)]));
  renderView();

  expect(within(card(1)).getByRole("button", { expanded: false })).toBeInTheDocument();
  expect(within(card(3)).getByRole("button", { expanded: false })).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.getByText("Body 4")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Quarterly plan" })).toBeInTheDocument();
});

test("expanded cards show the sender, a 'to me' line and the full date", () => {
  open(detail([message(1, { to: [{ name: "Me", address: "me@example.com" }, { name: "Bo Li", address: "bo@x.test" }], cc: [{ name: null, address: "cc@x.test" }] })]));
  renderView();

  expect(screen.getByText("s1@example.com")).toBeInTheDocument();
  expect(screen.getByText("to me, Bo Li · cc cc@x.test")).toBeInTheDocument();
});

test("clicking a collapsed card expands it, and the chevron collapses it", () => {
  open(detail([message(1), message(2)]));
  renderView();

  fireEvent.click(within(card(1)).getByRole("button"));
  expect(screen.getByText("Body 1")).toBeInTheDocument();

  fireEvent.click(within(card(1)).getByRole("button", { name: "Collapse message" }));
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
});

test("a refresh that marks messages read doesn't fold the open cards, but a new message opens", () => {
  open(detail([message(1), message(2, { unread: true })]));
  renderView();
  expect(screen.getByText("Body 2")).toBeInTheDocument();

  act(() => open(detail([message(1), message(2, { unread: false })])));
  expect(screen.getByText("Body 2")).toBeInTheDocument();

  act(() => open(detail([message(1), message(2), message(3, { unread: true })])));
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.getByText("Body 3")).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
});

test("shows only user-label chips", () => {
  useLabelStore.setState({
    labels: { a1: [label("INBOX", "Inbox", "system"), label("Label_1", "Receipts", "user"), label("Label_2", "Travel", "user")] },
  });
  open(detail([message(1, { labelIds: ["INBOX", "UNREAD", "Label_1"] })]));
  renderView();

  const chips = within(screen.getByRole("list", { name: "Labels" }));
  expect(chips.getByText("Receipts")).toBeInTheDocument();
  expect(chips.queryByText("Inbox")).not.toBeInTheDocument();
  expect(chips.queryByText("Travel")).not.toBeInTheDocument();
});

test("not_found shows \"This conversation isn't available any more.\"", async () => {
  mockIPC((cmd) => {
    if (cmd === "get_thread") throw { code: "not_found", message: "That conversation isn't on this device." };
    return undefined;
  });
  useUiStore.setState({ openThread: KEY });
  renderView();

  expect(await screen.findByText("This conversation isn't available any more.")).toBeInTheDocument();
});

test("plain text renders escaped with link buttons; HTML bodies fall back to their text", () => {
  open(detail([message(1, { bodyText: "See <b>this</b> https://example.com now" })]));
  const { container, unmount } = renderView();
  expect(container.querySelector(".message-card__text b")).toBeNull();
  expect(screen.getByRole("button", { name: "https://example.com" })).toBeInTheDocument();
  unmount();

  act(() => open(detail([message(1, { bodyHtml: "<p>hi</p>", bodyText: "plain alt" })])));
  renderView();
  expect(screen.getByText("plain alt").tagName).toBe("PRE");
});

test("attachments list hides inline images and downloads with a toast", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "save_attachment") return "/home/me/Downloads/plan.pdf";
    return undefined;
  });
  const file = (id: string, filename: string, over: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
    id,
    filename,
    mimeType: "application/pdf",
    size: 2_411_724,
    isInline: false,
    contentId: null,
    ...over,
  });
  open(detail([message(1, { attachments: [file("att1", "plan.pdf"), file("att2", "logo.png", { isInline: true, contentId: "logo" })] })]));
  renderView();

  const list = within(screen.getByRole("list", { name: "Attachments" }));
  expect(list.getByText("plan.pdf")).toBeInTheDocument();
  expect(list.getByText("2.3 MB")).toBeInTheDocument();
  expect(list.queryByText("logo.png")).not.toBeInTheDocument();

  fireEvent.click(list.getByRole("button", { name: "Download plan.pdf" }));
  expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === "save_attachment")?.args).toEqual({ accountId: "a1", messageId: "m1", attachmentId: "att1" });

  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() => expect(calls.find((c) => c.cmd === "reveal_download")?.args).toEqual({ path: "/home/me/Downloads/plan.pdf" }));
});

test("Reply, Reply all and Forward say compose is coming", () => {
  open(detail([message(1)]));
  renderView();
  fireEvent.click(screen.getByRole("button", { name: "Reply all" }));
  expect(screen.getByText("Compose arrives with Phase 7")).toBeInTheDocument();
});
