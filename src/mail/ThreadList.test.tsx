import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import { useGlobalShortcuts } from "../keyboard/useCommands";
import type { AccountInfo, LabelInfo, ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { stubLayout } from "../test/layout";
import { Sidebar } from "../shell/Sidebar";
import { HtmlBody } from "./EmailBody";
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
  labelIds: [],
  systemLabelIds: [],
});

const many = (count: number, accountId = "a1") =>
  Array.from({ length: count }, (_, i) => thread(i, accountId));
const key = (n: number, accountId = "a1") => threadKey(accountId, `t${n}`);

const props = (over: Partial<ThreadListProps> = {}): ThreadListProps => ({
  title: "Inbox",
  onRowAction: vi.fn(),
  rowMenu: () => [],
  ...over,
});

const cursor = { date: 1, id: "x", accountId: "a1" } as unknown as NonNullable<
  ReturnType<typeof useMailStore.getState>["next"]
>;

/** Route a key through the shortcut registry, as the app root does for window keydowns. */
const pressKey = (k: string) =>
  act(() => void registry.handleKeyDown(new KeyboardEvent("keydown", { key: k })));

const options = () => screen.queryAllByRole("option");
const row = (n: number) =>
  screen.getByText(`Subject ${n}`).closest('[role="option"]') as HTMLElement;

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
    expect(document.querySelector<HTMLElement>(".thread-list")!.style.height).toBe(
      `${1000 * 76}px`,
    );
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

  test("visible checkboxes toggle selection without opening a conversation", () => {
    render(<ThreadList {...props()} />);
    expect(within(row(1)).getByRole("checkbox")).not.toBeChecked();

    fireEvent.click(within(row(2)).getByRole("checkbox"));
    expect(useUiStore.getState().openThread).toBeNull();
    expect(within(row(1)).getByRole("checkbox")).not.toBeChecked();
    expect(within(row(2)).getByRole("checkbox")).toBeChecked();

    fireEvent.click(within(row(2)).getByRole("checkbox"));
    expect(useUiStore.getState().checked).toEqual([]);
    expect(within(row(1)).getByRole("checkbox")).not.toBeChecked();
  });

  test("hovering shows the actions while selection stays available", () => {
    const onRowAction = vi.fn();
    render(<ThreadList {...props({ onRowAction })} />);
    fireEvent.mouseEnter(row(1));
    fireEvent.click(within(row(1)).getByRole("button", { name: /Archive/ }));
    expect(onRowAction).toHaveBeenCalledWith("archive", expect.objectContaining({ id: "t1" }));
    expect(useUiStore.getState().openThread).toBeNull();
    fireEvent.click(within(row(1)).getByRole("checkbox"));
    expect(useUiStore.getState().checked).toEqual([key(1)]);
    fireEvent.mouseLeave(row(1));
    expect(within(row(1)).getByRole("checkbox")).toBeInTheDocument();
  });
});

describe("focus and selection semantics", () => {
  test("clicking a conversation focuses the list so arrows keep navigating", () => {
    useMailStore.setState({ threads: many(3) });
    render(<ThreadList {...props()} />);
    const list = screen.getByRole("listbox");

    fireEvent.click(row(1));
    expect(list).toHaveFocus();
    expect(useUiStore.getState().openThread).toBe(key(1));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(useUiStore.getState().openThread).toBe(key(2));
  });

  test("Left returns from the reading pane to the current conversation and restores Up/Down", () => {
    function Mail() {
      useGlobalShortcuts();
      return (
        <>
          <ThreadList {...props()} />
          <button>Reply</button>
          <input aria-label="Reply text" />
        </>
      );
    }
    useMailStore.setState({ threads: many(3) });
    useUiStore.setState({ openThread: key(1) });
    render(<Mail />);
    const list = screen.getByRole("listbox");
    const reply = screen.getByRole("button", { name: "Reply" });
    reply.focus();

    fireEvent.keyDown(reply, { key: "ArrowLeft", shiftKey: true });
    expect(reply).toHaveFocus();
    fireEvent.keyDown(reply, { key: "ArrowLeft" });
    expect(list).toHaveFocus();
    expect(useUiStore.getState().openThread).toBe(key(1));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(useUiStore.getState().openThread).toBe(key(2));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(useUiStore.getState().openThread).toBe(key(1));

    const input = screen.getByRole("textbox", { name: "Reply text" });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(input).toHaveFocus();
  });

  test("Left goes on from the list to the open mailbox, Up/Down open mailboxes, Right comes back", () => {
    function Mail() {
      useGlobalShortcuts();
      return (
        <>
          <Sidebar />
          <ThreadList {...props()} />
        </>
      );
    }
    useMailStore.setState({ threads: many(3) });
    useUiStore.setState({ openThread: key(1) });
    render(<Mail />);
    const list = screen.getByRole("listbox");
    const mailboxes = screen.getByRole("navigation", { name: "Mailboxes" });
    const allInboxes = within(mailboxes).getByRole("link", { name: "All Inboxes" });
    list.focus();

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(allInboxes).toHaveFocus();

    // Left has nowhere further to go; it must not bounce back to the list.
    fireEvent.keyDown(allInboxes, { key: "ArrowLeft" });
    expect(allInboxes).toHaveFocus();
    fireEvent.keyDown(allInboxes, { key: "ArrowUp" });
    expect(allInboxes).toHaveFocus();
    expect(useUiStore.getState().mailbox).toEqual(ALL_INBOXES);

    fireEvent.keyDown(allInboxes, { key: "ArrowDown" });
    const primary = within(mailboxes).getAllByRole("link", { name: "Primary" })[0];
    expect(primary).toHaveFocus();
    expect(useUiStore.getState().mailbox).toEqual(categoryMailbox("a1", "CATEGORY_PERSONAL"));
    fireEvent.keyDown(primary, { key: "ArrowDown" });
    expect(useUiStore.getState().mailbox).toEqual(categoryMailbox("a1", "CATEGORY_SOCIAL"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(primary).toHaveFocus();
    expect(useUiStore.getState().mailbox).toEqual(categoryMailbox("a1", "CATEGORY_PERSONAL"));

    // From an account header, Down lands on that account's first mailbox.
    const header = screen.getByRole("button", { name: /a2@example\.com/ });
    header.focus();
    fireEvent.keyDown(header, { key: "ArrowDown" });
    expect(useUiStore.getState().mailbox).toEqual(categoryMailbox("a2", "CATEGORY_PERSONAL"));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
  });

  test("Left returns from an HTML email iframe and arrows resume at the open conversation", () => {
    useMailStore.setState({ threads: many(3) });
    useUiStore.setState({ openThread: key(1) });
    render(
      <>
        <ThreadList {...props()} />
        <HtmlBody html="<p>Email body</p>" declaresDark={false} />
      </>,
    );
    const list = screen.getByRole("listbox");
    const frame = screen.getByTitle("Message body") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<a href="https://example.com">Email link</a>';
    fireEvent.load(frame);
    const link = doc.querySelector("a")!;
    link.focus();
    expect(document.activeElement).toBe(frame);

    const event = new doc.defaultView!.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    act(() => void link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(list).toHaveFocus();
    expect(useUiStore.getState().openThread).toBe(key(1));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(useUiStore.getState().openThread).toBe(key(2));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(useUiStore.getState().openThread).toBe(key(1));
  });

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
    for (const button of within(row(2)).getAllByRole("button"))
      expect(button).toHaveAttribute("tabindex", "-1");
    act(() => useUiStore.getState().setOpenThread(key(4)));
    pressKey("x");
    expect(useUiStore.getState().checked).toEqual([key(1), key(4)]);
  });

  test("with the reading pane off, x ignores a highlight whose row has left the list", () => {
    useMailStore.setState({ threads: many(3) });
    useUiStore.getState().setReadingPane(false);
    render(<ThreadList {...props()} />);
    act(() => useUiStore.getState().setCursor(key(9)));
    pressKey("x");
    expect(useUiStore.getState().checked).toEqual([]);
    act(() => useUiStore.getState().setCursor(key(1)));
    pressKey("x");
    expect(useUiStore.getState().checked).toEqual([key(1)]);
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

describe("location tag", () => {
  const placed = () => [
    { ...thread(1), systemLabelIds: ["CATEGORY_UPDATES", "INBOX"] },
    { ...thread(2), systemLabelIds: ["SPAM"] },
    { ...thread(3), systemLabelIds: [] },
  ];

  test("All Mail rows say where each conversation sits", () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "ALL" } });
    useMailStore.setState({ threads: placed() });
    render(<ThreadList {...props()} />);
    expect(within(row(1)).getByText("Updates")).toHaveClass("thread-row__location");
    expect(within(row(1)).getByText("Updates").style.getPropertyValue("--row-color")).toBe(
      "var(--color-mailbox-updates)",
    );
    expect(within(row(2)).getByText("Spam")).toBeInTheDocument();
    expect(within(row(3)).getByText("Archived")).toBeInTheDocument();
  });

  test("an inbox list doesn't repeat its own location", () => {
    useUiStore.setState({ mailbox: categoryMailbox("a1", "CATEGORY_UPDATES") });
    useMailStore.setState({ threads: placed() });
    render(<ThreadList {...props()} />);
    expect(document.querySelector(".thread-row__location")).toBeNull();
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
    useMailStore.setState({
      threads: [],
      error: { code: "internal", message: "Couldn't read the cache" },
      reload,
    });
    const { container } = render(<ThreadList {...props()} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the cache");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("error state retries", () => {
    const reload = vi.fn(async () => {});
    useMailStore.setState({
      threads: [],
      error: { code: "internal", message: "Couldn't read the cache" },
      reload,
    });
    render(<ThreadList {...props()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the cache");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a failed page keeps the rows and offers a retry", () => {
    const reload = vi.fn(async () => {});
    useMailStore.setState({
      threads: many(5),
      error: { code: "internal", message: "Couldn't load more" },
      reload,
    });
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
    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => void list.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(useUiStore.getState().checked).toEqual([key(0), key(1), key(2), key(3), key(4)]);
  });

  test("enter opens the first row when none is open, and a click marks an unread row read", async () => {
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
    // Sent once each conversation's detail has loaded.
    await vi.waitFor(() => expect(calls.filter((c) => c === "modify_threads")).toHaveLength(2));
  });

  test("right-clicking a row builds its menu without opening it, marking it read or touching the selection", () => {
    const calls: string[] = [];
    mockIPC((cmd) => void calls.push(cmd), { shouldMockEvents: true });
    useMailStore.setState({ threads: many(5) });
    const rowMenu = vi.fn(() => []);
    render(<ThreadList {...props({ rowMenu })} />);
    act(() => useUiStore.getState().checkAll([key(1), key(2)]));
    fireEvent.contextMenu(row(4), { clientX: 1, clientY: 1 }); // t4 is unread
    expect(rowMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "t4" }));
    expect(useUiStore.getState().checked).toEqual([key(1), key(2)]);
    expect(useUiStore.getState().openThread).toBeNull();
    expect(useMailStore.getState().threads[4].unread).toBe(true);
    expect(calls).not.toContain("modify_threads");
  });
});

test("the unread-only empty state names the current mailbox", () => {
  act(() => useUiStore.getState().toggleUnreadOnly());
  render(<ThreadList {...props({ title: "All Inboxes" })} />);
  expect(screen.getByText("No unread mail in All Inboxes")).toBeInTheDocument();
  expect(screen.queryByText("Inbox zero.")).not.toBeInTheDocument();
});

describe("label chips", () => {
  const userLabel = (id: string, name: string, over: Partial<LabelInfo> = {}): LabelInfo => ({
    id,
    accountId: "a1",
    name,
    type: "user",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
    colorBackground: null,
    colorText: null,
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
    ...over,
  });

  test("row shows chips for visible user labels, not the current label", () => {
    __resetLabelStoreForTests();
    useLabelStore.setState({
      labels: {
        a1: [
          userLabel("L1", "Clients/Acme", { colorBackground: "#4a86e8", colorText: "#000000" }),
          userLabel("L2", "Receipts"),
          userLabel("L3", "Hidden", { messageListVisibility: "hide" }),
          userLabel("L4", "Current"),
        ],
      },
    });
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "L4" } });
    useMailStore.setState({
      threads: [{ ...thread(1), labelIds: ["L1", "L2", "L3", "L4"] }],
    });
    render(<ThreadList {...props()} />);
    const r = within(row(1));
    expect(r.getByText("Clients/Acme")).toBeInTheDocument();
    expect(r.getByText("Clients/Acme").closest("[title]")).toHaveAttribute("title", "Clients/Acme");
    expect(r.getByText("Receipts")).toBeInTheDocument();
    expect(r.queryByText("Hidden")).toBeNull();
    expect(r.queryByText("Current")).toBeNull();
  });

  test("more than three chips collapse into +N", () => {
    __resetLabelStoreForTests();
    const labels = ["A", "B", "C", "D", "E"].map((n) => userLabel(`L${n}`, n));
    useLabelStore.setState({ labels: { a1: labels } });
    useMailStore.setState({
      threads: [{ ...thread(1), labelIds: labels.map((l) => l.id) }],
    });
    render(<ThreadList {...props()} />);
    const r = within(row(1));
    expect(r.getByText("C")).toBeInTheDocument();
    expect(r.queryByText("D")).toBeNull();
    expect(r.getByText("+2")).toBeInTheDocument();
  });
});

describe("list density", () => {
  const load = () => {
    useMailStore.setState({ threads: many(3), loading: false, next: null });
    return render(<ThreadList {...props()} />);
  };

  test("comfortable shows the snippet", () => {
    load();
    expect(screen.getByRole("listbox")).toHaveAttribute("data-density", "comfortable");
    expect(screen.getByText("Snippet 1")).toBeInTheDocument();
  });

  test("compact leaves the snippet out", () => {
    useUiStore.setState({ listDensity: "compact" });
    load();
    expect(screen.getByRole("listbox")).toHaveAttribute("data-density", "compact");
    expect(screen.getByText("Subject 1")).toBeInTheDocument();
    expect(screen.queryByText("Snippet 1")).not.toBeInTheDocument();
  });

  test("compact rows render at the height the list estimates for them", async () => {
    // Vitest hands tests empty CSS modules, so read the stylesheet itself (untyped: the app has no Node types).
    const fs: { readFileSync(path: string, encoding: "utf8"): string } = await import(
      "node:fs" as string
    );
    const style = document.createElement("style");
    style.textContent = fs.readFileSync("src/mail/mail.css", "utf8");
    document.head.append(style);
    try {
      useUiStore.setState({ listDensity: "compact" });
      const { container } = load();
      const row = container.querySelector<HTMLElement>(".thread-row")!;
      expect(getComputedStyle(row).height).toBe("var(--row-height-thread-compact)");
    } finally {
      style.remove();
    }
  });
});
