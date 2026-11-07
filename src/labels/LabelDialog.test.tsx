import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

test("edit sends the new full path", async () => {
  render(<LabelDialogHost />);
  act(() => openLabelDialog({ mode: "edit", accountId: "a1", labelId: "Label_2" }));
  fireEvent.click(nest()); // un-nest
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await flush();
  expect(callsOf("update_label")).toEqual([
    { accountId: "a1", labelId: "Label_2", edit: { name: "Acme" } },
  ]);
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
  expect(screen.getByText("Counting conversations…")).toBeInTheDocument();
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
