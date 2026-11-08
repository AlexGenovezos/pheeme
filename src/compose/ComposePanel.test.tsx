import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { ComposeHost } from "./ComposeHost";
import { __resetComposeSettingsForTests, useComposeSettings } from "./composeSettings";
import { __resetComposeStoreForTests, useComposeStore } from "./composeStore";

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

beforeEach(() => {
  localStorage.clear();
  __resetComposeSettingsForTests();
  __resetComposeStoreForTests();
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "me@example.com", displayName: null, clientId: "c", synced: true },
      { id: "a2", email: "me@example.org", displayName: null, clientId: "c", synced: true },
    ],
  });
  calls = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "send_email") return { opId: "op1", sendAt: Date.now() + 5000 };
    if (cmd === "save_draft") return { draftId: "d1", messageId: "m1", threadId: "t1" };
    return undefined;
  });
});

const renderHost = () =>
  render(
    <ToastProvider>
      <ComposeHost />
    </ToastProvider>,
  );

async function openNew() {
  renderHost();
  act(() => void useComposeStore.getState().compose("a1"));
  // The panel lazy-loads the editor; slow CI runners can take over findBy's default 1 s.
  return screen.findByRole("region", { name: "New message" }, { timeout: 5000 });
}

test("typed addresses become chips; Backspace takes the last one back to edit", async () => {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "Mira <mira@example.com>" } });
  fireEvent.keyDown(to, { key: "Enter" });
  fireEvent.change(to, { target: { value: "bo@x.test" } });
  fireEvent.keyDown(to, { key: "," });
  const chips = within(panel).getByRole("list", { name: "To recipients" });
  expect(within(chips).getByRole("button", { name: "Edit Mira" })).toBeInTheDocument();
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual([
    "mira@example.com",
    "bo@x.test",
  ]);
  fireEvent.keyDown(to, { key: "Backspace" });
  expect(to).toHaveValue("bo@x.test");
  expect(useComposeStore.getState().windows[0].draft.to).toHaveLength(1);
});

const PEOPLE = [
  { name: "Mira Tan", address: "mira@example.com" },
  { name: null, address: "mira.k@example.net" },
];

function suggestPeople() {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "suggest_contacts") return PEOPLE;
    return undefined;
  });
}

test("typing suggests people; arrows move, Enter picks with the name", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mir" } });
  const list = await within(panel).findByRole("listbox", { name: "Suggested To recipients" });
  expect(calls.find((c) => c.cmd === "suggest_contacts")?.args).toMatchObject({
    accountId: "a1",
    query: "mir",
  });
  const options = within(list).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "Mira Tanmira@example.com",
    "mira.k@example.net",
  ]);
  expect(to).toHaveAttribute("aria-activedescendant", options[0].id);
  fireEvent.keyDown(to, { key: "ArrowDown" });
  expect(to).toHaveAttribute("aria-activedescendant", options[1].id);
  fireEvent.keyDown(to, { key: "ArrowUp" });
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to).toEqual([
    { name: "Mira Tan", address: "mira@example.com" },
  ]);
  expect(to).toHaveValue("");
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
});

test("people already added aren't suggested again, and clicking one adds it", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  await within(panel).findByRole("listbox");
  fireEvent.keyDown(to, { key: "Enter" });
  // A whole typed address goes in as typed, with the suggestion's name.
  expect(useComposeStore.getState().windows[0].draft.to).toEqual([
    { name: "Mira Tan", address: "mira@example.com" },
  ]);
  fireEvent.change(to, { target: { value: "mi" } });
  const list = await within(panel).findByRole("listbox");
  const options = within(list).getAllByRole("option");
  expect(options).toHaveLength(1);
  fireEvent.mouseDown(options[0]);
  fireEvent.click(options[0]);
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual([
    "mira@example.com",
    "mira.k@example.net",
  ]);
});

test("suggestions for earlier text can't be picked while the new ones load", async () => {
  let answer: (people: typeof PEOPLE) => void = () => {};
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd !== "suggest_contacts") return undefined;
    if ((args as { query: string }).query === "mi") return PEOPLE;
    return new Promise((resolve) => (answer = resolve));
  });
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mi" } });
  await within(panel).findByRole("listbox");
  fireEvent.change(to, { target: { value: "bob" } });
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual(["bob"]);
  await act(async () => answer([]));
});

test("Escape hides suggestions without closing the panel", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mir" } });
  await within(panel).findByRole("listbox");
  fireEvent.keyDown(to, { key: "Escape" });
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "New message" })).toBeInTheDocument();
  // Typed text without a pick still becomes a chip as before.
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual(["mir"]);
});

test("Cc and Bcc appear on request", async () => {
  const panel = await openNew();
  expect(within(panel).queryByRole("combobox", { name: "Cc" })).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "Cc" }));
  expect(within(panel).getByRole("combobox", { name: "Cc" })).toBeInTheDocument();
});

test("a new message can come from any account", async () => {
  const panel = await openNew();
  expect(within(panel).getByRole("button", { name: /me@example\.com/ })).toBeInTheDocument();
});

test("Send without recipients says why instead of sending", async () => {
  const panel = await openNew();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(await within(panel).findByRole("alert")).toHaveTextContent("Add at least one recipient.");
  expect(calls.some((c) => c.cmd === "send_email")).toBe(false);
});

test("mod+Enter sends and the panel closes", async () => {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  fireEvent.keyDown(to, { key: "Enter" });
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(calls.some((c) => c.cmd === "send_email")).toBe(true));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "New message" })).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Sending…")).toBeInTheDocument();
});

test("closing with unsaved changes asks: Save draft, Discard or keep editing", async () => {
  const panel = await openNew();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Plans" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Save draft or discard?" });
  fireEvent.click(within(prompt).getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "New message" })).not.toBeInTheDocument(),
  );
  expect(calls.find((c) => c.cmd === "save_draft")?.args).toMatchObject({
    accountId: "a1",
    message: { subject: "Plans" },
  });
});

test("minimized panels show the subject and open again on click", async () => {
  const panel = await openNew();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Plans" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Minimize" }));
  const small = await screen.findByRole("region", { name: "Plans" });
  fireEvent.click(within(small).getByRole("button", { name: "Plans" }));
  expect(await screen.findByRole("textbox", { name: "Subject" })).toHaveValue("Plans");
});

test("autosave runs every 30 s while typing goes on", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const panel = await openNew();
    const subject = within(panel).getByRole("textbox", { name: "Subject" });
    for (let i = 1; i <= 6; i++) {
      fireEvent.change(subject, { target: { value: `Plans ${i}` } });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
    }
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() =>
    expect(calls.filter((c) => c.cmd === "save_draft").length).toBeGreaterThan(0),
  );
});

afterEach(() => vi.useRealTimers());

test("opening a saved draft and closing it untouched doesn't ask", async () => {
  renderHost();
  act(() => {
    const id = useComposeStore.getState().compose("a1", { subject: "Saved", draftId: "d1" });
    useComposeStore.setState((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, kind: "draft" as const } : w)),
    }));
  });
  const panel = await screen.findByRole("region", { name: "Draft" });
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Draft" })).not.toBeInTheDocument();
});

async function addressed() {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  fireEvent.keyDown(to, { key: "Enter" });
  return { panel, to };
}
const sent = () => calls.filter((c) => c.cmd === "send_email").length;

test("confirm before sending: Send asks first, then sends once", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  expect(sent()).toBe(0);
  fireEvent.click(within(prompt).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sent()).toBe(1));
});

test("confirm before sending: mod+Enter asks, and Keep editing or Escape closes the prompt", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel, to } = await addressed();
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  expect(sent()).toBe(0);
  fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  expect(within(panel).getByRole("alertdialog", { name: "Send this message?" })).toBeVisible();
  fireEvent.keyDown(to, { key: "Escape" });
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(sent()).toBe(0);
});

test("without confirm before sending, Send sends straight away", async () => {
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  await waitFor(() => expect(sent()).toBe(1));
});

test("closing while the send prompt is open leaves only the close prompt", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(within(panel).getByRole("alertdialog", { name: "Send this message?" })).toBeVisible();
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  const prompts = within(panel).getAllByRole("alertdialog");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toHaveAccessibleName("Save draft or discard?");
});

test("the send prompt takes focus on its Send button", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  await waitFor(() => expect(within(prompt).getByRole("button", { name: "Send" })).toHaveFocus());
});
