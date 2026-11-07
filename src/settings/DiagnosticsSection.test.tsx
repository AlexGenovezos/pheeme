import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { DiagnosticsSection } from "./DiagnosticsSection";

const account = (id: string, email: string): AccountInfo => ({
  id,
  email,
  displayName: null,
  clientId: "c",
  synced: true,
});

/** Records every diagnostics command; `answer` decides how each one ends. */
function backend(answer: (cmd: string, args: unknown) => unknown = () => undefined) {
  const calls: Array<[string, unknown]> = [];
  mockIPC((cmd, args) => {
    if (cmd === "send_diagnostics" || cmd === "save_diagnostics" || cmd === "plugin:dialog|save") {
      calls.push([cmd, args]);
      return answer(cmd, args);
    }
  });
  return calls;
}

const setAccounts = (accounts: AccountInfo[]) => useAccountStore.setState({ accounts });
const note = () => screen.getByRole("textbox", { name: "What happened?" });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));

beforeEach(() => setAccounts([]));

test("Send uploads the note as the only account's address and says thanks", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  const calls = backend();
  render(<DiagnosticsSection />);
  expect(screen.getByText("Sent as me@gmail.com so the developer can reply")).toBeInTheDocument();
  fireEvent.change(note(), { target: { value: "Opening an email took ages" } });
  send();
  expect(await screen.findByText("Sent. Thanks, Alex will take a look.")).toBeInTheDocument();
  expect(calls).toEqual([
    ["send_diagnostics", { note: "Opening an email took ages", replyTo: "me@gmail.com" }],
  ]);
});

test("a refused upload shows why and points to saving the file", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  backend(() => {
    throw { code: "rate_limited", message: "Too many reports right now. Please try again later." };
  });
  render(<DiagnosticsSection />);
  send();
  expect(
    await screen.findByText(/Too many reports right now\. Please try again later\./),
  ).toHaveTextContent("You can save the file and email it instead.");
  expect(screen.queryByText("Sent. Thanks, Alex will take a look.")).toBeNull();
});

test("with several accounts the reply address is picked from them", async () => {
  setAccounts([account("a1", "me@gmail.com"), account("a2", "work@example.com")]);
  const calls = backend();
  render(<DiagnosticsSection />);
  const picker = screen.getByRole("combobox", { name: "Reply address" });
  expect(picker).toHaveValue("me@gmail.com");
  fireEvent.change(picker, { target: { value: "work@example.com" } });
  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  expect(calls).toEqual([["send_diagnostics", { note: "", replyTo: "work@example.com" }]]);
});

test("with no accounts the typed address is sent, or none at all", async () => {
  const calls = backend();
  render(<DiagnosticsSection />);
  const email = screen.getByRole("textbox", { name: "Your email (so the developer can reply)" });
  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  fireEvent.change(email, { target: { value: " jane@example.com " } });
  send();
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls).toEqual([
    ["send_diagnostics", { note: "", replyTo: null }],
    ["send_diagnostics", { note: "", replyTo: "jane@example.com" }],
  ]);
});

test("Save a copy writes the bundle where the user chose, and does nothing if they cancel", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  let chosen: string | null = null;
  const calls = backend((cmd) => (cmd === "plugin:dialog|save" ? chosen : undefined));
  render(<DiagnosticsSection />);
  const save = screen.getByRole("button", { name: "Save a copy…" });

  fireEvent.click(save);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0][0]).toBe("plugin:dialog|save");
  expect(calls[0][1]).toMatchObject({ options: { defaultPath: "pheeme-diagnostics.zip" } });

  chosen = "/Users/me/pheeme-diagnostics.zip";
  fireEvent.change(note(), { target: { value: "Slow" } });
  fireEvent.click(save);
  expect(await screen.findByText("Saved to /Users/me/pheeme-diagnostics.zip.")).toBeInTheDocument();
  expect(calls.slice(2)).toEqual([
    [
      "save_diagnostics",
      { note: "Slow", replyTo: "me@gmail.com", path: "/Users/me/pheeme-diagnostics.zip" },
    ],
  ]);
});
