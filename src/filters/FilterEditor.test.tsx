import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests } from "../store/labelStore";
import { openFilterEditor, useFilterEditorStore } from "./editorStore";
import { FilterEditorHost } from "./FilterEditor";
import { EMPTY_SPEC } from "./form";

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let forwarding: string[];
let applyError: string | null;
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const callsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeEach(() => {
  __resetLabelStoreForTests();
  useAccountStore.setState({ accounts: [{ id: "a1", email: "me@example.com" } as never] });
  useFilterEditorStore.getState().close();
  useToastStore.setState({ toasts: [] });
  calls = [];
  forwarding = [];
  applyError = null;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "forwarding_addresses") return forwarding;
    if (cmd === "filter_matches") return 4;
    if (cmd === "create_filter")
      return {
        filter: { id: "f9", matches: "from:a@x.com", actions: ["star it"], spec: a.spec },
        applyError: applyError,
      };
    return undefined;
  });
});
afterEach(() => clearMocks());

test("every field is there from the start; conditional ones wait for their tick", async () => {
  render(<FilterEditorHost />);
  act(() => openFilterEditor({ accountId: "a1", spec: { from: "a@x.com" } }));
  await flush();

  expect(screen.getByLabelText("From")).toHaveProperty("value", "a@x.com");
  const label = screen.getByRole("combobox", { name: "Label to apply" });
  const newName = screen.getByLabelText("New label name");
  const category = screen.getByRole("combobox", { name: "Category" });
  expect(label).toHaveProperty("disabled", true);
  expect(newName).toHaveProperty("disabled", true);
  expect(category).toHaveProperty("disabled", true);

  fireEvent.click(screen.getByLabelText("Apply the label:"));
  fireEvent.click(screen.getByLabelText("Categorize as:"));
  // The same elements, now enabled: nothing was added or moved.
  expect(screen.getByRole("combobox", { name: "Label to apply" })).toBe(label);
  expect(label).toHaveProperty("disabled", false);
  expect(category).toHaveProperty("disabled", false);
  expect(newName).toHaveProperty("disabled", true);

  // No verified forwarding address: Forward stays off, and says why.
  expect(screen.getByLabelText("Forward it to:")).toHaveProperty("disabled", true);
  expect(screen.getByText(/verify a forwarding address in Gmail/)).toBeTruthy();
});

test("creates the filter, applies it to existing mail when asked, and reports back", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const onSaved = vi.fn();
  render(<FilterEditorHost />);
  act(() => openFilterEditor({ accountId: "a1", spec: { from: "a@x.com" }, onSaved }));
  await flush();

  const existing = screen.getByLabelText(/Also apply filter to/);
  expect(existing).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByLabelText("Star it"));
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(screen.getByText("Also apply filter to 4 matching conversations.")).toBeTruthy();
  expect(existing).toHaveProperty("disabled", false);
  fireEvent.click(existing);
  fireEvent.click(screen.getByRole("button", { name: "Create filter" }));
  await flush();
  vi.useRealTimers();

  expect(callsOf("create_filter")).toEqual([
    {
      accountId: "a1",
      spec: { ...EMPTY_SPEC, from: "a@x.com", star: true },
      applyToExisting: true,
    },
  ]);
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "f9" }), undefined);
  expect(useFilterEditorStore.getState().editor).toBeNull();
});

test("a refusal shows in the slot kept for it, and the dialog stays open", async () => {
  render(<FilterEditorHost />);
  act(() => openFilterEditor({ accountId: "a1", spec: { from: "a@x.com" } }));
  await flush();
  const slot = screen.getByRole("alert");
  expect(slot.textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Create filter" }));
  await flush();
  expect(screen.getByRole("alert")).toBe(slot);
  expect(slot.textContent).toBe("Choose at least one thing to do with matching mail.");
  expect(callsOf("create_filter")).toEqual([]);
});

test("a filter saved but not applied to existing mail says both", async () => {
  applyError = "Gmail's search didn't answer, so nothing was changed. Try again.";
  const onSaved = vi.fn();
  render(<FilterEditorHost />);
  act(() => openFilterEditor({ accountId: "a1", spec: { from: "a@x.com" }, onSaved }));
  await flush();
  fireEvent.click(screen.getByLabelText("Star it"));
  fireEvent.click(screen.getByRole("button", { name: "Create filter" }));
  await flush();
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "f9" }), undefined);
  expect(useToastStore.getState().toasts[0]).toMatchObject({
    title: "Filter created, but it couldn't be applied to existing mail",
    tone: "danger",
  });
  expect(useFilterEditorStore.getState().editor).toBeNull();
});
