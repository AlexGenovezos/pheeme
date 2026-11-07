import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { LabelInfo } from "../lib/tauri";
import { threadKey } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetMailStoreForTests } from "../store/mailStore";
import { __resetThreadStoreForTests } from "../store/threadStore";
import { __resetUiStoreForTests } from "../store/uiStore";
import { openCreateLabel } from "./create";
import { openDeleteLabel, openLabelDialog, useLabelDialogStore } from "./dialogStore";
import { LabelDialogHost } from "./LabelDialog";
import { labelColor } from "./palette";

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

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let preview: unknown;
let failWith: { code: string; message: string } | null;
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const callsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetLabelStoreForTests();
  useAccountStore.setState({ accounts: [] });
  useLabelDialogStore.getState().close();
  useToastStore.setState({ toasts: [] });
  calls = [];
  preview = { threads: 312, sublabels: ["Clients/Acme"] };
  failWith = null;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (failWith && ["create_label", "update_label", "delete_label"].includes(cmd))
        throw failWith;
      if (cmd === "create_label") return label("Label_new", a.name as string);
      if (cmd === "update_label") return [];
      if (cmd === "delete_label_preview") return preview;
      return undefined;
    },
    { shouldMockEvents: true },
  );
  useLabelStore.setState({
    labels: {
      a1: [
        label("INBOX", "INBOX", { type: "system" }),
        label("Label_1", "Clients"),
        label("Label_2", "Clients/Acme"),
        label("Label_4", "Clients/Acme/Q1"),
        label("Label_3", "Receipts"),
      ],
    },
  });
});
afterEach(() => clearMocks());

const nameField = () => screen.getByLabelText("Name") as HTMLInputElement;
const parentSelect = () => screen.getByLabelText("Parent label") as HTMLSelectElement;
const nest = () => screen.getByRole("checkbox", { name: "Nest label under" });
const type = (v: string) => fireEvent.change(nameField(), { target: { value: v } });

test("create_sends_full_path", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1" }));
  expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();
  type("Acme2");
  fireEvent.click(nest());
  fireEvent.change(parentSelect(), { target: { value: "Clients" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
  expect(callsOf("create_label")).toEqual([
    { accountId: "a1", name: "Clients/Acme2", color: null },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("create_with_colour: Gmail's grid, none by default", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1" }));
  const grid = screen.getByRole("radiogroup", { name: "Colour" });
  const swatches = within(grid).getAllByRole("radio");
  expect(swatches).toHaveLength(64);
  expect(swatches.every((s) => s.getAttribute("aria-checked") === "false")).toBe(true);
  const none = screen.getByRole("button", { name: "No colour" });
  expect(none).toBeDisabled();

  type("Travel");
  const green = within(grid).getByRole("radio", { name: "#16a766" });
  fireEvent.click(green);
  expect(green).toHaveAttribute("aria-checked", "true");
  expect(none).toBeEnabled();
  // Arrow keys move between swatches inside the dialog without leaving it.
  fireEvent.keyDown(green, { key: "ArrowRight" });
  expect(within(grid).getByRole("radio", { name: "#43d692" })).toHaveFocus();
  expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
  expect(callsOf("create_label")).toEqual([
    { accountId: "a1", name: "Travel", color: labelColor("#16a766") },
  ]);
});

test("No colour takes a picked colour back off", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1", parent: "Clients" }));
  type("Globex");
  fireEvent.click(screen.getByRole("radio", { name: "#4a86e8" }));
  fireEvent.click(screen.getByRole("button", { name: "No colour" }));
  expect(screen.getByRole("radio", { name: "#4a86e8" })).toHaveAttribute("aria-checked", "false");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
  expect(callsOf("create_label")).toEqual([
    { accountId: "a1", name: "Clients/Globex", color: null },
  ]);
});

test("the edit dialog has no colour grid (the label's menu has Label colour…)", () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_2" }));
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

test("create_applies_to_the_given_threads", async () => {
  render(<LabelDialogHost />);
  act(() =>
    openLabelDialog({
      mode: "create",
      accountId: "a1",
      name: "Travel",
      applyTo: [threadKey("a1", "t1")],
    }),
  );
  expect(nameField().value).toBe("Travel");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
  expect(callsOf("modify_threads")).toEqual([
    { accountId: "a1", threadIds: ["t1"], add: ["Label_new"], remove: [] },
  ]);
});

test("a slash in the prefilled name splits parent and leaf", () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1", name: "Clients/Globex" }));
  expect(nameField().value).toBe("Globex");
  expect(nest()).toBeChecked();
  expect(parentSelect().value).toBe("Clients");
});

test("invalid and duplicate names are refused before asking Gmail", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1" }));
  type("a//b");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  type("receipts");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("alert")).toHaveTextContent('A label named "receipts" already exists.');
  await flush();
  expect(callsOf("create_label")).toEqual([]);
});

test("edit_prefills_and_excludes_descendants", () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_2" }));
  expect(screen.getByRole("dialog", { name: "Edit label" })).toBeInTheDocument();
  expect(nameField().value).toBe("Acme");
  expect(nest()).toBeChecked();
  expect(parentSelect().value).toBe("Clients");
  const options = [...parentSelect().options].map((o) => o.value);
  expect(options).toEqual(["Clients", "Receipts"]);
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
});

const names = () => useLabelStore.getState().labels.a1.map((l) => l.name);

test("edit sends the new full path, renaming at once", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_2" }));
  fireEvent.click(nest()); // un-nest
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  // The dialog doesn't wait for Gmail; the label and its sublabels show their new paths straight away.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(names()).toEqual(["INBOX", "Clients", "Acme", "Acme/Q1", "Receipts"]);
  await flush();
  expect(callsOf("update_label")).toEqual([
    { accountId: "a1", labelId: "Label_2", edit: { name: "Acme" } },
  ]);
  expect(names()).toEqual(["INBOX", "Clients", "Acme", "Acme/Q1", "Receipts"]);
});

test("a rename Gmail refuses goes back and says why in a toast", async () => {
  failWith = { code: "gmail", message: "Gmail is unreachable" };
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_1" }));
  type("Customers");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(names()).toContain("Customers/Acme/Q1");
  await flush();
  expect(names()).toEqual(["INBOX", "Clients", "Clients/Acme", "Clients/Acme/Q1", "Receipts"]);
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Gmail is unreachable"]);
});

test("server_error_shown_inline_and_dialog_stays", async () => {
  failWith = { code: "gmail", message: "Gmail is unreachable" };
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "create", accountId: "a1" }));
  type("Travel");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
  expect(screen.getByRole("alert")).toHaveTextContent("Gmail is unreachable");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("esc_closes_and_restores_focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  render(<LabelDialogHost />);
  act(() => openCreateLabel("a1"));
  expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();
  expect(nameField()).toHaveFocus();
  fireEvent.keyDown(nameField(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
  opener.remove();
});

test("delete_copy_with_count_and_sublabels", async () => {
  render(<LabelDialogHost />);
  act(() => openDeleteLabel("a1", "Label_1"));
  // Before Gmail's count arrives: the sublabels from the cached labels, no count.
  expect(
    screen.getByText(
      "The conversations themselves aren't deleted. Its 2 sublabels are deleted too.",
    ),
  ).toBeInTheDocument();
  await flush();
  expect(screen.getByRole("dialog", { name: 'Delete "Clients"?' })).toBeInTheDocument();
  expect(
    screen.getByText(
      "It comes off 312 conversations. The conversations themselves aren't deleted. Its 1 sublabel is deleted too.",
    ),
  ).toBeInTheDocument();
});

test("delete_copy_without_count", async () => {
  preview = { threads: null, sublabels: ["Clients/Acme", "Clients/Acme/Q1"] };
  render(<LabelDialogHost />);
  act(() => openDeleteLabel("a1", "Label_1"));
  await flush();
  expect(
    screen.getByText(
      "The conversations themselves aren't deleted. Its 2 sublabels are deleted too.",
    ),
  ).toBeInTheDocument();
});

test("delete confirms through deleteLabel; failure stays inline", async () => {
  render(<LabelDialogHost />);
  act(() => openDeleteLabel("a1", "Label_3"));
  await flush();
  failWith = { code: "gmail", message: "Offline" };
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await flush();
  expect(screen.getByRole("alert")).toHaveTextContent("Offline");
  failWith = null;
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await flush();
  expect(callsOf("delete_label")).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the edited label disappearing while the dialog is open never creates a new one", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_3" }));
  // Deleted elsewhere (another device, the sidebar) while the dialog is open.
  act(() =>
    useLabelStore.setState((s) => ({
      labels: { a1: s.labels.a1.filter((l) => l.id !== "Label_3") },
    })),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("This label no longer exists.");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  type("Receipts 2");
  fireEvent.submit(save.closest("form")!);
  await flush();
  expect(callsOf("create_label")).toEqual([]);
  expect(callsOf("update_label")).toEqual([]);
});

test("Delete works at once while Gmail's count is still coming, and the count fills in later", async () => {
  let answer: (p: unknown) => void = () => {};
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "delete_label_preview") return new Promise((resolve) => (answer = resolve));
      return undefined;
    },
    { shouldMockEvents: true },
  );
  render(<LabelDialogHost />);
  act(() => openDeleteLabel("a1", "Label_2"));
  expect(
    screen.getByText("The conversations themselves aren't deleted. Its 1 sublabel is deleted too."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

  await act(async () => answer({ threads: 4, sublabels: ["Clients/Acme/Q1"] }));
  expect(
    screen.getByText(
      "It comes off 4 conversations. The conversations themselves aren't deleted. Its 1 sublabel is deleted too.",
    ),
  ).toBeInTheDocument();

  // A preview that never answers doesn't hold up the delete.
  act(() => useLabelDialogStore.getState().close());
  act(() => openDeleteLabel("a1", "Label_3"));
  expect(screen.getByText("The conversations themselves aren't deleted.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await flush();
  expect(callsOf("delete_label")).toEqual([{ accountId: "a1", labelId: "Label_3" }]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
