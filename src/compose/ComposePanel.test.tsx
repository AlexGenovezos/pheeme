import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { ComposeHost } from "./ComposeHost";
import { __resetComposeStoreForTests, useComposeStore } from "./composeStore";

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

beforeEach(() => {
  localStorage.clear();
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
  return screen.findByRole("region", { name: "New message" });
}

test("typed addresses become chips; Backspace takes the last one back to edit", async () => {
  const panel = await openNew();
  const to = within(panel).getByRole("textbox", { name: "To" });
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

test("Cc and Bcc appear on request", async () => {
  const panel = await openNew();
  expect(within(panel).queryByRole("textbox", { name: "Cc" })).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "Cc" }));
  expect(within(panel).getByRole("textbox", { name: "Cc" })).toBeInTheDocument();
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
  const to = within(panel).getByRole("textbox", { name: "To" });
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
