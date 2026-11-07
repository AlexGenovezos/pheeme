import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetComposeStoreForTests, useComposeStore } from "../compose/composeStore";
import { useToastStore } from "../components/ui/Toast";
import { threadKey } from "../mail/mailboxes";
import type { ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useLabelDialogStore } from "../labels/dialogStore";
import { usePickerStore } from "../labels/pickerStore";
import { appCommands } from "./appCommands";
import { createRegistry } from "./registry";

const thread = (n: number): ThreadSummary => ({
  id: `t${n}`,
  accountId: "a1",
  subject: null,
  snippet: null,
  fromName: null,
  fromAddress: null,
  date: n,
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
});

const last = <T>(items: T[]): T => items[items.length - 1];

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let reg: ReturnType<typeof createRegistry>;

const press = (key: string, init: KeyboardEventInit = {}) =>
  reg.handleKeyDown(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetComposeStoreForTests();
  useToastStore.setState({ toasts: [] });
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "a@example.com", displayName: null, clientId: "c", synced: true },
    ],
  });
  calls = [];
  mockIPC((cmd, args) => void calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> }));
  useMailStore.setState({ threads: [thread(1), thread(2)] });
  useUiStore.setState({ openThread: threadKey("a1", "t1") });
  reg = createRegistry({ isMac: false });
  appCommands().forEach((c) => reg.register(c));
});
afterEach(() => clearMocks());

const templates = () => calls.filter((c) => c.cmd === "compose_template").map((c) => c.args);

/** The open conversation (t1) is cached with one message, m1. */
function cacheOpenThread() {
  useThreadStore.setState({
    details: new Map([
      [
        threadKey("a1", "t1"),
        {
          thread: thread(1),
          messages: [
            {
              id: "m1",
              threadId: "t1",
              fromName: null,
              fromAddress: "x@example.com",
              to: [],
              cc: [],
              subject: null,
              snippet: null,
              date: 1,
              bodyHtml: null,
              hasRemoteContent: false,
              declaresDarkMode: false,
              bodyText: "hi",
              bodyAvailable: true,
              unread: false,
              starred: false,
              labelIds: ["INBOX"],
              hasAttachment: false,
              attachments: [],
            },
          ],
        },
      ],
    ]),
  });
}

const modifies = () => calls.filter((c) => c.cmd === "modify_threads").map((c) => c.args);

test("plain s stars the open conversation, while g then s still goes to Starred", () => {
  expect(press("s")).toBe(true);
  expect(modifies()).toEqual([
    { accountId: "a1", threadIds: ["t1"], add: ["STARRED"], remove: [] },
  ]);
  expect(reg.pendingChord()).toBeNull();

  expect(press("g")).toBe(true);
  expect(reg.pendingChord()).toBe("g");
  expect(press("s")).toBe(true);
  expect(modifies()).toHaveLength(1); // the chord's s was not a star
  expect(useUiStore.getState().mailbox).toEqual({ accountId: "a1", labelId: "STARRED" });
  expect(reg.pendingChord()).toBeNull();
});

test("a, and g then a, are different commands", async () => {
  cacheOpenThread();
  press("a");
  await vi.waitFor(() =>
    expect(templates()).toEqual([{ accountId: "a1", messageId: "m1", mode: "replyAll" }]),
  );
  press("g");
  press("a");
  expect(useUiStore.getState().mailbox).toMatchObject({ labelId: "ALL" });
});

test("e archives, # deletes, shift+i and shift+u set the read state, u closes", () => {
  press("e");
  expect(last(modifies())).toMatchObject({ remove: ["INBOX"] });

  useUiStore.setState({ openThread: threadKey("a1", "t2") });
  press("#", { shiftKey: true });
  expect(last(calls)).toEqual({
    cmd: "trash_threads",
    args: { accountId: "a1", threadIds: ["t2"] },
  });

  useMailStore.setState({ threads: [thread(3)] });
  useUiStore.setState({ openThread: threadKey("a1", "t3") });
  press("U", { shiftKey: true });
  expect(last(modifies())).toMatchObject({ threadIds: ["t3"], add: ["UNREAD"], remove: [] });
  press("I", { shiftKey: true });
  expect(last(modifies())).toMatchObject({ threadIds: ["t3"], add: [], remove: ["UNREAD"] });

  press("u");
  expect(useUiStore.getState().openThread).toBeNull();
});

test("r and f reply and forward the open conversation, and a lone u does not collide with shift+u", async () => {
  cacheOpenThread();
  press("r");
  press("f");
  await vi.waitFor(() => expect(templates().map((a) => a.mode)).toEqual(["reply", "forward"]));
  expect(useComposeStore.getState().windows.map((w) => w.kind)).toEqual(["reply", "forward"]);
  press("u");
  expect(modifies()).toEqual([]);
});

test("c starts a new message from the account in view", () => {
  press("c");
  expect(useComposeStore.getState().windows).toMatchObject([{ kind: "new", accountId: "a1" }]);
});

test("v_opens_move_picker for the open conversation; l opens Label as…", async () => {
  press("v");
  expect(usePickerStore.getState().spec).toMatchObject({
    mode: "move",
    accountId: "a1",
    keys: [threadKey("a1", "t1")],
  });
  usePickerStore.getState().close();
  press("l");
  await vi.waitFor(() => expect(usePickerStore.getState().spec?.mode).toBe("label"));
  usePickerStore.getState().close();
});

test("Create label… opens the new-label dialog for the account in view", () => {
  const create = reg.list().find((c) => c.id === "labels.create");
  expect(create?.title).toBe("Create label…");
  create?.run();
  expect(useLabelDialogStore.getState().dialog).toMatchObject({
    kind: "label",
    spec: { mode: "create", accountId: "a1" },
  });
  useLabelDialogStore.getState().close();
});
