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
/** What `list_threads` answers: the cache as the server side sees it. */
let listPage: ThreadSummary[];
/** What `get_thread` answers, by thread key. */
let details: Record<string, ThreadDetail>;
/** While set, `get_thread` answers only once it settles. */
let detailGate: Promise<void> | null;
/** Commands held back: `modify_threads` and `trash_threads` calls that match wait for their gate, as when the cache hasn't applied them yet. */
let gates: Array<{ match: (args: Record<string, unknown>) => boolean; open: Promise<void> }>;
/** Hold the matching commands (all of them by default); returns the release. */
const hold = (match: (args: Record<string, unknown>) => boolean = () => true) => {
  let release!: () => void;
  const gate = { match, open: new Promise<void>((resolve) => (release = resolve)) };
  gates.push(gate);
  return () => {
    gates = gates.filter((g) => g !== gate);
    release();
  };
};

const modifyCalls = () => calls.filter((c) => c.cmd === "modify_threads").map((c) => c.args);
const toasts = () => useToastStore.getState().toasts;
const last = <T>(items: T[]): T => items[items.length - 1];

const realReloadFn = useMailStore.getState().reload;
/** Use the store's real reload, answered by `listPage`, instead of the mock the other tests count calls on. */
const useRealReload = (accountIds = ["a1"]) =>
  useMailStore.setState({ reload: realReloadFn, query: { accountIds, labelId: "INBOX" } });
/** Reload for real, with the server side saying `rows`. */
const reloadWith = async (rows: ThreadSummary[]) => {
  listPage = rows;
  await realReloadFn();
};
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
  useMailStore.setState({ reload, query: null });
  listPage = [];
  details = {};
  detailGate = null;
  gates = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "list_threads") return { threads: listPage, next: null };
    if (cmd === "get_thread")
      return (async () => {
        await detailGate;
        return details[threadKey(a.accountId as string, a.threadId as string)];
      })();
    if (cmd !== "modify_threads" && cmd !== "trash_threads") return undefined;
    return (async () => {
      await Promise.all(gates.filter((g) => g.match(a)).map((g) => g.open));
      if (rejecting.has(a.accountId as string)) throw { code: "gmail", message: `Gmail refused ${a.accountId}` };
    })();
  });
});
afterEach(() => {
  clearMocks();
  useMailStore.setState({ reload: realReloadFn });
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

describe("pending changes and reloads", () => {
  const starredOf = () => useMailStore.getState().threads.map((t) => t.starred);

  test("a reload answered before the command commits doesn't bring archived rows back; settling releases them", async () => {
    useRealReload(["a1", "a2"]);
    const rows = [thread(1), thread(2), thread(3, "a2")];
    setList(rows);
    useUiStore.setState({ checked: [key(1), key(3, "a2")] });
    const release = hold();

    const done = archive();
    await reloadWith(rows); // the cache hasn't heard yet, so this still has all three
    expect(listKeys()).toEqual([key(2)]);
    await reloadWith(rows); // another account's event does the same
    expect(listKeys()).toEqual([key(2)]);

    release();
    await done;
    // Settled: the server side is the authority again.
    await reloadWith([thread(2)]);
    expect(listKeys()).toEqual([key(2)]);
    await reloadWith(rows);
    expect(listKeys()).toEqual(rows.map((t) => threadKey(t.accountId, t.id)));
  });

  test("a second s reads the optimistic star and unstars", async () => {
    useRealReload();
    setList([thread(1)]);
    useUiStore.setState({ openThread: key(1) });
    const release = hold();

    const first = toggleStar();
    await reloadWith([thread(1)]);
    expect(starredOf()).toEqual([true]);
    const second = toggleStar();
    await flush();
    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t1"], add: ["STARRED"], remove: [] },
      { accountId: "a1", threadIds: ["t1"], add: [], remove: ["STARRED"] },
    ]);
    release();
    await Promise.all([first, second]);
    expect(starredOf()).toEqual([false]);
  });

  test("opening an unread thread marks it read once even when a reload says it is still unread", async () => {
    useRealReload();
    setList([thread(1, "a1", { unread: true })]);
    const release = hold();

    openAndMarkRead(key(1));
    await reloadWith([thread(1, "a1", { unread: true })]);
    expect(useMailStore.getState().threads[0].unread).toBe(false);
    openAndMarkRead(key(1));
    release();
    await flush();
    expect(modifyCalls()).toHaveLength(1);
  });

  test("Undo is held the same way: a reload before it commits keeps the undone state, settling releases it", async () => {
    useRealReload();
    setList([thread(1)]);
    useUiStore.setState({ openThread: key(1) });
    await setStarred(true);
    expect(starredOf()).toEqual([true]);

    const release = hold();
    toasts()[0].action!.run();
    expect(starredOf()).toEqual([false]);
    await reloadWith([thread(1, "a1", { starred: true })]); // the server side still has the star
    expect(starredOf()).toEqual([false]);

    release();
    await flush();
    await reloadWith([thread(1, "a1", { starred: true })]);
    expect(starredOf()).toEqual([true]);
  });

  test("each account is released when its own command settles, not when the slowest does", async () => {
    useRealReload(["a1", "a2"]);
    const rows = [thread(1), thread(2, "a2")];
    setList(rows);
    useUiStore.setState({ checked: [key(1), key(2, "a2")] });
    const releaseB = hold((a) => a.accountId === "a2");

    const starring = setStarred(true);
    await flush(); // A's command has settled; B's is still pending
    await reloadWith(rows); // the server side has neither star
    expect(starredOf()).toEqual([false, true]); // A is released and shows it; B's star is still held

    // Unstar A while B is still pending: a reload must not bring A's older star back.
    useUiStore.setState({ openThread: key(1) });
    await setStarred(false);
    await reloadWith([thread(1, "a1", { starred: false }), thread(2, "a2")]);
    expect(useMailStore.getState().threads.map((t) => [threadKey(t.accountId, t.id), t.starred])).toEqual([
      [key(1), false],
      [key(2, "a2"), true], // B is held
    ]);

    releaseB();
    await starring;
    await reloadWith(rows);
    expect(starredOf()).toEqual([false, false]); // nothing held any more
  });

  test("archiving in the inbox doesn't hide the conversation in All Mail while the command is pending", async () => {
    useRealReload();
    const rows = [thread(1), thread(2)];
    setList(rows);
    useUiStore.setState({ openThread: key(1) });
    const release = hold();

    const done = archive();
    expect(listKeys()).toEqual([key(2)]);
    // Switch to All Mail: the cache still lists the thread there (it is only losing INBOX).
    useMailStore.setState({ query: { accountIds: ["a1"], labelId: "ALL" } });
    listPage = rows;
    await useMailStore.getState().load({ accountIds: ["a1"], labelId: "ALL" });
    expect(listKeys()).toEqual([key(1), key(2)]);
    await reloadWith(rows); // an event reload of All Mail
    expect(listKeys()).toEqual([key(1), key(2)]);

    // Back in the inbox the removal is still held until the command settles.
    await useMailStore.getState().load({ accountIds: ["a1"], labelId: "INBOX" });
    expect(listKeys()).toEqual([key(2)]);
    release();
    await done;
    await useMailStore.getState().load({ accountIds: ["a1"], labelId: "INBOX" });
    expect(listKeys()).toEqual([key(1), key(2)]);
  });

  test("a refusal releases the changes before it reloads, so the refused rows come back", async () => {
    useRealReload(["a1", "a2"]);
    listPage = [thread(2, "a2")]; // a1's thread is archived in the cache, a2's is not
    setList([thread(1), thread(2, "a2")]);
    useUiStore.setState({ checked: [key(1), key(2, "a2")] });
    rejecting.add("a2");
    await archive();
    await flush();
    expect(listKeys()).toEqual([key(2, "a2")]);
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

describe("unstarring in Starred", () => {
  test("takes the row out, opens the next one, and Undo brings it back", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "STARRED" }, openThread: key(1) });
    setList([thread(1, "a1", { starred: true }), thread(2, "a1", { starred: true })]);
    const done = setStarred(false);
    expect(listKeys()).toEqual([key(2)]);
    expect(useUiStore.getState().openThread).toBe(key(2));
    await done;
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1"], add: [], remove: ["STARRED"] }]);

    toasts()[0].action!.run();
    await flush();
    expect(modifyCalls()[1]).toMatchObject({ add: ["STARRED"], remove: [] });
    expect(reload).toHaveBeenCalled();
  });

  test("while the command is pending, All Mail shows it unstarred and s stars it again", async () => {
    useRealReload();
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "STARRED" }, openThread: key(1) });
    const starredRows = [thread(1, "a1", { starred: true }), thread(2, "a1", { starred: true })];
    setList(starredRows);
    const release = hold();

    const unstarring = setStarred(false);
    expect(listKeys()).toEqual([key(2)]);
    // Switch to All Mail: the cache still has the star, but the change is on its way.
    useMailStore.setState({ query: { accountIds: ["a1"], labelId: "ALL" } });
    await reloadWith(starredRows);
    expect(useMailStore.getState().threads.map((t) => [threadKey(t.accountId, t.id), t.starred])).toEqual([
      [key(1), false],
      [key(2), true],
    ]);

    useUiStore.setState({ openThread: key(1) });
    const starring = toggleStar();
    await flush();
    expect(modifyCalls().map((c) => [c.add, c.remove])).toEqual([[[], ["STARRED"]], [["STARRED"], []]]);
    release();
    await Promise.all([unstarring, starring]);
  });

  test("starring there keeps the row, and elsewhere unstarring keeps it too", async () => {
    setList([thread(1, "a1", { starred: true })]);
    useUiStore.setState({ openThread: key(1) });
    await setStarred(false);
    expect(listKeys()).toEqual([key(1)]);
    expect(useMailStore.getState().threads[0].starred).toBe(false);
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

  test.each([
    ["marking it unread", () => setRead(false, [key(1)]), { add: ["UNREAD"], remove: [] }],
    ["archiving it", () => archive([key(1)]), { add: [], remove: ["INBOX"] }],
  ])("%s while its detail is still loading cancels the automatic read", async (_, act, sent) => {
    let release!: () => void;
    detailGate = new Promise((resolve) => (release = resolve));
    setList([thread(1, "a1", { unread: true }), thread(2)]);
    openAndMarkRead(key(1));
    expect(useMailStore.getState().threads[0].unread).toBe(false);

    await act();
    release();
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === "get_thread").length).toBeGreaterThan(0));
    await flush();
    await flush();

    // Only the explicit change reaches Gmail; the older automatic read never follows it.
    expect(modifyCalls()).toEqual([{ accountId: "a1", threadIds: ["t1"], ...sent }]);
  });

  test("a mark-unread on another conversation leaves this one's automatic read alone", async () => {
    let release!: () => void;
    detailGate = new Promise((resolve) => (release = resolve));
    setList([thread(1, "a1", { unread: true }), thread(2)]);
    openAndMarkRead(key(1));
    await setRead(false, [key(2)]);
    release();
    await vi.waitFor(() => expect(modifyCalls()).toHaveLength(2));
    expect(modifyCalls()[1]).toEqual({ accountId: "a1", threadIds: ["t1"], add: [], remove: ["UNREAD"] });
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

  test("removing a label from more conversations than the detail cache holds still removes it", async () => {
    const count = 35;
    const rows = Array.from({ length: count }, (_, i) => thread(i));
    setList(rows);
    for (const row of rows) details[key(Number(row.id.slice(1)))] = detail(Number(row.id.slice(1)), ["INBOX", "Label_1"]);
    useUiStore.setState({ checked: rows.map((t) => threadKey(t.accountId, t.id)) });
    await toggleLabel("a1", "Label_1");
    expect(modifyCalls()).toHaveLength(1);
    expect(modifyCalls()[0]).toMatchObject({ add: [], remove: ["Label_1"] });
    expect(modifyCalls()[0].threadIds).toHaveLength(count);
  });

  test("the menu marks a label checked across a selection larger than the cache", async () => {
    const rows = Array.from({ length: 32 }, (_, i) => thread(i));
    setList(rows);
    for (let i = 0; i < 32; i++) details[key(i)] = detail(i, ["Label_1"]);
    useUiStore.setState({ checked: rows.map((t) => threadKey(t.accountId, t.id)) });
    await openLabelMenu({ x: 0, y: 0 });
    const [items] = vi.mocked(showContextMenu).mock.calls[0];
    expect(items.map((i) => (i.type === "separator" ? null : [i.label, i.checked]))).toEqual([
      ["Home", false],
      ["Work", true],
    ]);
  });

  test("the chip goes at once, stays gone across a second toggle, and a refusal puts it back", async () => {
    const original = detail(1, ["INBOX", "Label_1"]);
    details[key(1)] = original;
    setList([thread(1)]);
    cache(original);
    useUiStore.setState({ openThread: key(1) });
    const labelsNow = () => useThreadStore.getState().details.get(key(1))?.messages.flatMap((m) => m.labelIds);
    const release = hold();

    const removing = toggleLabel("a1", "Label_1");
    await flush();
    expect(labelsNow()).toEqual(["INBOX"]); // before the command has been applied
    // A second toggle sees the optimistic state, so it adds the label back.
    const adding = toggleLabel("a1", "Label_1");
    await flush();
    expect(modifyCalls().map((c) => [c.add, c.remove])).toEqual([[[], ["Label_1"]], [["Label_1"], []]]);
    expect(labelsNow()).toEqual(["INBOX", "Label_1"]);
    release();
    await Promise.all([removing, adding]);

    // A refusal: the cached conversation is refetched from the cache the backend still has.
    rejecting.add("a1");
    const releaseRefused = hold();
    const refused = toggleLabel("a1", "Label_1");
    await flush();
    expect(labelsNow()).toEqual(["INBOX"]); // optimistic remove
    releaseRefused();
    await refused;
    await flush();
    expect(calls.filter((c) => c.cmd === "get_thread").length).toBeGreaterThan(0);
    expect(labelsNow()).toEqual(["INBOX", "Label_1"]);
  });

  test("a refresh after one label action completes keeps the chip of a second, still pending, action", async () => {
    const withLabels = (ids: string[]) => detail(1, ids);
    details[key(1)] = withLabels(["INBOX", "Label_1", "Label_2"]);
    setList([thread(1)]);
    cache(details[key(1)]);
    useUiStore.setState({ openThread: key(1) });
    const labelsNow = () => useThreadStore.getState().details.get(key(1))?.messages.flatMap((m) => m.labelIds);
    const releaseSecond = hold((a) => (a.remove as string[]).includes("Label_2") || (a.add as string[]).includes("Label_2"));

    // Action 1 goes through; the cache now has Label_1 gone but not yet Label_2.
    await toggleLabel("a1", "Label_1");
    details[key(1)] = withLabels(["INBOX", "Label_2"]);
    const second = toggleLabel("a1", "Label_2"); // pending
    await flush();
    expect(labelsNow()).toEqual(["INBOX"]);

    // The refresh that action 1's event triggers lands now, still showing Label_2.
    useThreadStore.getState().evict("a1", ["t1"]);
    await useThreadStore.getState().load(key(1));
    expect(labelsNow()).toEqual(["INBOX"]);

    // So a second toggle of Label_2 sees it gone and sends an add.
    const third = toggleLabel("a1", "Label_2");
    await flush();
    expect(modifyCalls().map((c) => [c.add, c.remove])).toEqual([
      [[], ["Label_1"]],
      [[], ["Label_2"]],
      [["Label_2"], []],
    ]);
    releaseSecond();
    await Promise.all([second, third]);
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
