import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import type { AccountInfo, ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { stubLayout } from "../test/layout";
import { ALL_INBOXES, categoryMailbox, threadKey } from "./mailboxes";
import { ThreadList, type ThreadListProps } from "./ThreadList";
import { rowId } from "./ThreadRow";

const account = (id: string, synced = true): AccountInfo => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  clientId: "1.apps.googleusercontent.com",
  synced,
});

const thread = (n: number, accountId = "a1"): ThreadSummary => ({
  id: `t${n}`,
  accountId,
  subject: `Subject ${n}`,
  snippet: `Snippet ${n}`,
  fromName: `Sender ${n}`,
  fromAddress: `s${n}@example.com`,
  date: 1_700_000_000_000 - n * 1000,
  unread: n % 2 === 0,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
});

const many = (count: number, accountId = "a1") => Array.from({ length: count }, (_, i) => thread(i, accountId));
const key = (n: number, accountId = "a1") => threadKey(accountId, `t${n}`);

const props = (over: Partial<ThreadListProps> = {}): ThreadListProps => ({
  title: "Inbox",
  onRowAction: vi.fn(),
  rowMenu: () => [],
  ...over,
});

const cursor = { date: 1, id: "x", accountId: "a1" } as unknown as NonNullable<ReturnType<typeof useMailStore.getState>["next"]>;

/** Route a key through the shortcut registry, as the app root does for window keydowns. */
const pressKey = (k: string) => act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: k })));

const options = () => screen.queryAllByRole("option");
const row = (n: number) => screen.getByText(`Subject ${n}`).closest('[role="option"]') as HTMLElement;

let restoreLayout: () => void;

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  useAccountStore.setState({ accounts: [account("a1"), account("a2")] });
  mockIPC(() => undefined, { shouldMockEvents: true });
  restoreLayout = stubLayout();
});
afterEach(() => {
  restoreLayout();
  registry.clear();
});

describe("virtualization and paging", () => {
  test("renders only visible rows for 1,000 threads", () => {
    useMailStore.setState({ threads: many(1000) });
    render(<ThreadList {...props()} />);
    expect(options().length).toBeGreaterThan(0);
    expect(options().length).toBeLessThan(60);
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    // The canvas declares the whole dataset's height, so the scroll extent is the full list.
    expect(document.querySelector<HTMLElement>(".thread-list")!.style.height).toBe(`${1000 * 76}px`);
  });

  test("rows know their place in the set; the size is -1 while more pages exist", () => {
    useMailStore.setState({ threads: many(30), next: cursor, loadMore: vi.fn(async () => {}) });
    const { unmount } = render(<ThreadList {...props()} />);
    expect(row(0)).toHaveAttribute("aria-posinset", "1");
    expect(row(4)).toHaveAttribute("aria-posinset", "5");
    expect(row(4)).toHaveAttribute("aria-setsize", "-1");
    unmount();

    useMailStore.setState({ threads: many(30), next: null });
    render(<ThreadList {...props()} />);
    expect(row(4)).toHaveAttribute("aria-setsize", "30");
  });

  test("scrolling near the end calls loadMore once", () => {
    const loadMore = vi.fn(async () => {});
    useMailStore.setState({ threads: many(200), next: cursor, loadMore });
    render(<ThreadList {...props()} />);
    expect(loadMore).not.toHaveBeenCalled();

    const list = screen.getByRole("listbox");
    act(() => {
      list.scrollTop = 76 * 195;
      fireEvent.scroll(list);
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  test("does not ask for more when there is no next page", () => {
    const loadMore = vi.fn(async () => {});
    useMailStore.setState({ threads: many(5), next: null, loadMore });
    render(<ThreadList {...props()} />);
    expect(loadMore).not.toHaveBeenCalled();
  });
});

describe("selection", () => {
  beforeEach(() => {
    useMailStore.setState({ threads: many(20) });
  });

  test("a plain click opens the thread", () => {
    render(<ThreadList {...props()} />);
    fireEvent.click(row(3));
    expect(useUiStore.getState().openThread).toBe(key(3));
    expect(useUiStore.getState().checked).toEqual([]);
  });

  test("cmd-click toggles, shift-click checks a range, x toggles the focused row", () => {
    render(<ThreadList {...props()} />);
    fireEvent.click(row(2), { metaKey: true });
    expect(useUiStore.getState().checked).toEqual([key(2)]);
    fireEvent.click(row(2), { ctrlKey: true });
    expect(useUiStore.getState().checked).toEqual([]);

    fireEvent.click(row(2), { metaKey: true });
    fireEvent.click(row(5), { shiftKey: true });
    expect(useUiStore.getState().checked).toEqual([key(2), key(3), key(4), key(5)]);
    expect(useUiStore.getState().openThread).toBeNull();

    // x acts on the focused row, which j/k keep as the open thread.
    act(() => useUiStore.getState().setOpenThread(key(8)));
    pressKey("x");
    expect(useUiStore.getState().checked).toContain(key(8));
    pressKey("x");
    expect(useUiStore.getState().checked).not.toContain(key(8));
  });

  test("avatar becomes a checkbox while anything is checked", () => {
    render(<ThreadList {...props()} />);
    expect(within(row(1)).getByRole("img", { name: "Sender 1" })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    fireEvent.click(row(2), { metaKey: true });
    expect(within(row(1)).queryByRole("img", { name: "Sender 1" })).not.toBeInTheDocument();
    expect(within(row(1)).getByRole("checkbox")).not.toBeChecked();
    expect(within(row(2)).getByRole("checkbox")).toBeChecked();

    fireEvent.click(within(row(2)).getByRole("checkbox"));
    expect(useUiStore.getState().checked).toEqual([]);
    expect(within(row(1)).getByRole("img", { name: "Sender 1" })).toBeInTheDocument();
  });

  test("hovering a row turns its avatar into a checkbox and shows the actions", () => {
    const onRowAction = vi.fn();
    render(<ThreadList {...props({ onRowAction })} />);
    fireEvent.mouseEnter(row(1));
    fireEvent.click(within(row(1)).getByRole("button", { name: /Archive/ }));
    expect(onRowAction).toHaveBeenCalledWith("archive", expect.objectContaining({ id: "t1" }));
    expect(useUiStore.getState().openThread).toBeNull();
    fireEvent.click(within(row(1)).getByRole("checkbox"));
    expect(useUiStore.getState().checked).toEqual([key(1)]);
    fireEvent.mouseLeave(row(1));
    expect(within(row(1)).getByRole("checkbox")).toBeInTheDocument(); // still selecting
  });
});

describe("focus and selection semantics", () => {
  test("focus stays on the listbox across the virtual window; activedescendant follows the open row", () => {
    useMailStore.setState({ threads: many(200) });
    render(<ThreadList {...props()} />);
    const list = screen.getByRole("listbox");
    list.focus();
    act(() => useUiStore.getState().setOpenThread(key(0)));
    expect(list).toHaveAttribute("aria-activedescendant", rowId(key(0)));
    expect(document.getElementById(rowId(key(0)))).toBe(row(0));

    // j/k set the open thread; jump far past what is mounted, then step with the arrows.
    act(() => useUiStore.getState().setOpenThread(key(150)));
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute("aria-activedescendant", rowId(key(150)));
    expect(document.getElementById(rowId(key(150)))).not.toBeNull();
    expect(screen.queryByText("Subject 0")).not.toBeInTheDocument();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(useUiStore.getState().openThread).toBe(key(151));
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute("aria-activedescendant", rowId(key(151)));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(useUiStore.getState().openThread).toBe(key(149));
    expect(list).toHaveFocus();
  });

  test("the active option stays mounted when the user scrolls it out of the window", () => {
    useMailStore.setState({ threads: many(200) });
    render(<ThreadList {...props()} />);
    const list = screen.getByRole("listbox");
    act(() => useUiStore.getState().setOpenThread(key(0)));
    act(() => {
      list.scrollTop = 76 * 100;
      fireEvent.scroll(list);
    });
    // Rows near the top are gone from the window...
    expect(screen.queryByText("Subject 5")).not.toBeInTheDocument();
    expect(screen.getByText("Subject 100")).toBeInTheDocument();
    // ...but the row the listbox points at is still there.
    const target = list.getAttribute("aria-activedescendant")!;
    expect(target).toBe(rowId(key(0)));
    expect(document.getElementById(target)).toBe(row(0));
    // Once another row is active the old one can unmount again.
    act(() => useUiStore.getState().setOpenThread(key(110)));
    expect(screen.queryByText("Subject 0")).not.toBeInTheDocument();
  });

  test("arrows start at the ends and stop there", () => {
    useMailStore.setState({ threads: many(3) });
    render(<ThreadList {...props()} />);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(useUiStore.getState().openThread).toBe(key(0));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(useUiStore.getState().openThread).toBe(key(0));
  });

  test("nothing inside a row takes keyboard focus, and x acts on the active row", () => {
    useMailStore.setState({ threads: many(10) });
    render(<ThreadList {...props()} />);
    fireEvent.click(row(1), { metaKey: true });
    fireEvent.mouseEnter(row(2));
    expect(within(row(2)).getByRole("checkbox")).toHaveAttribute("tabindex", "-1");
    for (const button of within(row(2)).getAllByRole("button")) expect(button).toHaveAttribute("tabindex", "-1");
    act(() => useUiStore.getState().setOpenThread(key(4)));
    pressKey("x");
    expect(useUiStore.getState().checked).toEqual([key(1), key(4)]);
  });

  test("aria-selected is the checked set; the open row is drawn separately", () => {
    useMailStore.setState({ threads: many(10) });
    render(<ThreadList {...props()} />);
    fireEvent.click(row(2)); // open A
    fireEvent.click(row(5), { metaKey: true }); // check B
    expect(row(2)).toHaveAttribute("aria-selected", "false");
    expect(row(2)).toHaveAttribute("data-selected", "true");
    expect(row(5)).toHaveAttribute("aria-selected", "true");
    expect(row(5)).not.toHaveAttribute("data-selected");
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-activedescendant", rowId(key(2)));
  });
});

describe("account dot", () => {
  test("account dot only under All Inboxes", () => {
    useMailStore.setState({ threads: [thread(1, "a1"), thread(2, "a2")] });
    act(() => useUiStore.setState({ mailbox: ALL_INBOXES }));
    const { unmount } = render(<ThreadList {...props()} />);
    expect(screen.getByRole("img", { name: "Account a1@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Account a2@example.com" })).toBeInTheDocument();
    unmount();

    act(() => useUiStore.setState({ mailbox: categoryMailbox("a1", "CATEGORY_SOCIAL") }));
    render(<ThreadList {...props()} />);
    expect(screen.queryByRole("img", { name: /^Account / })).not.toBeInTheDocument();
  });
});

describe("states", () => {
  test("skeleton only before first sync", () => {
    useAccountStore.setState({ accounts: [account("a1", false)] });
    useUiStore.setState({ mailbox: categoryMailbox("a1", "CATEGORY_PERSONAL") });
    const { container, rerender } = render(<ThreadList {...props()} />);
    expect(container.querySelectorAll(".ui-skeleton--circle")).toHaveLength(8);
    expect(screen.queryByText("Inbox zero.")).not.toBeInTheDocument();

    act(() => useAccountStore.setState({ accounts: [account("a1", true)] }));
    rerender(<ThreadList {...props()} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
    expect(screen.getByText("Inbox zero.")).toBeInTheDocument();
  });

  test("an unsynced account shows rows once it has some", () => {
    useAccountStore.setState({ accounts: [account("a1", false)] });
    useMailStore.setState({ threads: many(3) });
    const { container } = render(<ThreadList {...props()} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
    expect(options().length).toBe(3);
  });

  test("a synced account that is still unsynced elsewhere is not skeletoned for its own mailbox", () => {
    useAccountStore.setState({ accounts: [account("a1", true), account("a2", false)] });
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "SENT" } });
    const { container } = render(<ThreadList {...props({ title: "Sent" })} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
    expect(screen.getByText("No conversations in Sent")).toBeInTheDocument();
  });

  test.each([
    [ALL_INBOXES, "Inbox", "Inbox zero."],
    [categoryMailbox("a1", "CATEGORY_SOCIAL"), "Social", "Inbox zero."],
    [{ accountId: "a1", labelId: "STARRED" }, "Starred", "Nothing starred yet."],
    [{ accountId: "a1", labelId: "TRASH" }, "Trash", "No conversations in Trash"],
    [{ accountId: "a1", labelId: "Label_1" }, "Receipts", "No conversations in Receipts"],
  ])("empty copy for %j", (mailbox, title, copy) => {
    useUiStore.setState({ mailbox });
    render(<ThreadList {...props({ title })} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  test("a failed first query beats the skeletons", () => {
    useAccountStore.setState({ accounts: [account("a1", false)] });
    useUiStore.setState({ mailbox: categoryMailbox("a1", "CATEGORY_PERSONAL") });
    const reload = vi.fn(async () => {});
    useMailStore.setState({ threads: [], error: { code: "internal", message: "Couldn't read the cache" }, reload });
    const { container } = render(<ThreadList {...props()} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the cache");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("error state retries", () => {
    const reload = vi.fn(async () => {});
    useMailStore.setState({ threads: [], error: { code: "internal", message: "Couldn't read the cache" }, reload });
    render(<ThreadList {...props()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the cache");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a failed page keeps the rows and offers a retry", () => {
    const reload = vi.fn(async () => {});
    useMailStore.setState({ threads: many(5), error: { code: "internal", message: "Couldn't load more" }, reload });
    render(<ThreadList {...props()} />);
    expect(options()).toHaveLength(5);
    // The retry sits beside the listbox, not inside it.
    expect(within(screen.getByRole("listbox")).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load more");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("never shows a spinner or the empty copy while the first page loads", () => {
    useMailStore.setState({ threads: [], loading: true });
    render(<ThreadList {...props()} />);
    expect(screen.queryByText("Inbox zero.")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("keyboard and menu wiring", () => {
  test("mod+a in the list checks every loaded row; in the registry it is left to the page", () => {
    useMailStore.setState({ threads: many(5) });
    render(<ThreadList {...props()} />);
    const list = screen.getByRole("listbox");
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void list.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(useUiStore.getState().checked).toEqual([key(0), key(1), key(2), key(3), key(4)]);
  });

  test("enter opens the first row when none is open, and a click marks an unread row read", () => {
    const calls: string[] = [];
    mockIPC((cmd) => void calls.push(cmd), { shouldMockEvents: true });
    useMailStore.setState({ threads: many(4) });
    render(<ThreadList {...props()} />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(useUiStore.getState().openThread).toBe(key(0));
    expect(useMailStore.getState().threads[0].unread).toBe(false);

    fireEvent.click(row(2)); // t2 is unread
    expect(useUiStore.getState().openThread).toBe(key(2));
    expect(useMailStore.getState().threads[2].unread).toBe(false);
    expect(calls.filter((c) => c === "modify_threads")).toHaveLength(2);
  });

  test("a context menu on a row outside the selection drops the selection; inside it keeps it", () => {
    useMailStore.setState({ threads: many(5) });
    const rowMenu = vi.fn(() => []);
    render(<ThreadList {...props({ rowMenu })} />);
    act(() => useUiStore.getState().checkAll([key(1), key(2)]));
    fireEvent.contextMenu(row(2), { clientX: 1, clientY: 1 });
    expect(useUiStore.getState().checked).toEqual([key(1), key(2)]);
    fireEvent.contextMenu(row(4), { clientX: 1, clientY: 1 });
    expect(useUiStore.getState().checked).toEqual([]);
    expect(useUiStore.getState().openThread).toBe(key(4));
  });
});
