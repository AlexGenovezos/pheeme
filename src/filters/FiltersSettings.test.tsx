import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { FilterEntry } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useFilterEditorStore } from "./editorStore";
import { FiltersSettings } from "./FiltersSettings";
import { EMPTY_SPEC } from "./form";

let filters: Record<string, FilterEntry[]>;
let deleted: unknown[];
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  deleted = [];
  filters = {
    a1: [
      {
        id: "f1",
        matches: "from:news@x.com",
        actions: ["skip the inbox (archive it)", "star it"],
        spec: { ...EMPTY_SPEC, from: "news@x.com", skipInbox: true, star: true },
      },
      {
        id: "f2",
        matches: "subject:(Big sale)",
        actions: ["apply label A", "apply label B"],
        spec: null,
      },
    ],
  };
  useFilterEditorStore.getState().close();
  useToastStore.setState({ toasts: [] });
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "one@example.com" } as never,
      { id: "a2", email: "old@example.com" } as never,
    ],
  });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, string>;
    if (cmd === "list_filters") {
      if (a.accountId === "a2") throw { code: "missing_scope", message: "Insufficient Permission" };
      return filters[a.accountId];
    }
    if (cmd === "delete_filter") {
      deleted.push(a);
      return undefined;
    }
    return undefined;
  });
});
afterEach(() => clearMocks());

test("lists each account's filters in words, edits and deletes them", async () => {
  render(<FiltersSettings />);
  await flush();

  expect(screen.getByText("from:news@x.com")).toBeTruthy();
  expect(screen.getByText("Skip the inbox (archive it), star it")).toBeTruthy();
  expect(screen.getByText("Pheeme can't see this account's Gmail filters")).toBeTruthy();

  // One the form can't show can't be edited here, but can be deleted.
  const editOther = screen.getByRole("button", { name: "Edit the filter subject:(Big sale)" });
  expect(editOther).toHaveProperty("disabled", true);

  fireEvent.click(screen.getByRole("button", { name: "Edit the filter from:news@x.com" }));
  expect(useFilterEditorStore.getState().editor).toMatchObject({
    accountId: "a1",
    filterId: "f1",
    spec: { from: "news@x.com", star: true },
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete the filter from:news@x.com" }));
  await flush();
  expect(deleted).toEqual([{ accountId: "a1", filterId: "f1" }]);
  expect(screen.queryByText("from:news@x.com")).toBeNull();
  expect(useToastStore.getState().toasts[0]).toMatchObject({
    title: "Filter deleted",
    action: { label: "Undo" },
  });
});
