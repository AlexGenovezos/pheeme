import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import * as updater from "./lib/updater";
import { usePaletteStore } from "./palette/paletteStore";
import { __resetUiStoreForTests, useUiStore } from "./store/uiStore";
import { useAccountStore } from "./store/accountStore";

const account = { id: "a1", email: "me@example.com", displayName: "Me", clientId: "c.apps.googleusercontent.com" };

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  usePaletteStore.setState({ open: false });
  mockIPC((cmd) => cmd === "list_accounts" ? [account] : undefined);
  useAccountStore.setState({ accounts: [], loaded: false, error: null });
});

test("renders nothing until accounts load", () => {
  mockIPC(() => new Promise(() => {}));
  const { container } = render(<App />);
  expect(container.querySelector(".onboarding")).toBeNull();
});

test("first run with no accounts opens the setup guide", async () => {
  mockIPC((cmd) => (cmd === "list_accounts" ? [] : undefined));
  render(<App />);
  expect(await screen.findByText("Connect Gmail with your own Google Cloud app")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Setup steps" })).toBeInTheDocument();
});

test("with accounts it shows them and can add or remove one", async () => {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return cmd === "list_accounts" ? [account] : undefined;
  });
  render(<App />);
  expect(await screen.findByText(account.email)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));

  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  expect(screen.getByText("Add an account")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText(/Nothing changes in Gmail/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(screen.queryByText("Me")).not.toBeInTheDocument());
  expect(calls).toContain("remove_account");
});

test("a failed remove keeps the account and shows why", async () => {
  mockIPC((cmd) => {
    if (cmd === "list_accounts") return [account];
    if (cmd === "remove_account") throw { code: "keychain_unavailable", message: "No system keychain is available." };
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage accounts" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No system keychain is available.");
  expect(screen.getByText("Me")).toBeInTheDocument();
});

test("a backend failure on load is shown, not swallowed", async () => {
  mockIPC(() => {
    throw { code: "internal", message: "Something went wrong: disk full" };
  });
  render(<App />);
  expect(await screen.findByText("Pheeme couldn't start")).toBeInTheDocument();
  expect(screen.getByText("Something went wrong: disk full")).toBeInTheDocument();
});

test("renders the three-pane shell with fixture mail", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  expect(screen.getByRole("navigation", { name: "Mailboxes" })).toBeInTheDocument();
  expect(screen.getByRole("listbox", { name: "Inbox conversations" })).toBeInTheDocument();
  expect(screen.getByText("No conversation selected")).toBeInTheDocument();
});

test("g then i goes to the inbox; j selects the first conversation", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  useUiStore.getState().setActiveMailbox("SENT");
  fireEvent.keyDown(window, { key: "g" });
  expect(screen.getByRole("status")).toHaveTextContent("Go to Inbox");
  fireEvent.keyDown(window, { key: "i" });
  expect(useUiStore.getState().activeMailbox).toBe("INBOX");

  fireEvent.keyDown(window, { key: "j" });
  const list = screen.getByRole("listbox", { name: "Inbox conversations" });
  expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("article")).toBeInTheDocument();
});

test("Ctrl+B toggles the sidebar; Ctrl+K opens the palette", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
});

test("shortcuts typed into search don't fire commands", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  const search = screen.getByRole("searchbox", { name: "Search mail" });
  fireEvent.keyDown(window, { key: "/" });
  expect(search).toHaveFocus();
  fireEvent.keyDown(search, { key: "j" });
  expect(useUiStore.getState().selectedThreadId).toBeNull();
});

test("right-clicking a conversation opens the menu (DOM fallback in preview)", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  const first = within(screen.getByRole("listbox", { name: "Inbox conversations" })).getAllByRole("option")[0];
  fireEvent.contextMenu(first, { clientX: 100, clientY: 100 });
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByText("Archive isn't wired up yet")).toBeInTheDocument();
});

test("the updater never starts outside the desktop app, even in production builds", async () => {
  vi.stubEnv("PROD", true);
  const start = vi.spyOn(updater, "startUpdateChecks");
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  expect(start).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

test("account management returns to the inbox", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage accounts" }));
  expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
  expect(screen.getByRole("navigation", { name: "Mailboxes" })).toBeInTheDocument();
});

test("mail shortcuts do not run during onboarding", async () => {
  mockIPC((cmd) => cmd === "list_accounts" ? [] : undefined);
  render(<App />);
  await screen.findByRole("navigation", { name: "Setup steps" });
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  expect(usePaletteStore.getState().open).toBe(false);
});
