import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { appCommands } from "../keyboard/appCommands";
import type { AccountInfo, LabelInfo } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetUiStoreForTests, LAYOUT_KEY, useUiStore } from "../store/uiStore";
import { Sidebar } from "./Sidebar";

const account = (id: string, email: string): AccountInfo => ({
  id,
  email,
  displayName: null,
  clientId: "c",
  synced: true,
});

const label = (
  accountId: string,
  id: string,
  name: string,
  colorBackground: string | null = null,
): LabelInfo => ({
  id,
  accountId,
  name,
  type: "user",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground,
  colorText: null,
});

const ONE = account("a1", "me@home.test");
const TWO = account("a2", "me@work.test");

function seed(accounts: AccountInfo[]) {
  useAccountStore.setState({ accounts, loaded: true, error: null, syncErrors: {} });
  useLabelStore.setState({
    labels: {
      a1: [
        { ...label("a1", "IMPORTANT", "Important"), type: "system" },
        label("a1", "Label_1", "Receipts"),
        label("a1", "Label_2", "Travel", "#16a766"),
      ],
      a2: [label("a2", "Label_9", "Clients")],
    },
    counts: {
      a1: {
        STARRED: { unread: 1, total: 5 },
        DRAFT: { unread: 0, total: 2 },
        SENT: { unread: 0, total: 100 },
        SPAM: { unread: 3, total: 40 },
        IMPORTANT: { unread: 9, total: 9 },
        Label_2: { unread: 4, total: 6 },
      },
      a2: { STARRED: { unread: 0, total: 8 }, Label_9: { unread: 1, total: 1 } },
    },
    categoryCounts: {
      a1: {
        INBOX: 12,
        CATEGORY_PERSONAL: 3,
        CATEGORY_SOCIAL: 0,
        CATEGORY_PROMOTIONS: 1500,
        CATEGORY_UPDATES: 1,
      },
      a2: { INBOX: 2, CATEGORY_PERSONAL: 2 },
    },
    allInboxUnread: 14,
  });
}

const link = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole("link", { name });
const count = (row: HTMLElement) => row.querySelector(".ui-row__meta")?.textContent ?? "";
const accountGroup = (email: string) =>
  screen.getByRole("group", { name: new RegExp(email.replace(".", "\\.")) });
const accountHeader = (email: string) =>
  screen.getByRole("button", { name: new RegExp(email.replace(".", "\\.")) });
const region = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  __resetLabelStoreForTests();
  mockIPC(() => undefined, { shouldMockEvents: true });
});

describe("stacked layout", () => {
  test("two accounts: Inboxes heading, All Inboxes, then a section per account with the five categories", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const inboxes = region("Inboxes");
    const names = within(inboxes)
      .getAllByRole("link")
      .map((row) => row.getAttribute("aria-label"));
    const categories = ["Primary", "Social", "Promotions", "Updates", "Forums"];
    expect(names).toEqual(["All Inboxes", ...categories, ...categories]);
    for (const email of [ONE.email, TWO.email]) {
      expect(
        within(accountGroup(email))
          .getAllByRole("link")
          .map((r) => r.getAttribute("aria-label")),
      ).toEqual(categories);
      expect(accountHeader(email)).toHaveAttribute("aria-expanded", "true");
    }
  });

  test("All Inboxes count is the unread inbox total across accounts", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(count(link("All Inboxes"))).toBe("14");
  });

  test("category rows show unread, blank at 0, 999+ above 999", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const home = accountGroup(ONE.email);
    expect(count(link("Primary", home))).toBe("3");
    expect(count(link("Social", home))).toBe("");
    expect(count(link("Promotions", home))).toBe("999+");
    expect(count(link("Forums", home))).toBe("");
  });

  test("collapsed header shows the account's inbox unread total and persists", () => {
    seed([ONE, TWO]);
    const { unmount } = render(<Sidebar />);
    expect(accountHeader(ONE.email).textContent).not.toContain("12");
    fireEvent.click(accountHeader(ONE.email));
    expect(accountHeader(ONE.email)).toHaveAttribute("aria-expanded", "false");
    expect(accountHeader(ONE.email).textContent).toContain("12");
    expect(within(accountGroup(ONE.email)).queryAllByRole("link")).toHaveLength(0);
    expect(within(accountGroup(TWO.email)).getAllByRole("link")).toHaveLength(5);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({
      collapsedAccounts: ["a1"],
    });

    unmount();
    __resetUiStoreForTests();
    render(<Sidebar />);
    expect(accountHeader(ONE.email)).toHaveAttribute("aria-expanded", "false");
  });

  test("Favorites and Gmail follow the active account", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(count(link("Starred", region("Favorites")))).toBe("5");
    expect(link("Receipts", region("Gmail"))).toBeInTheDocument();

    fireEvent.click(link("Social", accountGroup(TWO.email)));
    expect(count(link("Starred", region("Favorites")))).toBe("8");
    expect(link("Clients", region("Gmail"))).toBeInTheDocument();
    expect(
      within(region("Gmail")).queryByRole("link", { name: "Receipts" }),
    ).not.toBeInTheDocument();

    fireEvent.click(link("All Inboxes"));
    expect(useUiStore.getState().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
    expect(count(link("Starred", region("Favorites")))).toBe("8");
    expect(link("Clients", region("Gmail"))).toBeInTheDocument();
  });

  test("a stored active account that was removed falls back to the first account", () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ activeAccountId: "gone" }));
    __resetUiStoreForTests();
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(count(link("Starred", region("Favorites")))).toBe("5");
    expect(link("Receipts", region("Gmail"))).toBeInTheDocument();
  });

  test("Starred and Drafts show totals, Spam shows unread", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const favorites = region("Favorites");
    expect(
      within(favorites)
        .getAllByRole("link")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Starred", "Drafts", "Sent", "All Mail", "Spam", "Trash"]);
    expect(count(link("Starred", favorites))).toBe("5");
    expect(count(link("Drafts", favorites))).toBe("2");
    expect(count(link("Sent", favorites))).toBe("");
    expect(count(link("Spam", favorites))).toBe("3");
  });

  test("single account: no All Inboxes row and no account header", () => {
    seed([ONE]);
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "All Inboxes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /me@home\.test/ })).not.toBeInTheDocument();
    expect(
      within(region("Inboxes"))
        .getAllByRole("link")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Primary", "Social", "Promotions", "Updates", "Forums"]);
    // All Inboxes has no row here, so the default mailbox becomes the account's Primary.
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "a1",
      labelId: "INBOX",
      category: "CATEGORY_PERSONAL",
    });
    expect(link("Primary")).toHaveAttribute("aria-current", "true");
  });

  test("no Important row", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Important" })).not.toBeInTheDocument();
  });

  test("user label with colorBackground shows a dot with that color", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const gmail = region("Gmail");
    expect(link("Travel", gmail).querySelector(".sidebar__label-dot")).toHaveStyle({
      backgroundColor: "#16a766",
    });
    expect(link("Receipts", gmail).querySelector(".sidebar__label-dot")).toBeNull();
    expect(count(link("Travel", gmail))).toBe("4");
  });

  test("selected row exposes aria-current and uses its row color", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const social = link("Social", accountGroup(ONE.email));
    expect(social.style.getPropertyValue("--row-color")).toBe("var(--color-mailbox-social)");
    expect(social).not.toHaveAttribute("aria-current");
    fireEvent.click(social);
    expect(social).toHaveAttribute("aria-current", "true");
    expect(link("Social", accountGroup(TWO.email))).not.toHaveAttribute("aria-current");
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "a1",
      labelId: "INBOX",
      category: "CATEGORY_SOCIAL",
    });
    fireEvent.click(link("Trash", region("Favorites")));
    expect(link("Trash", region("Favorites"))).toHaveAttribute("aria-current", "true");
    expect(link("Trash", region("Favorites")).style.getPropertyValue("--row-color")).toBe(
      "var(--color-mailbox-trash)",
    );
  });

  test("account headers carry their account color dot", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(accountHeader(TWO.email).querySelector(".sidebar__account-dot")).toHaveStyle({
      background: "var(--color-account-2)",
    });
  });

  test("sync error on an account shows a warning on its header", async () => {
    seed([ONE, TWO]);
    const stop = await useAccountStore.getState().subscribe();
    const { unmount } = render(<Sidebar />);
    expect(accountHeader(TWO.email)).not.toHaveAttribute("aria-description");
    await act(() =>
      emit("sync:error", { accountId: "a2", code: "network", message: "Gmail didn't answer" }),
    );
    await waitFor(() =>
      expect(accountHeader(TWO.email)).toHaveAttribute(
        "aria-description",
        expect.stringContaining("Gmail didn't answer"),
      ),
    );
    expect(accountHeader(ONE.email)).not.toHaveAttribute("aria-description");

    // The failure is session state, not the sidebar's: it survives a remount.
    unmount();
    render(<Sidebar />);
    expect(accountHeader(TWO.email)).toHaveAttribute(
      "aria-description",
      expect.stringContaining("Gmail didn't answer"),
    );

    await act(() => emit("sync:completed", { accountId: "a2" }));
    await waitFor(() => expect(accountHeader(TWO.email)).not.toHaveAttribute("aria-description"));
    stop();
  });

  test("rows open with Enter and Space", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    fireEvent.keyDown(link("Updates", accountGroup(TWO.email)), { key: "Enter" });
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "a2",
      labelId: "INBOX",
      category: "CATEGORY_UPDATES",
    });
    fireEvent.keyDown(link("Drafts", region("Favorites")), { key: " " });
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a2", labelId: "DRAFT" });
    fireEvent.keyDown(link("All Inboxes"), { key: "x" });
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a2", labelId: "DRAFT" });
  });

  test("footer offers Add account", () => {
    seed([ONE, TWO]);
    let added = 0;
    render(<Sidebar onAddAccount={() => added++} onManageAccounts={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(added).toBe(1);
    expect(screen.getByRole("button", { name: "Manage accounts" })).toBeInTheDocument();
  });
});

describe("go-to commands", () => {
  const run = (shortcutOrTitle: string) => {
    const command = appCommands().find(
      (c) => c.shortcut === shortcutOrTitle || c.title === shortcutOrTitle,
    );
    if (!command) throw new Error(`no command ${shortcutOrTitle}`);
    command.run();
  };

  test("g s goes to the active account's Starred", () => {
    seed([ONE, TWO]);
    run("g s");
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a1", labelId: "STARRED" });
    useUiStore
      .getState()
      .setMailbox({ accountId: "a2", labelId: "INBOX", category: "CATEGORY_UPDATES" });
    run("g s");
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a2", labelId: "STARRED" });
    run("g a");
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a2", labelId: "ALL" });
  });

  test("g i is All Inboxes, or the account's Primary with one account", () => {
    seed([ONE, TWO]);
    useUiStore.getState().setMailbox({ accountId: "a2", labelId: "SENT" });
    run("g i");
    expect(useUiStore.getState().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
    seed([ONE]);
    run("g i");
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "a1",
      labelId: "INBOX",
      category: "CATEGORY_PERSONAL",
    });
  });

  test("palette has Go to <category> for the active account", () => {
    seed([ONE, TWO]);
    useUiStore.getState().setMailbox({ accountId: "a2", labelId: "SENT" });
    run("Go to Promotions");
    expect(useUiStore.getState().mailbox).toEqual({
      accountId: "a2",
      labelId: "INBOX",
      category: "CATEGORY_PROMOTIONS",
    });
  });
});
