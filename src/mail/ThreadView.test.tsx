import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { __resetComposeStoreForTests, useComposeStore } from "../compose/composeStore";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import type { AttachmentInfo, LabelInfo, MessageDetail, ThreadDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { openAndMarkRead } from "./actions";
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
  bodyAvailable: true,
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
    labelIds: [],
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
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
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
  __resetMailStoreForTests();
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "Me@Example.com", displayName: null, clientId: "c", synced: true },
    ],
  });
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  __resetComposeStoreForTests();
  mockIPC(() => undefined);
});

test("last and unread messages start expanded, others collapsed", () => {
  open(
    detail([message(1), message(2, { unread: true }), message(3, { unread: false }), message(4)]),
  );
  renderView();

  expect(within(card(1)).getByRole("button", { expanded: false })).toBeInTheDocument();
  expect(within(card(3)).getByRole("button", { expanded: false })).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.getByText("Body 4")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Quarterly plan" })).toBeInTheDocument();
});

test("expanded cards show the sender, a 'to me' line and the full date", () => {
  open(
    detail([
      message(1, {
        to: [
          { name: "Me", address: "me@example.com" },
          { name: "Bo Li", address: "bo@x.test" },
        ],
        cc: [{ name: null, address: "cc@x.test" }],
      }),
    ]),
  );
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

test("a collapsed HTML message only mounts its images when expanded", () => {
  open(
    detail([
      message(1, {
        bodyHtml: '<img src="https://example.com/photo.png">',
        hasRemoteContent: true,
      }),
      message(2),
    ]),
  );
  renderView();
  expect(screen.queryByTitle("Message body")).toBeNull();

  fireEvent.click(within(card(1)).getByRole("button"));
  expect(screen.getByTitle("Message body").getAttribute("srcdoc")).toContain(
    "img-src data: pheeme-att: http://pheeme-att.localhost https: http:",
  );
  expect(screen.queryByRole("button", { name: "Load images" })).toBeNull();
});

test("a refresh that marks messages read doesn't fold the open cards, but a new message opens", () => {
  // The unread message is not the last, so only its unread flag opens it.
  open(detail([message(1), message(2, { unread: true }), message(3)]));
  renderView();
  expect(screen.getByText("Body 2")).toBeInTheDocument();

  act(() => open(detail([message(1), message(2, { unread: false }), message(3)])));
  expect(screen.getByText("Body 2")).toBeInTheDocument();

  act(() => open(detail([message(1), message(2), message(3), message(4, { unread: true })])));
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.getByText("Body 3")).toBeInTheDocument();
  expect(screen.getByText("Body 4")).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
});

test("a sync event while the detail loads doesn't let mark-read overtake it", async () => {
  // The backend's body fetch emits messages_updated before get_thread returns, so the first request is superseded
  // by a refresh. The superseded answer is dropped; the refresh answers as the cache is when it answers, so a
  // mark-read sent in between would bring every message back read.
  let read = false;
  let requests = 0;
  let refreshAsked!: () => void;
  const refreshing = new Promise<void>((resolve) => (refreshAsked = resolve));
  let readSent!: () => void;
  const readArrived = new Promise<void>((resolve) => (readSent = resolve));
  mockIPC(
    async (cmd) => {
      if (cmd === "modify_threads") {
        read = true;
        readSent();
      }
      if (cmd !== "get_thread") return undefined;
      const n = ++requests;
      if (n === 1) {
        // Real IPC answers later; the mock would otherwise deliver the event inside the call itself.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await emit("sync:messages_updated", {
          accountId: "a1",
          added: [],
          removed: [],
          modified: ["t1"],
        });
        await refreshing;
      } else {
        refreshAsked();
        await Promise.race([readArrived, new Promise((resolve) => setTimeout(resolve, 50))]);
      }
      return detail([message(1), message(2, { unread: !read }), message(3)]);
    },
    { shouldMockEvents: true },
  );
  useMailStore.setState({ threads: [{ ...detail([]).thread, unread: true }] });
  const stop = await useThreadStore.getState().subscribe();
  renderView();

  act(() => openAndMarkRead(KEY));
  await waitFor(() => expect(read).toBe(true));
  expect(requests).toBe(2);
  // The cards were decided from the refresh's answer, given before the read was sent.
  await waitFor(() => expect(screen.getByText("Body 3")).toBeInTheDocument());
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
  stop();
});

test("opening an unread conversation keeps its unread messages expanded although opening marks them read", async () => {
  // The cache as the backend sees it: marking the thread read clears every message's unread flag at once.
  let read = false;
  const order: string[] = [];
  mockIPC(
    (cmd) => {
      order.push(cmd);
      if (cmd === "get_thread")
        return detail([message(1), message(2, { unread: !read }), message(3)]);
      if (cmd === "modify_threads") read = true;
      return undefined;
    },
    { shouldMockEvents: true },
  );
  useMailStore.setState({ threads: [{ ...detail([]).thread, unread: true }] });
  const stop = await useThreadStore.getState().subscribe();
  renderView();

  act(() => openAndMarkRead(KEY));
  // The list answers at once.
  expect(useMailStore.getState().threads[0].unread).toBe(false);
  expect(await screen.findByText("Body 2")).toBeInTheDocument();
  await waitFor(() => expect(read).toBe(true));
  expect(order.indexOf("get_thread")).toBeLessThan(order.indexOf("modify_threads"));

  // The change lands in the cache and the open thread refreshes with every message read.
  await act(() =>
    emit("sync:messages_updated", { accountId: "a1", added: [], removed: [], modified: ["t1"] }),
  );
  await waitFor(() =>
    expect(useThreadStore.getState().details.get(KEY)?.messages[1].unread).toBe(false),
  );
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(screen.getByText("Body 3")).toBeInTheDocument();
  expect(screen.queryByText("Body 1")).not.toBeInTheDocument();
  stop();
});

test("shows only user-label chips", () => {
  useLabelStore.setState({
    labels: {
      a1: [
        label("INBOX", "Inbox", "system"),
        label("Label_1", "Receipts", "user"),
        label("Label_2", "Travel", "user"),
      ],
    },
  });
  open(detail([message(1, { labelIds: ["INBOX", "UNREAD", "Label_1"] })]));
  renderView();

  const chips = within(screen.getByRole("list", { name: "Labels" }));
  expect(chips.getByText("Receipts")).toBeInTheDocument();
  expect(chips.getByText("Inbox")).toBeInTheDocument();
  expect(chips.queryByText("Unread")).not.toBeInTheDocument();
  expect(chips.queryByText("Travel")).not.toBeInTheDocument();
});

test("inbox chip archives", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return undefined;
  });
  useLabelStore.setState({ labels: { a1: [label("INBOX", "Inbox", "system")] } });
  open(detail([message(1, { labelIds: ["INBOX"] })]));
  useMailStore.setState({ threads: [detail([]).thread] });
  renderView();

  fireEvent.click(screen.getByRole("button", { name: "Remove label Inbox" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      cmd: "modify_threads",
      args: { accountId: "a1", threadIds: ["t1"], add: [], remove: ["INBOX"] },
    }),
  );
});

test("chips act on the open conversation even when its row isn't in the list", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return undefined;
  });
  useLabelStore.setState({
    labels: { a1: [label("INBOX", "Inbox", "system"), label("Label_1", "Receipts", "user")] },
  });
  // The open conversation is a mixed-thread one: only one message has Receipts.
  open(detail([message(1, { labelIds: ["INBOX", "Label_1"] }), message(2)]));
  useMailStore.setState({ threads: [] }); // e.g. the search changed after it was opened
  renderView();

  fireEvent.click(screen.getByRole("button", { name: "Remove label Inbox" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove label Receipts" }));
  await waitFor(() => {
    expect(calls).toContainEqual({
      cmd: "modify_threads",
      args: { accountId: "a1", threadIds: ["t1"], add: [], remove: ["INBOX"] },
    });
    expect(calls).toContainEqual({
      cmd: "modify_threads",
      args: { accountId: "a1", threadIds: ["t1"], add: [], remove: ["Label_1"] },
    });
  });
  expect(useUiStore.getState().openThread).toBe(KEY);
});

test('not_found shows "This conversation isn\'t available any more."', async () => {
  mockIPC((cmd) => {
    if (cmd === "get_thread")
      throw { code: "not_found", message: "That conversation isn't on this device." };
    return undefined;
  });
  useUiStore.setState({ openThread: KEY });
  renderView();

  expect(
    await screen.findByText("This conversation isn't available any more."),
  ).toBeInTheDocument();
});

test("plain text renders escaped with link buttons; HTML bodies render in the sandboxed frame", () => {
  open(detail([message(1, { bodyText: "See <b>this</b> https://example.com now" })]));
  const { container, unmount } = renderView();
  expect(container.querySelector(".message-card__text b")).toBeNull();
  expect(screen.getByRole("button", { name: "https://example.com" })).toBeInTheDocument();
  unmount();

  act(() => open(detail([message(1, { bodyHtml: "<p>hi</p>", bodyText: "plain alt" })])));
  renderView();
  expect(screen.queryByText("plain alt")).toBeNull();
  expect(screen.getByTitle("Message body").getAttribute("srcdoc")).toContain(
    "<body><p>hi</p></body>",
  );
});

test("attachments list hides inline images and downloads with a toast", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "save_attachment") return "/home/me/Downloads/plan.pdf";
    return undefined;
  });
  const file = (
    id: string,
    filename: string,
    over: Partial<AttachmentInfo> = {},
  ): AttachmentInfo => ({
    id,
    filename,
    mimeType: "application/pdf",
    size: 2_411_724,
    isInline: false,
    contentId: null,
    ...over,
  });
  open(
    detail([
      message(1, {
        attachments: [
          file("att1", "plan.pdf"),
          file("att2", "logo.png", { isInline: true, contentId: "logo" }),
        ],
      }),
    ]),
  );
  renderView();

  const list = within(screen.getByRole("list", { name: "Attachments" }));
  expect(list.getByText("plan.pdf")).toBeInTheDocument();
  expect(list.getByText("2.3 MB")).toBeInTheDocument();
  expect(list.queryByText("logo.png")).not.toBeInTheDocument();

  fireEvent.click(list.getByRole("button", { name: "Download plan.pdf" }));
  expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === "save_attachment")?.args).toEqual({
    accountId: "a1",
    messageId: "m1",
    attachmentId: "att1",
  });

  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() =>
    expect(calls.find((c) => c.cmd === "reveal_download")?.args).toEqual({
      path: "/home/me/Downloads/plan.pdf",
    }),
  );
});

test("Reply all answers the latest message that isn't a draft", async () => {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return cmd === "compose_template"
      ? {
          to: [],
          cc: [],
          bcc: [],
          subject: "Re: Quarterly plan",
          bodyHtml: "",
          attachments: [],
          references: [],
        }
      : undefined;
  });
  open(detail([message(1), message(2), message(3, { labelIds: ["DRAFT"] })]));
  renderView();
  fireEvent.click(screen.getByRole("button", { name: "Reply all" }));
  await waitFor(() =>
    expect(calls.filter((c) => c.cmd === "compose_template").map((c) => c.args)).toEqual([
      { accountId: "a1", messageId: "m2", mode: "replyAll" },
    ]),
  );
  await vi.waitFor(() =>
    expect(useComposeStore.getState().windows).toMatchObject([
      { kind: "replyAll", loading: false, draft: { subject: "Re: Quarterly plan" } },
    ]),
  );
});

test("a draft in the conversation says so and opens in compose", async () => {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return cmd === "open_draft"
      ? {
          to: [],
          cc: [],
          bcc: [],
          subject: "",
          bodyHtml: "<p>x</p>",
          attachments: [],
          references: [],
          draftId: "d1",
        }
      : undefined;
  });
  open(detail([message(1), message(2, { labelIds: ["DRAFT"] })]));
  renderView();
  const draft = screen.getByRole("article", { name: "Message from Draft" });
  fireEvent.click(within(draft).getByRole("button", { name: "Edit draft" }));
  await vi.waitFor(() =>
    expect(useComposeStore.getState().windows).toMatchObject([
      { kind: "draft", loading: false, draft: { draftId: "d1" } },
    ]),
  );
  expect(calls).toContain("open_draft");
});
