import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { showContextMenu } from "../lib/contextMenu";
import type { ThreadSummary } from "../lib/tauri";
import { threadKey } from "../mail/mailboxes";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useComposeSettings } from "../compose/composeSettings";
import { ViewPane } from "./ViewPane";

vi.mock("../lib/contextMenu", () => ({ showContextMenu: vi.fn(async () => {}) }));

const thread = (n: number, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
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
  systemLabelIds: [],
  ...over,
});
const key = (n: number) => threadKey("a1", `t${n}`);

let modified: Array<Record<string, unknown>>;

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  modified = [];
  mockIPC(
    (cmd, args) => {
      if (cmd === "modify_threads") modified.push(args as Record<string, unknown>);
      if (cmd === "list_threads") return { threads: useMailStore.getState().threads, next: null };
      if (cmd === "get_thread") throw { code: "not_found", message: "gone" };
      return undefined;
    },
    { shouldMockEvents: true },
  );
  useMailStore.setState({
    threads: [
      thread(1, { unread: true }),
      thread(2, { unread: true, starred: true }),
      thread(3, { starred: true }),
    ],
  });
});

const button = (name: string) => screen.getByRole("button", { name });

test("checked rows enable the mutations with nothing open; Reply and Forward stay tied to the open conversation", () => {
  render(<ViewPane />);
  expect(button("Archive")).toBeDisabled();

  act(() => {
    useUiStore.getState().toggleChecked(key(1));
    useUiStore.getState().toggleChecked(key(2));
  });

  for (const name of ["Archive", "Delete", "Mark as read", "Star", "More actions"])
    expect(button(name)).toBeEnabled();
  expect(button("Reply")).toBeDisabled();
  expect(button("Forward")).toBeDisabled();
});

test("the toggles follow the checked rows, not an unrelated open conversation", () => {
  act(() => {
    useUiStore.getState().setOpenThread(key(3)); // read and starred
    useUiStore.getState().toggleChecked(key(1));
    useUiStore.getState().toggleChecked(key(2));
  });
  render(<ViewPane />);

  // Something checked is unread; the first checked row isn't starred.
  expect(button("Mark as read")).toBeEnabled();
  expect(button("Star")).toBeEnabled();
  expect(button("Reply")).toBeEnabled();

  // The open envelope means "mark as read", as in Gmail and on the row's own button.
  expect(button("Mark as read").querySelector("svg")).toHaveClass("lucide-mail-open");

  fireEvent.click(button("Mark as read"));
  expect(modified).toEqual([
    { accountId: "a1", threadIds: ["t1", "t2"], add: [], remove: ["UNREAD"] },
  ]);
});

test("with every checked row starred and read, the toggles offer the opposite", () => {
  act(() => {
    useUiStore.getState().toggleChecked(key(3));
  });
  render(<ViewPane />);
  expect(button("Mark as unread")).toBeEnabled();
  expect(button("Remove star")).toBeEnabled();
  expect(button("Mark as unread").querySelector("svg")).toHaveClass("lucide-mail");
});

test("Star follows the first checked row, like the s shortcut", () => {
  act(() => {
    useUiStore.getState().toggleChecked(key(2)); // starred
    useUiStore.getState().toggleChecked(key(1)); // not starred
  });
  render(<ViewPane />);
  fireEvent.click(button("Remove star"));
  expect(modified).toEqual([
    { accountId: "a1", threadIds: ["t2", "t1"], add: [], remove: ["STARRED"] },
  ]);
});

test("checked rows that have all left the list leave the mutations off", () => {
  act(() => useUiStore.getState().toggleChecked(threadKey("a1", "gone")));
  render(<ViewPane />);
  expect(button("Archive")).toBeDisabled();
  expect(button("More actions")).toBeDisabled();
});

test("the default reply comes first and is the primary button", () => {
  act(() => useComposeSettings.getState().setDefaultReply("replyAll"));
  render(<ViewPane />);
  const names = screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
    .filter((n) => /^Reply/.test(n));
  expect(names[0]).toMatch(/^Reply all/);
  expect(button("Reply all")).toHaveClass("ui-button--primary");
  expect(button("Reply")).not.toHaveClass("ui-button--primary");
  act(() => useComposeSettings.getState().setDefaultReply("reply"));
});

test("in Spam the Archive button is Not spam, and in Trash it's Move to Inbox", () => {
  act(() => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "SPAM" } });
    useUiStore.getState().toggleChecked(key(1));
  });
  const { unmount } = render(<ViewPane />);
  expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  fireEvent.click(button("Not spam"));
  expect(modified).toEqual([
    { accountId: "a1", threadIds: ["t1"], add: ["INBOX"], remove: ["SPAM"] },
  ]);
  unmount();
  act(() => useUiStore.setState({ mailbox: { accountId: "a1", labelId: "TRASH" } }));
  render(<ViewPane />);
  expect(button("Move to Inbox").querySelector("svg")).toHaveClass("lucide-inbox");
});

const moreMenu = () => {
  fireEvent.click(button("More actions"));
  const items = vi.mocked(showContextMenu).mock.lastCall![0];
  return items.filter((i) => i.type !== "separator") as Array<{
    id: string;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    onSelect(): void;
  }>;
};

test("the More menu's importance item swaps its words in place and acts on the checked rows", async () => {
  act(() => {
    useUiStore.getState().toggleChecked(key(1));
    useUiStore.getState().toggleChecked(key(2));
  });
  render(<ViewPane />);
  let items = moreMenu();
  const at = items.findIndex((i) => i.id === "important");
  expect(items[at]).toMatchObject({ label: "Mark as important", disabled: false });
  await act(async () => items[at].onSelect());
  expect(modified).toEqual([
    { accountId: "a1", threadIds: ["t1", "t2"], add: ["IMPORTANT"], remove: [] },
  ]);

  // Every target is important now: the same slot offers the opposite.
  items = moreMenu();
  expect(items.findIndex((i) => i.id === "important")).toBe(at);
  expect(items[at].label).toBe("Mark as not important");
});
