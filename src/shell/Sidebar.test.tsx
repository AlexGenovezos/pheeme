import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { appCommands } from "../keyboard/appCommands";
import { ColorPopoverHost } from "../labels/ColorPopover";
import { useLabelDialogStore } from "../labels/dialogStore";
import { LabelPickerHost } from "../labels/LabelPicker";
import { usePickerStore } from "../labels/pickerStore";
import { revealLabels } from "../labels/reveal";
import { useSettingsStore } from "../settings/settingsStore";
import type { AccountInfo, LabelInfo } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { __resetUiStoreForTests, LAYOUT_KEY, useUiStore } from "../store/uiStore";
import { ContextMenuHost } from "./ContextMenuHost";
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
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
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

  test("Favorites and Labels follow the active account", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(count(link("Starred", region("Favorites")))).toBe("5");
    expect(link("Receipts", region("Labels"))).toBeInTheDocument();

    fireEvent.click(link("Social", accountGroup(TWO.email)));
    expect(count(link("Starred", region("Favorites")))).toBe("8");
    expect(link("Clients", region("Labels"))).toBeInTheDocument();
    expect(
      within(region("Labels")).queryByRole("link", { name: "Receipts" }),
    ).not.toBeInTheDocument();

    fireEvent.click(link("All Inboxes"));
    expect(useUiStore.getState().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
    expect(count(link("Starred", region("Favorites")))).toBe("8");
    expect(link("Clients", region("Labels"))).toBeInTheDocument();
  });

  test("a stored active account that was removed falls back to the first account", () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ activeAccountId: "gone" }));
    __resetUiStoreForTests();
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(count(link("Starred", region("Favorites")))).toBe("5");
    expect(link("Receipts", region("Labels"))).toBeInTheDocument();
  });

  test("a restored mailbox whose account or label is gone falls back to the home mailbox", () => {
    for (const mailbox of [
      { accountId: "gone", labelId: "INBOX" },
      { accountId: "a1", labelId: "Label_deleted" },
    ]) {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ mailbox }));
      __resetUiStoreForTests();
      seed([ONE, TWO]);
      const { unmount } = render(<Sidebar />);
      expect(useUiStore.getState().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
      unmount();
    }
  });

  test("a restored mailbox that still exists stays open", () => {
    const mailbox = { accountId: "a1", labelId: "Label_2" };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ mailbox }));
    __resetUiStoreForTests();
    seed([ONE, TWO]);
    render(<Sidebar />);
    expect(useUiStore.getState().mailbox).toEqual(mailbox);
    expect(link("Travel", region("Labels"))).toHaveAttribute("aria-current", "true");
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

  test("Trash counts read conversations too, so deleting read mail increases the badge", () => {
    seed([ONE, TWO]);
    render(<Sidebar />);
    const trash = link("Trash", region("Favorites"));
    expect(count(trash)).toBe("");

    act(() => {
      const counts = useLabelStore.getState().counts;
      useLabelStore.setState({
        counts: { ...counts, a1: { ...counts.a1, TRASH: { unread: 0, total: 1 } } },
      });
    });
    expect(count(trash)).toBe("1");
    expect(trash).toHaveAttribute("aria-description", "1 conversations");
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
    const gmail = region("Labels");
    expect(link("Travel", gmail).querySelector(".sidebar__label-dot")).toHaveStyle({
      backgroundColor: "#16a766",
    });
    const plain = link("Receipts", gmail).querySelector(".sidebar__label-dot");
    expect(plain).toHaveClass("sidebar__label-dot--none");
    expect(plain).not.toHaveAttribute("style");
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
    expect(
      accountHeader(TWO.email).querySelector<HTMLElement>(".sidebar__account-dot")?.style
        .background,
    ).toBe("var(--color-account-2)");
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

  test("footer offers Add account and Settings", () => {
    seed([ONE, TWO]);
    let added = 0;
    render(<Sidebar onAddAccount={() => added++} />);
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(added).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useSettingsStore.getState().open).toBe(true);
    act(() => useSettingsStore.getState().close());
  });
});

test("revealing another account's labels switches the sidebar's account, not the mailbox", async () => {
  seed([ONE, TWO]);
  render(<Sidebar />);
  const mailbox = useUiStore.getState().mailbox; // All Inboxes; the sidebar shows a1's labels
  expect(within(region("Labels")).queryByRole("link", { name: "Clients" })).toBeNull();

  act(() => revealLabels("a2"));
  expect(useUiStore.getState().activeAccountId).toBe("a2");
  expect(useUiStore.getState().mailbox).toEqual(mailbox);
  await waitFor(() => expect(link("Clients", region("Labels"))).toHaveFocus());
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

describe("Labels section", () => {
  let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
  let refuse: string | null;
  const updates = () => calls.filter((c) => c.cmd === "update_label").map((c) => c.args);

  const withVis = (l: LabelInfo, labelListVisibility: string): LabelInfo => ({
    ...l,
    labelListVisibility,
  });

  function seedLabels() {
    useAccountStore.setState({ accounts: [ONE], loaded: true, error: null, syncErrors: {} });
    useLabelStore.setState({
      labels: {
        a1: [
          label("a1", "L_globex", "Clients/Globex"),
          label("a1", "L_clients", "Clients"),
          label("a1", "L_acme", "Clients/Acme"),
          label("a1", "L_travel", "Travel", "#16a766"),
          label("a1", "L_thing", "Old/Thing"),
          withVis(label("a1", "L_archive", "Archive"), "labelHide"),
          withVis(label("a1", "L_news", "Newsletters"), "labelShowIfUnread"),
          withVis(label("a1", "L_alerts", "Alerts"), "labelShowIfUnread"),
        ],
      },
      counts: { a1: { L_acme: { unread: 3, total: 9 }, L_alerts: { unread: 2, total: 2 } } },
      categoryCounts: { a1: { INBOX: 0 } },
      allInboxUnread: 0,
    });
  }

  const labelsRegion = () => region("Labels");
  const shownLinks = () =>
    within(labelsRegion())
      .queryAllByRole("link")
      .map((r) => r.getAttribute("aria-label"));
  const menuItems = () =>
    [
      ...screen
        .getByRole("menu")
        .querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="separator"]'),
    ].map((el) =>
      el.getAttribute("role") === "separator"
        ? "---"
        : `${el.textContent}${el.getAttribute("aria-checked") === "true" ? " [x]" : ""}`,
    );
  const renderAll = () =>
    render(
      <>
        <Sidebar />
        <ContextMenuHost />
        <ColorPopoverHost />
      </>,
    );
  const openMenu = async (path: string) => {
    fireEvent.click(within(labelsRegion()).getByRole("button", { name: `Options for ${path}` }));
    await screen.findByRole("menu");
  };
  const menuItem = (name: string) =>
    within(screen.getByRole("menu")).queryByRole("menuitem", { name }) ??
    within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name });
  const choose = (name: string) => fireEvent.click(menuItem(name));

  beforeEach(() => {
    calls = [];
    refuse = null;
    useLabelDialogStore.getState().close();
    useToastStore.setState({ toasts: [] });
    mockIPC(
      (cmd, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args: a });
        if (cmd === "update_label") {
          if (refuse) throw { code: "gmail", message: refuse };
          return [];
        }
        return undefined;
      },
      { shouldMockEvents: true },
    );
    seedLabels();
  });

  test("nests_and_folds", () => {
    const { unmount } = render(<Sidebar />);
    expect(shownLinks()).toEqual([
      "Alerts",
      "Clients",
      "Clients/Acme",
      "Clients/Globex",
      "Old/Thing",
      "Travel",
    ]);
    const acme = link("Clients/Acme", labelsRegion());
    expect(acme.closest(".sidebar__label")).toHaveStyle({ "--label-depth": "1" });
    expect(link("Clients", labelsRegion()).closest(".sidebar__label")).toHaveStyle({
      "--label-depth": "0",
    });
    expect(acme.textContent).toContain("Acme");
    expect(acme.textContent).not.toContain("Clients");
    expect(count(acme)).toBe("3");

    // A sublabel whose parent doesn't exist sits under a synthetic parent that isn't a link but still folds.
    const old = within(labelsRegion()).getByRole("button", { name: "Old sublabels" });
    expect(old).toHaveAttribute("aria-expanded", "true");
    expect(within(labelsRegion()).queryByRole("link", { name: "Old" })).not.toBeInTheDocument();
    expect(within(labelsRegion()).getByText("Old")).toBeInTheDocument();
    expect(
      within(labelsRegion()).queryByRole("button", { name: "Options for Old" }),
    ).not.toBeInTheDocument();
    fireEvent.click(old);
    expect(old).toHaveAttribute("aria-expanded", "false");
    expect(shownLinks()).not.toContain("Old/Thing");

    const clients = within(labelsRegion()).getByRole("button", { name: "Clients sublabels" });
    expect(clients).toHaveAttribute("aria-expanded", "true");
    expect(
      within(labelsRegion()).queryByRole("button", { name: "Travel sublabels" }),
    ).not.toBeInTheDocument();
    fireEvent.click(clients);
    expect(clients).toHaveAttribute("aria-expanded", "false");
    expect(shownLinks()).toEqual(["Alerts", "Clients", "Travel"]);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({
      foldedLabels: { a1: ["Old", "Clients"] },
    });

    unmount();
    __resetUiStoreForTests();
    render(<Sidebar />);
    expect(
      within(labelsRegion()).getByRole("button", { name: "Clients sublabels" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(labelsRegion()).getByRole("button", { name: "Clients sublabels" }));
    expect(shownLinks()).toContain("Clients/Acme");
  });

  test("hidden_labels_under_more", () => {
    render(<Sidebar />);
    expect(shownLinks()).not.toContain("Archive");
    const more = within(labelsRegion()).getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(shownLinks().slice(-2)).toEqual(["Archive", "Newsletters"]);
    fireEvent.click(link("Archive", labelsRegion()));
    expect(useUiStore.getState().mailbox).toEqual({ accountId: "a1", labelId: "L_archive" });
  });

  for (const [mode, labelListVisibility] of [
    ["read show-if-unread parent", "labelShowIfUnread"],
  ] as const)
    test(`a ${mode} of a shown sublabel is only context above More`, () => {
      useLabelStore.setState({
        labels: {
          a1: [
            withVis(label("a1", "L_clients", "Clients"), labelListVisibility),
            label("a1", "L_acme", "Clients/Acme"),
          ],
        },
        counts: { a1: {} },
      });
      render(<Sidebar />);
      expect(shownLinks()).toEqual(["Clients/Acme"]);
      expect(within(labelsRegion()).getByText("Clients")).toBeInTheDocument();
      expect(
        within(labelsRegion()).queryByRole("button", { name: "Options for Clients" }),
      ).not.toBeInTheDocument();
      const fold = within(labelsRegion()).getByRole("button", { name: "Clients sublabels" });
      fireEvent.click(fold);
      expect(shownLinks()).toEqual([]);
      fireEvent.click(fold);

      fireEvent.click(within(labelsRegion()).getByRole("button", { name: "More" }));
      expect(shownLinks()).toEqual(["Clients/Acme", "Clients"]);
      expect(
        within(labelsRegion()).getByRole("button", { name: "Options for Clients" }),
      ).toBeInTheDocument();
      fireEvent.click(link("Clients", labelsRegion()));
      expect(useUiStore.getState().mailbox).toEqual({ accountId: "a1", labelId: "L_clients" });
    });

  test("no More row when every label is shown", () => {
    useLabelStore.setState({ labels: { a1: [label("a1", "L_travel", "Travel")] } });
    render(<Sidebar />);
    expect(within(labelsRegion()).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  test("show_if_unread_hidden_when_read", () => {
    render(<Sidebar />);
    expect(shownLinks()).toContain("Alerts");
    expect(shownLinks()).not.toContain("Newsletters");
    act(() => {
      const counts = useLabelStore.getState().counts;
      useLabelStore.setState({
        counts: {
          a1: { ...counts.a1, L_news: { unread: 1, total: 1 }, L_alerts: { unread: 0, total: 2 } },
        },
      });
    });
    expect(shownLinks()).toContain("Newsletters");
    expect(shownLinks()).not.toContain("Alerts");
  });

  test("plus_opens_create_dialog", () => {
    render(<Sidebar />);
    fireEvent.click(within(labelsRegion()).getByRole("button", { name: "Create label" }));
    expect(useLabelDialogStore.getState().dialog).toMatchObject({
      kind: "label",
      spec: { mode: "create", accountId: "a1" },
    });
  });

  test("the section and its + show for an account without labels", () => {
    useLabelStore.setState({ labels: { a1: [] } });
    render(<Sidebar />);
    expect(
      within(labelsRegion()).getByRole("button", { name: "Create label" }),
    ).toBeInTheDocument();
  });

  test("menu_offers_label_actions", async () => {
    renderAll();
    await openMenu("Travel");
    expect(menuItems()).toEqual([
      "Label colour…",
      "---",
      "Show in label list [x]",
      "Show if unread",
      "Hide in label list",
      "Show in message list [x]",
      "---",
      "Edit…",
      "Add sublabel…",
      "Delete label",
    ]);
    expect(menuItem("Delete label")).toHaveClass("ui-menu__item--danger");

    choose("Hide in label list");
    // It goes under More at once, before Gmail answers.
    expect(shownLinks()).not.toContain("Travel");
    await waitFor(() =>
      expect(updates()).toEqual([
        { accountId: "a1", labelId: "L_travel", edit: { labelListVisibility: "labelHide" } },
      ]),
    );
    fireEvent.click(within(labelsRegion()).getByRole("button", { name: "More" }));

    await openMenu("Travel");
    choose("Show in message list");
    await waitFor(() =>
      expect(updates()[1]).toEqual({
        accountId: "a1",
        labelId: "L_travel",
        edit: { messageListVisibility: "hide" },
      }),
    );

    // Choosing the visibility it already has changes nothing.
    await openMenu("Travel");
    choose("Hide in label list");
    expect(updates()).toHaveLength(2);

    await openMenu("Clients/Acme");
    choose("Add sublabel…");
    expect(useLabelDialogStore.getState().dialog).toMatchObject({
      kind: "label",
      spec: { mode: "create", accountId: "a1", parent: "Clients/Acme" },
    });

    await openMenu("Travel");
    choose("Edit…");
    expect(useLabelDialogStore.getState().dialog).toMatchObject({
      kind: "label",
      spec: { mode: "edit", accountId: "a1", labelId: "L_travel" },
    });

    await openMenu("Travel");
    choose("Delete label");
    expect(useLabelDialogStore.getState().dialog).toMatchObject({
      kind: "delete",
      accountId: "a1",
      labelId: "L_travel",
    });
  });

  test("right-click and the context-menu key open the same menu, ticking the current visibility", async () => {
    useLabelStore.setState({
      labels: {
        a1: [
          {
            ...withVis(label("a1", "L_alerts", "Alerts"), "labelShowIfUnread"),
            messageListVisibility: "hide",
          },
        ],
      },
    });
    renderAll();
    fireEvent.contextMenu(link("Alerts", labelsRegion()), { clientX: 10, clientY: 20 });
    await screen.findByRole("menu");
    expect(menuItems()).toContain("Show if unread [x]");
    expect(menuItems()).toContain("Show in message list");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.keyDown(link("Alerts", labelsRegion()), { key: "ContextMenu" });
    await screen.findByRole("menu");
    choose("Show in message list");
    await waitFor(() =>
      expect(updates()).toEqual([
        { accountId: "a1", labelId: "L_alerts", edit: { messageListVisibility: "show" } },
      ]),
    );
  });

  test("color_popover_updates_label", async () => {
    renderAll();
    await openMenu("Clients/Acme");
    choose("Label colour…");
    const popover = await screen.findByRole("dialog", { name: "Label colour" });
    const swatches = within(popover).getAllByRole("radio");
    expect(swatches).toHaveLength(64);
    expect(swatches.every((s) => s.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(within(popover).getByRole("radio", { name: "#16a766" }));
    await waitFor(() =>
      expect(updates()).toEqual([
        {
          accountId: "a1",
          labelId: "L_acme",
          edit: { color: { background: "#16a766", text: "#000000" } },
        },
      ]),
    );
    expect(screen.queryByRole("dialog", { name: "Label colour" })).not.toBeInTheDocument();
  });

  test("the colour popover ticks the current colour and works from the keyboard", async () => {
    renderAll();
    await openMenu("Travel");
    choose("Label colour…");
    const popover = await screen.findByRole("dialog", { name: "Label colour" });
    const current = within(popover).getByRole("radio", { name: "#16a766" });
    expect(current).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(current).toHaveFocus());
    fireEvent.keyDown(current, { key: "ArrowRight" });
    const next = within(popover).getByRole("radio", { name: "#43d692" });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "ArrowDown" });
    const below = within(popover).getByRole("radio", { name: "#c6f3de" });
    expect(below).toHaveFocus();
    fireEvent.keyDown(below, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Label colour" })).not.toBeInTheDocument();
    expect(updates()).toEqual([]);
  });

  test("remove_colour_clears", async () => {
    renderAll();
    await openMenu("Travel");
    choose("Label colour…");
    const popover = await screen.findByRole("dialog", { name: "Label colour" });
    fireEvent.click(within(popover).getByRole("button", { name: "Remove colour" }));
    await waitFor(() =>
      expect(updates()).toEqual([
        { accountId: "a1", labelId: "L_travel", edit: { clearColor: true } },
      ]),
    );
  });

  test("a refused change shows Gmail's message in a toast", async () => {
    refuse = "Gmail didn't answer";
    renderAll();
    await openMenu("Travel");
    choose("Hide in label list");
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Gmail didn't answer"]),
    );
  });

  test("reveal_labels_expands_collapsed_sidebar", async () => {
    useUiStore.setState({ sidebarCollapsed: true });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Sidebar />);
    act(() => revealLabels());
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    await waitFor(() => expect(link("Alerts", labelsRegion())).toHaveFocus());
    expect(scrolled).toHaveBeenCalled();

    // Already open: it stays open and still focuses the section.
    link("Travel", labelsRegion()).focus();
    act(() => revealLabels());
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    await waitFor(() => expect(link("Alerts", labelsRegion())).toHaveFocus());
  });

  test("the picker's Manage labels opens the collapsed sidebar on the Labels section", async () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(
      <>
        <Sidebar />
        <LabelPickerHost />
      </>,
    );
    act(() =>
      usePickerStore
        .getState()
        .open({ mode: "label", accountId: "a1", keys: [], at: { x: 0, y: 0 } }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Manage labels" }));
    expect(usePickerStore.getState().spec).toBeNull();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    await waitFor(() => expect(link("Alerts", labelsRegion())).toHaveFocus());
  });
});
