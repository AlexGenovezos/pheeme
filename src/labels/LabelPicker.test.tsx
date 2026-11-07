import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { LabelInfo, MessageDetail, ThreadDetail, ThreadSummary } from "../lib/tauri";
import { openLabelMenu, openMoveMenu } from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { openCreateLabel } from "./create";
import { LabelPickerHost } from "./LabelPicker";
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
  ...over,
});
const key = (n: number) => threadKey("a1", `t${n}`);
const detail = (n: number, labelIds: string[]): ThreadDetail => ({
  thread: thread(n),
  messages: [{ id: `m${n}`, threadId: `t${n}`, labelIds } as MessageDetail],
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
  usePickerStore.getState().close();
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
    press("ArrowDown"); // Clients/Acme
    press("ArrowDown"); // Receipts
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

  test("create_row_creates_then_applies", async () => {
    await openForBoth();
    type("  Clients/Globex ");
    expect(options()[0]).toHaveTextContent('Create "Clients/Globex"…');
    press("Enter");
    await flush();
    expect(calls.find((c) => c.cmd === "create_label")?.args).toEqual({
      accountId: "a1",
      name: "Clients/Globex",
      color: null,
    });
    expect(modifyCalls()).toEqual([
      { accountId: "a1", threadIds: ["t1", "t2"], add: ["Label_new"], remove: [] },
    ]);
    // The new label is listed (ticked) straight away.
    type("");
    expect(option("Clients/Globex")).toHaveAttribute("aria-checked", "true");
  });

  test("a create Gmail refuses shows its message and applies nothing", async () => {
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "create_label") throw { code: "gmail", message: "Gmail is unreachable" };
      return undefined;
    });
    await openForBoth();
    type("Travel");
    press("Enter");
    await flush();
    expect(useToastStore.getState().toasts[0].title).toBe("Gmail is unreachable");
    expect(modifyCalls()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(() => openLabelMenu({ x: 0, y: 0 }));
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(() => openLabelMenu({ x: 0, y: 0 }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("Create label… with nothing selected only creates", async () => {
  render(<LabelPickerHost />);
  act(() => openCreateLabel("a1"));
  expect(screen.getByRole("dialog", { name: "Create label" })).toBeInTheDocument();
  expect(optionNames()).toEqual(["Manage labels"]);
  type("Travel");
  expect(optionNames()).toEqual(['Create "Travel"…', "Manage labels"]);
  press("Enter");
  await flush();
  expect(calls.find((c) => c.cmd === "create_label")?.args).toMatchObject({ name: "Travel" });
  expect(modifyCalls()).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useToastStore.getState().toasts[0].title).toBe('Created "Travel"');
  expect(
    useLabelStore
      .getState()
      .userLabels("a1")
      .map((l) => l.name),
  ).toContain("Travel");
});

describe("Move to…", () => {
  test("lists Inbox, the labels and Trash without ticks, leaving out where the mail is", async () => {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId: "Label_3" }, checked: [key(1)] });
    render(<LabelPickerHost />);
    act(() => openMoveMenu({ x: 0, y: 0 }));
    expect(screen.getByRole("dialog", { name: "Move to" })).toBeInTheDocument();
    expect(optionNames()).toEqual(["Inbox", "Clients", "Clients/Acme", "Trash", "Manage labels"]);
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
