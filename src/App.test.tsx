import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import type { ThreadDetail } from "./lib/tauri";
import * as updater from "./lib/updater";
import { parseThreadKey } from "./mail/mailboxes";
import { createPreviewHandlers } from "./preview/install";
import { usePaletteStore } from "./palette/paletteStore";
import { __resetUiStoreForTests, useUiStore } from "./store/uiStore";
import { useAccountStore } from "./store/accountStore";
import { __resetMailStoreForTests } from "./store/mailStore";
import { __resetThreadStoreForTests } from "./store/threadStore";
import { stubLayout } from "./test/layout";

const account = { id: "a1", email: "me@example.com", displayName: "Me", clientId: "c.apps.googleusercontent.com" };
const fixtureBackend = createPreviewHandlers();
/** The fixture account that owns a thread, so `get_thread` works for the test's single account "a1". */
const ownerOf = (threadId: unknown) =>
  (fixtureBackend.list_threads({ accountIds: [], labelId: "ALL" }) as { threads: { id: string; accountId: string }[] }).threads.find(
    (t) => t.id === threadId,
  )?.accountId;
/** One account; threads come from the preview fixtures, whichever fixture account they belong to. */
const backend = (cmd: string, args?: unknown) =>
  cmd === "list_accounts"
    ? [account]
    : cmd === "list_threads"
      ? fixtureBackend.list_threads({ ...(args as object), accountIds: [] })
      : cmd === "get_thread"
        ? fixtureBackend.get_thread({ ...(args as object), accountId: ownerOf((args as { threadId?: unknown }).threadId) })
        : undefined;

let restoreLayout: () => void;

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  usePaletteStore.setState({ open: false });
  mockIPC(backend);
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  useAccountStore.setState({ accounts: [], loaded: false, error: null, syncErrors: {} });
  restoreLayout = stubLayout(); // jsdom has no layout, so the virtualized list would render no rows
});

afterEach(() => restoreLayout());

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
  expect(screen.getByRole("listbox", { name: "Primary conversations" })).toBeInTheDocument();
  expect(screen.getByText("No conversation selected")).toBeInTheDocument();
});

test("g then i goes to the inbox (Primary, with one account); j selects the first conversation", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  act(() => useUiStore.getState().setMailbox({ accountId: "a1", labelId: "SENT" }));
  fireEvent.keyDown(window, { key: "g" });
  expect(screen.getByRole("status")).toHaveTextContent("Go to Inbox");
  fireEvent.keyDown(window, { key: "i" });
  expect(useUiStore.getState().mailbox).toEqual({ accountId: "a1", labelId: "INBOX", category: "CATEGORY_PERSONAL" });

  const list = screen.getByRole("listbox", { name: "Primary conversations" });
  await within(list).findAllByRole("option");
  fireEvent.keyDown(window, { key: "j" });
  const first = within(list).getAllByRole("option")[0];
  expect(first).toHaveAttribute("data-selected", "true");
  expect(list).toHaveAttribute("aria-activedescendant", first.id);
  expect((await screen.findAllByRole("article")).length).toBeGreaterThan(0);
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
  expect(useUiStore.getState().openThread).toBeNull();
});

test("right-clicking a conversation opens the menu (DOM fallback in preview)", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  const [first] = await within(screen.getByRole("listbox", { name: "Primary conversations" })).findAllByRole("option");
  const archivedId = first.id;
  fireEvent.contextMenu(first, { clientX: 100, clientY: 100 });
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  // The row leaves at once and the toast offers Undo.
  expect(await screen.findByText("Archived")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  expect(document.getElementById(archivedId)).toBeNull();
});

test("the row menu acts on the checked set when the row is in it, else on the row alone", async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  const list = () => screen.getByRole("listbox", { name: "Primary conversations" });
  const options = await within(list()).findAllByRole("option");
  const [a, , c] = options.map((o) => o.id);
  fireEvent.click(options[0], { metaKey: true });
  fireEvent.click(options[1], { metaKey: true });

  // A row outside the selection: only that row is archived, and nothing is opened.
  fireEvent.contextMenu(options[2], { clientX: 1, clientY: 1 });
  fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
  expect(document.getElementById(c)).toBeNull();
  expect(document.getElementById(a)).not.toBeNull();
  expect(useUiStore.getState().openThread).toBeNull();
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

test("the shell lists threads for every connected account", async () => {
  const queries: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "list_threads") queries.push(args);
    return backend(cmd, args);
  });
  render(<App />);
  const list = await screen.findByRole("listbox", { name: "Primary conversations" });
  await vi.waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
  expect(queries).toContainEqual({ accountIds: ["a1"], labelId: "INBOX" });
});

test("All Mail lists every cached thread through the ALL pseudo-label", async () => {
  const queries: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "list_threads") queries.push(args);
    return backend(cmd, args);
  });
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  queries.length = 0;
  act(() => useUiStore.getState().setMailbox({ accountId: null, labelId: "ALL" }));
  const list = await screen.findByRole("listbox", { name: "All Mail conversations" });
  await vi.waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
  expect(queries).toEqual([{ accountIds: ["a1"], labelId: "ALL" }]);
});

test("the shell loads labels and counts for the connected accounts and marks accounts synced", async () => {
  const calls: string[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      return backend(cmd, args);
    },
    { shouldMockEvents: true },
  );
  useAccountStore.setState({ accounts: [], loaded: false, error: null, syncErrors: {} });
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(["list_labels", "label_counts", "mailbox_counts"])));
  expect(useAccountStore.getState().accounts[0].synced).toBeFalsy();
  await vi.waitFor(async () => {
    await emit("sync:completed", { accountId: "a1" });
    expect(useAccountStore.getState().accounts[0].synced).toBe(true);
  });
});

test("a change Gmail rejects shows a toast", async () => {
  mockIPC(backend, { shouldMockEvents: true });
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  // Listeners attach asynchronously after mount.
  await vi.waitFor(async () => {
    await emit("outbox:rejected", { accountId: "a1", opId: "op1", kind: "archive", message: "Not found" });
    expect(screen.getByText("Couldn't archive")).toBeInTheDocument();
  });
  expect(screen.getByText("Gmail said: Not found. Your change was undone.")).toBeInTheDocument();
});

test("an account's sync failure survives opening and closing Manage accounts", async () => {
  mockIPC(backend, { shouldMockEvents: true });
  render(<App />);
  await screen.findByRole("navigation", { name: "Mailboxes" });
  // Listeners attach asynchronously after mount.
  await vi.waitFor(async () => {
    await emit("sync:error", { accountId: "a1", code: "network", message: "Gmail didn't answer" });
    expect(screen.getByText("Sync failed: Gmail didn't answer")).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));
  // A failure that arrives while the mail screen is closed is kept too.
  await act(() => emit("sync:error", { accountId: "a1", code: "auth", message: "Sign in again" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
  expect(await screen.findByText("Sync failed: Sign in again")).toBeInTheDocument();

  await act(() => emit("sync:completed", { accountId: "a1" }));
  await vi.waitFor(() => expect(screen.queryByText(/Sync failed/)).not.toBeInTheDocument());
});

test("a sync change to the open conversation while Manage accounts is open shows on return", async () => {
  let subject = "Before";
  mockIPC(
    (cmd, args) => {
      const out = backend(cmd, args);
      if (cmd !== "get_thread") return out;
      const detail = out as ThreadDetail;
      return { ...detail, thread: { ...detail.thread, subject } };
    },
    { shouldMockEvents: true },
  );
  render(<App />);
  const list = await screen.findByRole("listbox", { name: "Primary conversations" });
  const [first] = await within(list).findAllByRole("option");
  fireEvent.click(first);
  expect(await screen.findByRole("heading", { name: "Before" })).toBeInTheDocument();
  const { accountId, threadId } = parseThreadKey(useUiStore.getState().openThread!);

  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));
  subject = "After";
  await act(() => emit("sync:messages_updated", { accountId, added: [], removed: [], modified: [threadId] }));
  fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));

  expect(await screen.findByRole("heading", { name: "After" })).toBeInTheDocument();
});
