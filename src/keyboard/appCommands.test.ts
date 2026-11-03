import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { threadKey } from "../mail/mailboxes";
import type { ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
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

test("a, and g then a, are different commands", () => {
  press("a");
  expect(useToastStore.getState().toasts[0].title).toBe("Compose arrives with Phase 7");
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

test("r and f stay a Phase 7 toast, and a lone u does not collide with shift+u", () => {
  press("r");
  press("f");
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
    "Compose arrives with Phase 7",
    "Compose arrives with Phase 7",
  ]);
  press("u");
  expect(modifies()).toEqual([]);
});
