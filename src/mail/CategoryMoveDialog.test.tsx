import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { CategoryMoveHost, openCategoryMove, useCategoryMoveStore } from "./CategoryMoveDialog";
import { threadKey } from "./mailboxes";

const thread = (n: number): ThreadSummary => ({
  id: `t${n}`,
  accountId: "a1",
  subject: `Subject ${n}`,
  snippet: null,
  fromName: null,
  fromAddress: null,
  date: 1_700_000_000_000 - n,
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labelIds: [],
  systemLabelIds: ["CATEGORY_PERSONAL", "INBOX"],
});
const key = (n: number) => threadKey("a1", `t${n}`);

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let senders: string[];
let rulesError: { code: string; message: string } | null;
const called = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  useToastStore.setState({ toasts: [] });
  useAccountStore.setState({
    accounts: [{ id: "a1", email: "me@example.com" } as never],
  });
  useUiStore.setState({
    mailbox: { accountId: "a1", labelId: "INBOX", category: "CATEGORY_PERSONAL" },
  });
  useMailStore.setState({ reload: vi.fn(async () => {}), threads: [thread(1), thread(2)] });
  calls = [];
  senders = ["news@x.com"];
  rulesError = null;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "rule_senders") return senders;
    if (cmd === "list_sender_rules") {
      if (rulesError) throw rulesError;
      return [];
    }
    if (cmd === "save_sender_rules") return { created: ["filter_1"], replaced: [] };
    if (cmd === "inbox_threads_from")
      return [{ threadId: "t7", categories: ["CATEGORY_PERSONAL"] }];
    return undefined;
  });
});
afterEach(() => {
  act(() => useCategoryMoveStore.getState().close());
  clearMocks();
});

const open = async (keys = [key(1)]) => {
  render(<CategoryMoveHost />);
  act(() =>
    openCategoryMove({ accountId: "a1", keys, category: "CATEGORY_UPDATES", at: { x: 0, y: 0 } }),
  );
  await flush();
  await flush();
};
const future = () => screen.getByRole("radio", { name: /future mail/ });

describe("the category move popup", () => {
  test("Just this moves only the conversations, without any rule call", async () => {
    await open();
    expect(screen.getByRole("dialog", { name: "Move to Updates" })).toBeInTheDocument();
    expect(future()).toBeEnabled();
    expect(future().closest("label")).toHaveTextContent("news@x.com");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(called("modify_threads")).toEqual([
      expect.objectContaining({ threadIds: ["t1"], add: ["CATEGORY_UPDATES", "INBOX"] }),
    ]);
    expect(called("save_sender_rules")).toEqual([]);
  });

  test("future mail saves the rule and moves the sender's other inbox mail too", async () => {
    await open();
    fireEvent.click(future());
    expect(screen.getByRole("checkbox", { name: /other mail in the inbox/ })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    await flush();
    await flush();
    expect(called("save_sender_rules")).toEqual([
      { accountId: "a1", senders: ["news@x.com"], category: "CATEGORY_UPDATES" },
    ]);
    expect(called("modify_threads")).toEqual([
      expect.objectContaining({ threadIds: ["t1", "t7"] }),
    ]);
  });

  test("unticking other mail moves only the chosen conversations", async () => {
    await open();
    fireEvent.click(future());
    fireEvent.click(screen.getByRole("checkbox", { name: /other mail in the inbox/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await flush();
    await flush();
    expect(called("inbox_threads_from")).toEqual([]);
    expect(called("modify_threads")).toEqual([expect.objectContaining({ threadIds: ["t1"] })]);
  });

  test("an account without filters access gets Sign in again instead of the rule choice", async () => {
    rulesError = { code: "missing_scope", message: "Insufficient Permission" };
    await open();
    expect(future()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await flush();
    expect(called("modify_threads")).toHaveLength(1);
  });

  test("any other failure to list rules still offers the choice", async () => {
    rulesError = { code: "network", message: "offline" };
    await open();
    expect(future()).toBeEnabled();
  });

  test("conversations of only your own mail can't make a rule", async () => {
    senders = [];
    await open([key(1), key(2)]);
    expect(future()).toBeDisabled();
    expect(screen.getByText(/only have mail you sent/)).toBeInTheDocument();
    expect(called("list_sender_rules")).toEqual([]);
  });

  test("Escape closes without moving", async () => {
    await open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(called("modify_threads")).toEqual([]);
  });
});
