import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { MessageDetail, Unsubscribed } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { MessageCard } from "./MessageCard";
import { UnsubscribeDialogHost } from "./UnsubscribeDialog";
import {
  __resetUnsubscribedForTests,
  lacksUnsubscribe,
  unsubscribableMessage,
  unsubscribeOpenConversation,
} from "./unsubscribe";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";

const message = (over: Partial<MessageDetail> = {}): MessageDetail => ({
  id: "m1",
  threadId: "t1",
  fromName: "The Review",
  fromAddress: "hello@review.example",
  to: [],
  cc: [],
  subject: "Issue 31",
  snippet: "",
  date: 1,
  bodyHtml: null,
  hasRemoteContent: false,
  declaresDarkMode: false,
  bodyText: "Hello",
  bodyAvailable: true,
  unread: false,
  starred: false,
  labelIds: ["INBOX"],
  hasAttachment: false,
  attachments: [],
  unsubscribe: "one_click",
  ...over,
});

let calls: { cmd: string; args: unknown }[] = [];
let answer: Unsubscribed;

beforeEach(() => {
  __resetUnsubscribedForTests();
  useToastStore.setState({ toasts: [] });
  useAccountStore.setState({
    accounts: [{ id: "a1", email: "me@example.com" } as never],
  });
  calls = [];
  answer = {
    sender: "hello@review.example",
    method: "one_click",
    unsubscribed: true,
    web: null,
    mailto: null,
  };
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "unsubscribe_sender") return answer;
    return null;
  });
});

function renderCard(m: MessageDetail) {
  return render(
    <>
      <MessageCard message={m} accountId="a1" expanded onToggle={() => {}} />
      <UnsubscribeDialogHost />
    </>,
  );
}

test("a message without List-Unsubscribe has no Unsubscribe", () => {
  renderCard(message({ unsubscribe: "none" }));
  expect(screen.queryByRole("button", { name: /Unsubscribe from/ })).toBeNull();
});

test("Unsubscribe asks first, then unsubscribes and swaps its text in place", async () => {
  renderCard(message());
  const button = screen.getByRole("button", { name: "Unsubscribe from The Review" });
  fireEvent.click(button);
  expect(calls.some((c) => c.cmd === "unsubscribe_sender")).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("Unsubscribe from The Review?");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
  });
  expect(calls.find((c) => c.cmd === "unsubscribe_sender")!.args).toEqual({
    accountId: "a1",
    threadId: "t1",
    messageId: "m1",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  const done = screen.getByRole("button", { name: "Unsubscribed from The Review" });
  expect(done).toBeDisabled();
  expect(done).toHaveTextContent("Unsubscribed");
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
    "Unsubscribed from The Review",
  ]);
});

test("cancelling the question sends nothing", () => {
  renderCard(message());
  fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from The Review" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((c) => c.cmd === "unsubscribe_sender")).toBe(false);
  expect(screen.getByRole("button", { name: "Unsubscribe from The Review" })).toBeEnabled();
});

test("a failed unsubscribe says so and offers it again", async () => {
  mockIPC((cmd) => {
    if (cmd === "unsubscribe_sender") throw { code: "invalid", message: "The link answered 500" };
    return null;
  });
  renderCard(message());
  fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from The Review" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
  });
  expect(useToastStore.getState().toasts[0]).toMatchObject({
    title: "Couldn't unsubscribe from The Review",
    description: "The link answered 500",
  });
  expect(screen.getByRole("button", { name: "Unsubscribe from The Review" })).toBeEnabled();
});

test("the command picks the newest message that offers it, never your own or a draft", () => {
  const messages = [
    message({ id: "old" }),
    message({ id: "mine", fromAddress: "me@example.com" }),
    message({ id: "draft", labelIds: ["DRAFT"] }),
    message({ id: "plain", unsubscribe: "none" }),
  ];
  expect(unsubscribableMessage(messages, "me@example.com")?.id).toBe("old");
  expect(unsubscribableMessage([messages[3]!], "me@example.com")).toBeUndefined();
});

test("the command asks about the open conversation, or says it has nothing", async () => {
  const key = "a1:t1";
  useUiStore.setState({ openThread: key });
  useThreadStore.setState({
    details: new Map([
      [key, { thread: {} as never, messages: [message({ unsubscribe: "none" })], bodyError: null }],
    ]),
  });
  expect(lacksUnsubscribe(key)).toBe(true);
  await unsubscribeOpenConversation();
  expect(useToastStore.getState().toasts[0]?.title).toBe(
    "This conversation has no unsubscribe link",
  );

  useThreadStore.setState({
    details: new Map([[key, { thread: {} as never, messages: [message()], bodyError: null }]]),
  });
  expect(lacksUnsubscribe(key)).toBe(false);
  render(<UnsubscribeDialogHost />);
  await act(async () => {
    await unsubscribeOpenConversation();
  });
  expect(screen.getByRole("dialog")).toHaveTextContent("Unsubscribe from The Review?");
});
