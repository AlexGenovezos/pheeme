import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { showContextMenu } from "../lib/contextMenu";
import type { LabelInfo, MessageDetail, ThreadDetail, ThreadSummary } from "../lib/tauri";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import {
  archive,
  moveSelection,
  openAndMarkRead,
  openLabelMenu,
  setRead,
  setStarred,
  targets,
  toggleLabel,
  toggleStar,
  trash,
} from "./actions";
import { threadKey } from "./mailboxes";

vi.mock("../lib/contextMenu", () => ({ showContextMenu: vi.fn(async () => {}) }));

const thread = (n: number, accountId = "a1", over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: `t${n}`,
  accountId,
  subject: `Subject ${n}`,
  snippet: null,
  fromName: null,
  fromAddress: null,
  date: 1_700_000_000_000 - n * 1000,
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  ...over,
});
const key = (n: number, accountId = "a1") => threadKey(accountId, `t${n}`);

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}
let calls: Call[] = [];
/** Accounts whose commands the fake backend rejects. */
let rejecting: Set<string>;

const modifyCalls = () => calls.filter((c) => c.cmd === "modify_threads").map((c) => c.args);
const toasts = () => useToastStore.getState().toasts;
const last = <T>(items: T[]): T => items[items.length - 1];

const realReload = useMailStore.getState().reload;
const realPrefetch = useThreadStore.getState().prefetch;
let reload: ReturnType<typeof vi.fn>;

const setList = (threads: ThreadSummary[]) => useMailStore.setState({ threads });
const listKeys = () => useMailStore.getState().threads.map((t) => threadKey(t.accountId, t.id));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetLabelStoreForTests();
  useToastStore.setState({ toasts: [] });
  calls = [];
  rejecting = new Set();
  reload = vi.fn(async () => {});
  useMailStore.setState({ reload });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if ((cmd === "modify_threads" || cmd === "trash_threads") && rejecting.has(a.accountId as string)) {
      throw { code: "gmail", message: `Gmail refused ${a.accountId}` };
    }
    return undefined;
  });
});
afterEach(() => {
  clearMocks();
  useMailStore.setState({ reload: realReload });
  useThreadStore.setState({ prefetch: realPrefetch });
  vi.mocked(showContextMenu).mockClear();
});

describe("archive", () => {
  test("removes rows now, calls modify_threads once per account, and opens the next row", async () => {
    setList([thread(1), thread(2), thread(3, "a2"), thread(4)]);
    useUiStore.setState({ checked: [key(2), key(3, "a2"), key(4)], openThread: key(2) });

    const done = archive();
    // Synchronously: before any command has settled.
    expect(listKeys()).toEqual([key(1)]);
    expect(useUiStore.getState().checked).toEqual([]);
    expect(useUiStore.getState().openThread).toBe(key(1));
    await done;

    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t2", "t4"], add: [], remove: ["INBOX"] },
      { accountId: "a2", threadIds: ["t3"], add: [], remove: ["INBOX"] },
    ]);
    expect(toasts()[0]).toMatchObject({ title: "Archived", description: "3 conversations" });
  });

  test("the open row goes to the one below, else the one above, else nothing", async () => {
    setList([thread(1), thread(2), thread(3)]);
    useUiStore.setState({ openThread: key(2) });
    await archive();
    expect(useUiStore.getState().openThread).toBe(key(3));
    await archive();
    expect(useUiStore.getState().openThread).toBe(key(1));
    await archive();
    expect(useUiStore.getState().openThread).toBeNull();
    expect(listKeys()).toEqual([]);
  });

  test("outside the inbox the rows stay (they only lose the INBOX label)", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "STARRED" }, openThread: key(1) });
    setList([thread(1), thread(2)]);
    await archive();
    expect(listKeys()).toEqual([key(1), key(2)]);
    expect(useUiStore.getState().openThread).toBe(key(1));
    expect(modifyCalls()).toHaveLength(1);
  });

  test("undo re-adds INBOX and reloads the rows back", async () => {
    setList([thread(1), thread(2)]);
    useUiStore.setState({ openThread: key(1) });
    await archive();
    toasts()[0].action!.run();
    await flush();
    expect(modifyCalls()[1]).toEqual({ accountId: "a1", threadIds: ["t1"], add: ["INBOX"], remove: [] });
    expect(reload).toHaveBeenCalled();
  });

  test("rejection for one account restores only that account's rows", async () => {
    setList([thread(1), thread(2, "a2")]);
    useUiStore.setState({ checked: [key(1), key(2, "a2")] });
    rejecting.add("a2");
    // The cache after the failed call: a1's thread is archived there, a2's never was.
    reload.mockImplementation(async () => setList([thread(2, "a2")]));

    await archive();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(listKeys()).toEqual([key(2, "a2")]);
    expect(toasts().map((t) => t.title)).toContain("Gmail refused a2");
    // The account that went through still gets its Undo.
    const announced = toasts().find((t) => t.title === "Archived");
    expect(announced?.description).toBeUndefined();
    announced!.action!.run();
    await flush();
    expect(last(modifyCalls())).toEqual({ accountId: "a1", threadIds: ["t1"], add: ["INBOX"], remove: [] });
  });

  test("nothing is announced when every account is refused", async () => {
    setList([thread(1)]);
    useUiStore.setState({ openThread: key(1) });
    rejecting.add("a1");
    await archive();
    expect(toasts().map((t) => t.title)).toEqual(["Gmail refused a1"]);
    expect(toasts()[0].tone).toBe("danger");
  });
});

describe("trash", () => {
  test("calls trash_threads and toasts without undo", async () => {
    setList([thread(1), thread(2)]);
    useUiStore.setState({ openThread: key(1) });
    await trash();
    expect(calls.filter((c) => c.cmd === "trash_threads").map((c) => c.args)).toEqual([{ accountId: "a1", threadIds: ["t1"] }]);
    expect(modifyCalls()).toEqual([]);
    expect(toasts()[0].title).toBe("Moved to Trash");
    expect(toasts()[0].action).toBeUndefined();
    expect(listKeys()).toEqual([key(2)]);
    expect(useUiStore.getState().openThread).toBe(key(2));
  });

  test("in Trash it says so and changes nothing", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "TRASH" }, openThread: key(1) });
    setList([thread(1)]);
    await trash();
    expect(calls).toEqual([]);
    expect(listKeys()).toEqual([key(1)]);
    expect(toasts()[0].title).toBe("Already in Trash");
  });
});

describe("star and read", () => {
  test("star toggles based on the first target's state", async () => {
    setList([thread(1, "a1", { starred: true }), thread(2)]);
    useUiStore.setState({ checked: [key(1), key(2)] });
    await toggleStar();
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1", "t2"], add: [], remove: ["STARRED"] }]);
    expect(useMailStore.getState().threads.map((t) => t.starred)).toEqual([false, false]);

    useUiStore.setState({ checked: [key(2), key(1)] });
    await toggleStar();
    expect(modifyCalls()[1]).toEqual({ accountId: "a1", threadIds: ["t2", "t1"], add: ["STARRED"], remove: [] });
    expect(useMailStore.getState().threads.map((t) => t.starred)).toEqual([true, true]);
  });

  test("starring and reading patch the rows, announce, and undo restores the patch", async () => {
    setList([thread(1, "a1", { unread: true })]);
    useUiStore.setState({ openThread: key(1) });
    await setStarred(true);
    expect(useMailStore.getState().threads[0].starred).toBe(true);
    expect(toasts()[0].title).toBe("Starred");
    toasts()[0].action!.run();
    expect(useMailStore.getState().threads[0].starred).toBe(false);
    await flush();
    expect(modifyCalls()[1]).toMatchObject({ add: [], remove: ["STARRED"] });

    await setRead(true);
    expect(useMailStore.getState().threads[0].unread).toBe(false);
    expect(modifyCalls()[2]).toMatchObject({ add: [], remove: ["UNREAD"] });
    expect(last(toasts())?.title).toBe("Marked as read");
    last(toasts())!.action!.run();
    expect(useMailStore.getState().threads[0].unread).toBe(true);
  });
});

describe("opening", () => {
  test("opening an unread thread marks it read once", async () => {
    setList([thread(1, "a1", { unread: true }), thread(2)]);
    useUiStore.setState({ checked: [key(2)] });
    openAndMarkRead(key(1));
    openAndMarkRead(key(1));
    await flush();
    expect(useUiStore.getState().openThread).toBe(key(1));
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1"], add: [], remove: ["UNREAD"] }]);
    expect(useMailStore.getState().threads[0].unread).toBe(false);
    // Quiet, and the selection is left alone.
    expect(toasts()).toEqual([]);
    expect(useUiStore.getState().checked).toEqual([key(2)]);
  });

  test("an already-read thread sends nothing", async () => {
    setList([thread(1)]);
    openAndMarkRead(key(1));
    await flush();
    expect(calls).toEqual([]);
  });

  test("j prefetches the neighbours of the new row", () => {
    const prefetch = vi.fn();
    useThreadStore.setState({ prefetch });
    setList([thread(1), thread(2), thread(3), thread(4)]);
    useUiStore.setState({ openThread: key(1) });
    moveSelection(1);
    expect(useUiStore.getState().openThread).toBe(key(2));
    expect(prefetch).toHaveBeenLastCalledWith([key(1), key(3)]);
    moveSelection(1);
    moveSelection(1);
    expect(useUiStore.getState().openThread).toBe(key(4));
    expect(prefetch).toHaveBeenLastCalledWith([key(3)]);
  });

  test("j and k stop at the ends, and start from the ends when nothing is open", () => {
    setList([thread(1), thread(2)]);
    moveSelection(-1);
    expect(useUiStore.getState().openThread).toBe(key(2));
    moveSelection(1);
    expect(useUiStore.getState().openThread).toBe(key(2));
    useUiStore.setState({ openThread: null });
    moveSelection(1);
    expect(useUiStore.getState().openThread).toBe(key(1));
  });
});

describe("a thread removed underneath", () => {
  test("actions do nothing and don't throw; j and k keep working on what is left", async () => {
    setList([thread(1), thread(2)]);
    useUiStore.setState({ openThread: key(9), checked: [] });
    expect(targets()).toEqual([key(9)]);

    await archive();
    await trash();
    await setStarred(true);
    await toggleStar();
    await setRead(false);
    await toggleLabel("a1", "Label_1");
    await openLabelMenu({ x: 0, y: 0 });
    expect(calls).toEqual([]);
    expect(toasts()).toEqual([]);
    expect(listKeys()).toEqual([key(1), key(2)]);

    moveSelection(1);
    expect(useUiStore.getState().openThread).toBe(key(1));
  });

  test("a checked row that vanished is skipped, the others are still acted on", async () => {
    setList([thread(1)]);
    useUiStore.setState({ checked: [key(9), key(1)] });
    await archive();
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1"], add: [], remove: ["INBOX"] }]);
  });
});

describe("labels", () => {
  const label = (id: string, name: string): LabelInfo => ({
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
  });
  const detail = (n: number, labelIds: string[]): ThreadDetail => ({
    thread: thread(n),
    messages: [{ id: `m${n}`, threadId: `t${n}`, labelIds } as MessageDetail],
  });
  const cache = (...details: ThreadDetail[]) =>
    useThreadStore.setState({ details: new Map(details.map((d) => [threadKey(d.thread.accountId, d.thread.id), d])) });

  beforeEach(() => {
    useLabelStore.setState({ labels: { a1: [label("Label_1", "Work"), label("Label_2", "Home")] } });
  });

  test("toggling adds the label unless every target has it", async () => {
    setList([thread(1), thread(2)]);
    cache(detail(1, ["INBOX", "Label_1"]), detail(2, ["INBOX"]));
    useUiStore.setState({ checked: [key(1), key(2)] });
    await toggleLabel("a1", "Label_1");
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1", "t2"], add: ["Label_1"], remove: [] }]);

    cache(detail(1, ["Label_1"]), detail(2, ["Label_1"]));
    await toggleLabel("a1", "Label_1", [key(1), key(2)]);
    expect(modifyCalls()[1]).toEqual({ accountId: "a1", threadIds: ["t1", "t2"], add: [], remove: ["Label_1"] });
    // Labels don't show in the list, so the rows stay in an inbox.
    expect(listKeys()).toEqual([key(1), key(2)]);
  });

  test("removing the label of the mailbox being shown takes the row out", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "Label_1" }, openThread: key(1) });
    setList([thread(1), thread(2)]);
    cache(detail(1, ["Label_1"]));
    await toggleLabel("a1", "Label_1");
    expect(listKeys()).toEqual([key(2)]);
    expect(useUiStore.getState().openThread).toBe(key(2));
  });

  test("only the targets of that account are sent", async () => {
    setList([thread(1), thread(2, "a2")]);
    cache(detail(1, []));
    await toggleLabel("a1", "Label_1", [key(1), key(2, "a2")]);
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1"], add: ["Label_1"], remove: [] }]);
  });

  test("the menu lists the account's labels, checked where every target has them", async () => {
    setList([thread(1), thread(2)]);
    cache(detail(1, ["Label_1"]), detail(2, ["Label_1", "Label_2"]));
    useUiStore.setState({ checked: [key(1), key(2)] });
    await openLabelMenu({ x: 4, y: 8 });

    expect(showContextMenu).toHaveBeenCalledTimes(1);
    const [items, at] = vi.mocked(showContextMenu).mock.calls[0];
    expect(at).toEqual({ x: 4, y: 8 });
    expect(items.map((i) => (i.type === "separator" ? null : [i.label, i.checked]))).toEqual([
      ["Home", false],
      ["Work", true],
    ]);

    // Choosing a checked item removes it from both.
    const work = items.find((i) => i.type !== "separator" && i.label === "Work");
    if (!work || work.type === "separator") throw new Error("no Work item");
    work.onSelect();
    await flush();
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1", "t2"], add: [], remove: ["Label_1"] }]);
  });

  test("an account without labels says so instead of opening an empty menu", async () => {
    useLabelStore.setState({ labels: { a1: [] } });
    setList([thread(1)]);
    useUiStore.setState({ openThread: key(1) });
    await openLabelMenu({ x: 0, y: 0 });
    expect(showContextMenu).not.toHaveBeenCalled();
    expect(toasts()[0].title).toBe("No labels yet");
  });
});
