import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { LabelInfo, MessageDetail, ThreadDetail, ThreadSummary } from "../lib/tauri";
import { openLabelMenu, openMoveMenu } from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { openCreateLabel } from "./create";
import { LabelPickerHost } from "./LabelPicker";
import { LabelDialogHost } from "./LabelDialog";
import { useLabelDialogStore } from "./dialogStore";
import { usePickerStore } from "./pickerStore";
import { revealLabels } from "./reveal";

vi.mock("./reveal", () => ({ revealLabels: vi.fn() }));

const label = (id: string, name: string, over: Partial<LabelInfo> = {}): LabelInfo => ({
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
const detail = (n: number, labelIds: string[]): ThreadDetail => ({
  thread: thread(n),
  messages: [{ id: `m${n}`, threadId: `t${n}`, labelIds } as MessageDetail],
  bodyError: null,
});

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
const modifyCalls = () => calls.filter((c) => c.cmd === "modify_threads").map((c) => c.args);
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetLabelStoreForTests();
  useAccountStore.setState({ accounts: [] });
  usePickerStore.getState().close();
  useLabelDialogStore.getState().close();
  useToastStore.setState({ toasts: [] });
  vi.mocked(revealLabels).mockClear();
  calls = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (cmd === "create_label")
        return label("Label_new", a.name as string, { accountId: a.accountId as string });
      if (cmd === "list_threads") return { threads: useMailStore.getState().threads, next: null };
      return undefined;
    },
    { shouldMockEvents: true },
  );
  useMailStore.setState({ reload: vi.fn(async () => {}), threads: [thread(1), thread(2)] });
  useLabelStore.setState({
    labels: {
      a1: [
        label("INBOX", "INBOX", { type: "system" }),
        label("Label_1", "Clients"),
        label("Label_2", "Clients/Acme", { colorBackground: "#16a766", colorText: "#ffffff" }),
        label("Label_3", "Receipts"),
      ],
    },
  });
  useThreadStore.setState({
    details: new Map([
      [key(1), detail(1, ["INBOX", "Label_3"])],
      [key(2), detail(2, ["INBOX"])],
    ]),
  });
});
afterEach(() => clearMocks());

const options = () => screen.getAllByRole("option");
const optionNames = () => options().map((o) => o.textContent);
const option = (name: string) => screen.getByRole("option", { name });
const input = () => screen.getByRole("combobox");
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });
/**
 * A click as a browser makes it (user-event isn't a dependency): pointer and mouse down, where an unprevented
 * mousedown on something that can't take focus moves focus off the search field, then up and click.
 */
function realClick(el: HTMLElement) {
  fireEvent.pointerDown(el);
  if (fireEvent.mouseDown(el)) (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.pointerUp(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}
/** A key pressed wherever focus is now. */
const pressFocused = (key: string) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key });

async function openForBoth() {
  useUiStore.setState({ checked: [key(1), key(2)] });
  render(<LabelPickerHost />);
  await act(() => openLabelMenu({ x: 10, y: 20 }));
}

describe("Label as…", () => {
  test("filters_on_full_path", async () => {
    await openForBoth();
    expect(screen.getByRole("dialog", { name: "Label as" })).toHaveAttribute("data-owns-keys");
    expect(input()).toHaveFocus();
    type("acm");
    // The sublabel matches on its full path; long names truncate with the path in the title.
    expect(optionNames()).toEqual(["Clients/Acme", 'Create "acm"…', "Manage labels"]);
    expect(option("Clients/Acme")).toHaveAttribute("title", "Clients/Acme");
    type("CLIENTS");
    expect(optionNames()).toEqual(["Clients", "Clients/Acme", "Manage labels"]);
    type("ents/ac");
    expect(optionNames()).toEqual(["Clients/Acme", 'Create "ents/ac"…', "Manage labels"]);
  });

  test("lists labels as a tree by leaf name; a search match shows its dimmed parent path", async () => {
    useLabelStore.setState((s) => ({
      labels: { a1: [...s.labels.a1, label("Label_5", "Travel/2026")] },
    }));
    await openForBoth();
    // Travel isn't a label: its sublabel shows the path from the top, not stepped in.
    expect(optionNames()).toEqual(["Clients", "Acme", "Receipts", "Travel/2026", "Manage labels"]);
    const depth = (name: string) => option(name).style.getPropertyValue("--label-depth");
    expect(depth("Clients/Acme")).toBe("1");
    expect(depth("Travel/2026")).toBe("");

    type("acm");
    const match = option("Clients/Acme");
    expect(match.querySelector(".label-picker__context")).toHaveTextContent("Clients/");
    expect(depth("Clients/Acme")).toBe("");
  });

  test("tri_state_ticks", async () => {
    await openForBoth();
    expect(option("Receipts")).toHaveAttribute("aria-checked", "mixed");
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");
  });

  test("ticking_some_adds_to_all and the picker stays open with its ticks updated", async () => {
    await openForBoth();
    fireEvent.click(option("Receipts"));
    await flush();
    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t1", "t2"], add: ["Label_3"], remove: [] },
    ]);
    expect(option("Receipts")).toHaveAttribute("aria-checked", "true");

    // Ticking a label every conversation has takes it off them all.
    press("ArrowUp"); // Clients/Acme
    press("ArrowDown"); // back to Receipts, the row clicked
    press("Enter");
    await flush();
    expect(modifyCalls()[1]).toEqual({
      accountId: "a1",
      threadIds: ["t1", "t2"],
      add: [],
      remove: ["Label_3"],
    });
    expect(option("Receipts")).toHaveAttribute("aria-checked", "false");
  });

  test("create_row_opens_the_dialog_with_the_pickers_targets", async () => {
    await openForBoth();
    type("  Clients/Globex ");
    expect(options()[0]).toHaveTextContent('Create "Clients/Globex"…');
    press("Enter");
    expect(screen.queryByRole("dialog", { name: "Label as" })).toBeNull();
    const dialog = useLabelDialogStore.getState().dialog;
    expect(dialog).toMatchObject({
      kind: "label",
      spec: {
        mode: "create",
        accountId: "a1",
        name: "Clients/Globex",
        applyTo: [key(1), key(2)],
        move: false,
      },
    });
    expect(calls.find((c) => c.cmd === "create_label")).toBeUndefined();
  });

  describe.each([
    ["Escape", () => fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" })],
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
  ])("picker -> Create -> %s", (_name, dismiss) => {
    test("focus returns to the original opener", async () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      render(<LabelDialogHost />);
      await openForBoth();
      type("Travel");
      press("Enter");
      expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();
      dismiss();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
      opener.remove();
    });
  });

  test("an exact match (any case) offers no create row", async () => {
    await openForBoth();
    type("receipts");
    expect(optionNames()).toEqual(["Receipts", "Manage labels"]);
  });

  test("Manage labels reveals the sidebar labels; Esc and outside clicks close", async () => {
    await openForBoth();
    fireEvent.click(option("Manage labels"));
    expect(revealLabels).toHaveBeenCalledTimes(1);
    expect(revealLabels).toHaveBeenCalledWith("a1"); // the picker's account, whatever the sidebar shows
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(() => openLabelMenu({ x: 0, y: 0 }));
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(() => openLabelMenu({ x: 0, y: 0 }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("Create label… opens the new-label dialog", () => {
  act(() => openCreateLabel("a1"));
  expect(useLabelDialogStore.getState().dialog).toMatchObject({
    kind: "label",
    spec: { mode: "create", accountId: "a1" },
  });
  expect(usePickerStore.getState().spec).toBeNull();
});

describe("after a click", () => {
  test("focus stays in the search field, so the keys still drive the picker", async () => {
    await openForBoth();
    realClick(option("Receipts"));
    await flush();
    expect(option("Receipts")).toHaveAttribute("aria-checked", "true");
    expect(input()).toHaveFocus();

    // The clicked row is the active one, so the arrows go on from there.
    pressFocused("ArrowUp"); // Clients/Acme
    pressFocused("Enter");
    await flush();
    expect(modifyCalls().map((c) => c.add)).toEqual([["Label_3"], ["Label_2"]]);
    pressFocused("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a tick Gmail refuses goes back, and ticking again sends the add again", async () => {
    let refuse = true;
    // A refusal reloads the labels from the backend, which still has them.
    const labels = useLabelStore.getState().labels.a1;
    useAccountStore.setState({
      accounts: [
        { id: "a1", email: "a@example.com", displayName: null, clientId: "c", synced: true },
      ],
    });
    mockIPC(
      (cmd, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args: a });
        if (cmd === "modify_threads" && refuse) throw { code: "gmail", message: "Gmail refused" };
        if (cmd === "list_labels") return labels;
        if (cmd === "list_threads") return { threads: useMailStore.getState().threads, next: null };
        return undefined;
      },
      { shouldMockEvents: true },
    );
    await openForBoth();
    realClick(option("Receipts"));
    await flush();
    expect(useToastStore.getState().toasts[0].title).toBe("Gmail refused");
    expect(option("Receipts")).toHaveAttribute("aria-checked", "mixed");

    refuse = false;
    realClick(option("Receipts"));
    await flush();
    expect(modifyCalls().map((c) => [c.add, c.remove])).toEqual([
      [["Label_3"], []],
      [["Label_3"], []],
    ]);
    expect(option("Receipts")).toHaveAttribute("aria-checked", "true");
  });

  test("a second click while the first tick is pending is ignored, so two refusals leave it unticked", async () => {
    const releases: Array<() => void> = [];
    // A refusal reloads the labels from the backend, which still has them.
    const labels = useLabelStore.getState().labels.a1;
    useAccountStore.setState({
      accounts: [
        { id: "a1", email: "a@example.com", displayName: null, clientId: "c", synced: true },
      ],
    });
    let refuse = true;
    mockIPC(
      (cmd, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args: a });
        if (cmd === "list_labels") return labels;
        if (cmd === "list_threads") return { threads: useMailStore.getState().threads, next: null };
        if (cmd !== "modify_threads") return undefined;
        return new Promise<void>((resolve, reject) =>
          releases.push(() =>
            refuse ? reject({ code: "gmail", message: "Gmail refused" }) : resolve(),
          ),
        );
      },
      { shouldMockEvents: true },
    );
    await openForBoth();
    realClick(option("Clients"));
    realClick(option("Clients"));
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "true");
    expect(option("Clients")).toHaveAttribute("aria-disabled", "true");
    expect(modifyCalls()).toHaveLength(1);

    releases.forEach((release) => release());
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");
    expect(option("Clients")).not.toHaveAttribute("aria-disabled");

    // Once it has settled the row works again, and ticking it sends the add again.
    refuse = false;
    realClick(option("Clients"));
    await flush();
    releases.slice(1).forEach((release) => release());
    await flush();
    expect(modifyCalls().map((c) => [c.add, c.remove])).toEqual([
      [["Label_1"], []],
      [["Label_1"], []],
    ]);
    expect(option("Clients")).toHaveAttribute("aria-checked", "true");
  });

  test("a change Gmail refuses after it was queued goes back, keeping ticks still in flight", async () => {
    // What the backend holds: the queued Clients add has been rolled back after Gmail refused it.
    const backend = new Map([
      ["t1", ["INBOX", "Label_3"]],
      ["t2", ["INBOX"]],
    ]);
    let releaseAcme: () => void = () => {};
    mockIPC(
      (cmd, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args: a });
        if (cmd === "get_thread") {
          const n = Number(String(a.threadId).slice(1));
          return detail(n, backend.get(`t${n}`) ?? []);
        }
        if (cmd === "list_threads") return { threads: useMailStore.getState().threads, next: null };
        if (cmd === "modify_threads" && (a.add as string[])[0] === "Label_2")
          return new Promise<void>((resolve) => (releaseAcme = resolve));
        return undefined;
      },
      { shouldMockEvents: true },
    );
    await openForBoth();
    realClick(option("Clients"));
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "true");
    realClick(option("Clients/Acme")); // still on its way when the refusal arrives
    await flush();

    await act(() =>
      emit("outbox:rejected", { accountId: "a1", opId: "op1", kind: "modify", message: "no" }),
    );
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");
    expect(option("Clients/Acme")).toHaveAttribute("aria-checked", "true");
    expect(option("Receipts")).toHaveAttribute("aria-checked", "mixed");

    // Events for another account leave the picker alone.
    backend.set("t2", ["INBOX", "Label_1"]);
    await act(() =>
      emit("sync:messages_updated", { accountId: "a2", added: [], removed: [], modified: [] }),
    );
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");
    releaseAcme();
    await flush();
  });

  test("when re-reads overlap, a slower older one doesn't overwrite the newer", async () => {
    const held: Array<() => void> = [];
    let reads = 0;
    mockIPC(
      (cmd, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args: a });
        if (cmd !== "get_thread") return undefined;
        const n = Number(String(a.threadId).slice(1));
        // The first re-read (two threads) sees Clients on both and answers late; the second sees none.
        if (reads++ < 2)
          return new Promise((resolve) =>
            held.push(() => resolve(detail(n, ["INBOX", "Label_1"]))),
          );
        return detail(n, ["INBOX"]);
      },
      { shouldMockEvents: true },
    );
    await openForBoth();
    const updated = { accountId: "a1", added: [], removed: [], modified: ["t1"] };
    await act(() => emit("sync:messages_updated", updated));
    await act(() => emit("sync:messages_updated", updated));
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");

    held.forEach((release) => release());
    await flush();
    expect(option("Clients")).toHaveAttribute("aria-checked", "false");
  });

  test("unticking the label being viewed takes the rows out, and later ticks still reach them", async () => {
    useLabelStore.setState((s) => ({ labels: { a1: [...s.labels.a1, label("Label_4", "Work")] } }));
    useThreadStore.setState({
      details: new Map([
        [key(1), detail(1, ["Label_4"])],
        [key(2), detail(2, ["Label_4"])],
      ]),
    });
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "Label_4" } });
    await openForBoth();
    realClick(option("Work"));
    await flush();
    expect(useMailStore.getState().threads).toEqual([]); // they left Work
    expect(option("Work")).toHaveAttribute("aria-checked", "false");

    realClick(option("Receipts"));
    await flush();
    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t1", "t2"], add: [], remove: ["Label_4"] },
      { accountId: "a1", threadIds: ["t1", "t2"], add: ["Label_3"], remove: [] },
    ]);
    expect(option("Receipts")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Move to…", () => {
  test("lists Inbox, the labels and Trash without ticks, leaving out where the mail is", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "Label_3" }, checked: [key(1)] });
    render(<LabelPickerHost />);
    act(() => openMoveMenu({ x: 0, y: 0 }));
    expect(screen.getByRole("dialog", { name: "Move to" })).toBeInTheDocument();
    expect(optionNames()).toEqual(["Inbox", "Clients", "Acme", "Trash", "Manage labels"]);
    expect(option("Clients")).not.toHaveAttribute("aria-checked");

    fireEvent.click(option("Clients/Acme"));
    await flush();
    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t1"], add: ["Label_2"], remove: ["Label_3"] },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Trash uses the existing trash action", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "INBOX" }, checked: [key(1)] });
    render(<LabelPickerHost />);
    act(() => openMoveMenu({ x: 0, y: 0 }));
    expect(optionNames()[0]).toBe("Clients"); // already in the Inbox
    type("tra");
    press("Enter");
    await flush();
    expect(calls.filter((c) => c.cmd === "trash_threads").map((c) => c.args)).toEqual([
      { accountId: "a1", threadIds: ["t1"] },
    ]);
  });
});
