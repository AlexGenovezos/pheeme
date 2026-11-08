import { beforeEach, expect, test } from "vitest";
import { LAYOUT_KEY, __resetUiStoreForTests, readLayout, useUiStore } from "./uiStore";

const ui = () => useUiStore.getState();
const stored = () => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
});

test("the default mailbox is All Inboxes with nothing open or checked", () => {
  expect(ui().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
  expect(ui().openThread).toBeNull();
  expect(ui().checked).toEqual([]);
  expect(ui().anchor).toBeNull();
  expect(ui().activeAccountId).toBeNull();
});

test("setMailbox clears open and checked and sets activeAccountId for account mailboxes only", () => {
  ui().setOpenThread("a1:t1");
  ui().toggleChecked("a1:t2");
  ui().setMailbox({ accountId: "a2", labelId: "INBOX", category: "CATEGORY_SOCIAL" });
  expect(ui().mailbox).toEqual({ accountId: "a2", labelId: "INBOX", category: "CATEGORY_SOCIAL" });
  expect(ui().openThread).toBeNull();
  expect(ui().checked).toEqual([]);
  expect(ui().anchor).toBeNull();
  expect(ui().activeAccountId).toBe("a2");

  ui().setOpenThread("a2:t9");
  ui().toggleChecked("a2:t8");
  ui().setMailbox({ accountId: null, labelId: "INBOX" });
  expect(ui().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
  expect(ui().openThread).toBeNull();
  expect(ui().checked).toEqual([]);
  expect(ui().activeAccountId).toBe("a2");
});

test("toggleChecked adds and removes, and remembers the anchor", () => {
  ui().toggleChecked("a:1");
  ui().toggleChecked("a:2");
  expect(ui().checked).toEqual(["a:1", "a:2"]);
  expect(ui().anchor).toBe("a:2");
  ui().toggleChecked("a:1");
  expect(ui().checked).toEqual(["a:2"]);
  ui().clearChecked();
  expect(ui().checked).toEqual([]);
  expect(ui().anchor).toBeNull();
});

test("checkRange selects the inclusive span from the anchor", () => {
  const keys = ["a:1", "a:2", "a:3", "a:4", "a:5"];
  ui().toggleChecked("a:2");
  ui().checkRange(keys, "a:4");
  expect(ui().checked).toEqual(["a:2", "a:3", "a:4"]);
  expect(ui().anchor).toBe("a:2");
  // Backwards from the same anchor, adding to what is already checked.
  ui().checkRange(keys, "a:1");
  expect(ui().checked).toEqual(["a:2", "a:3", "a:4", "a:1"]);
});

test("checkRange without a usable anchor checks just the target and anchors there", () => {
  ui().checkRange(["a:1", "a:2", "a:3"], "a:3");
  expect(ui().checked).toEqual(["a:3"]);
  expect(ui().anchor).toBe("a:3");
  // An anchor that scrolled out of the list behaves the same.
  ui().clearChecked();
  ui().toggleChecked("gone:1");
  ui().checkRange(["a:1", "a:2"], "a:2");
  expect(ui().checked).toEqual(["gone:1", "a:2"]);
});

test("collapsedAccounts persists", () => {
  ui().toggleAccountCollapsed("a1");
  ui().toggleAccountCollapsed("a2");
  expect(ui().collapsedAccounts).toEqual(["a1", "a2"]);
  expect(stored()).toMatchObject({ collapsedAccounts: ["a1", "a2"] });
  __resetUiStoreForTests();
  expect(ui().collapsedAccounts).toEqual(["a1", "a2"]);
  ui().toggleAccountCollapsed("a1");
  expect(ui().collapsedAccounts).toEqual(["a2"]);
  expect(stored()).toMatchObject({ collapsedAccounts: ["a2"] });
});

test("activeAccountId persists", () => {
  ui().setMailbox({ accountId: "a2", labelId: "SENT" });
  expect(stored()).toMatchObject({ activeAccountId: "a2" });
  __resetUiStoreForTests();
  expect(ui().activeAccountId).toBe("a2");
});

test("the last mailbox reopens on launch, without its open thread or selection", () => {
  ui().setMailbox({ accountId: "a1", labelId: "INBOX", category: "CATEGORY_SOCIAL" });
  ui().setOpenThread("a1:t1");
  ui().toggleChecked("a1:t2");
  __resetUiStoreForTests();
  expect(ui().mailbox).toEqual({ accountId: "a1", labelId: "INBOX", category: "CATEGORY_SOCIAL" });
  expect(ui().openThread).toBeNull();
  expect(ui().checked).toEqual([]);
});

test("a malformed stored mailbox falls back to All Inboxes", () => {
  for (const mailbox of [
    "INBOX",
    { accountId: 7, labelId: "INBOX" },
    { accountId: "a1" },
    { accountId: "a1", labelId: "" },
    { accountId: "a1", labelId: "INBOX", category: 3 },
  ]) {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ mailbox }));
    __resetUiStoreForTests();
    expect(ui().mailbox).toEqual({ accountId: null, labelId: "INBOX" });
  }
});

test("removing the account of the open mailbox stores the new mailbox", () => {
  ui().setMailbox({ accountId: "a2", labelId: "SENT" });
  ui().forgetAccount("a2", [{ id: "a1" }]);
  __resetUiStoreForTests();
  expect(ui().mailbox).toEqual({
    accountId: "a1",
    labelId: "INBOX",
    category: "CATEGORY_PERSONAL",
  });
});

test("navigation preferences tolerate corrupt storage", () => {
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({ activeAccountId: 7, collapsedAccounts: ["a1", 3, null, "a2"] }),
  );
  __resetUiStoreForTests();
  expect(ui().activeAccountId).toBeNull();
  expect(ui().collapsedAccounts).toEqual(["a1", "a2"]);
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ collapsedAccounts: "nope" }));
  __resetUiStoreForTests();
  expect(ui().collapsedAccounts).toEqual([]);
  localStorage.setItem(LAYOUT_KEY, "{not json");
  __resetUiStoreForTests();
  expect(ui().collapsedAccounts).toEqual([]);
  expect(ui().activeAccountId).toBeNull();
});

test("layout changes keep the navigation preferences in storage", () => {
  ui().toggleAccountCollapsed("a1");
  ui().toggleSidebar();
  expect(stored()).toMatchObject({ sidebarCollapsed: true, collapsedAccounts: ["a1"] });
});

test("search remembers the mailbox underneath it and resets selection on query and account changes", () => {
  const store = () => useUiStore.getState();
  store().setMailbox({ accountId: "a1", labelId: "SENT" });
  store().setOpenThread("a1:t1");
  store().toggleChecked("a1:t1");
  store().setSearch("invoice");
  expect(store().searchAccountId).toBe("a1");
  expect(store().openThread).toBeNull();
  expect(store().checked).toEqual([]);
  store().setSearchAccount(null);
  store().setSearch("invoice has:attachment");
  expect(store().searchAccountId).toBeNull();
  store().setSearch("");
  expect(store().mailbox).toEqual({ accountId: "a1", labelId: "SENT" });
  store().setSearch("another");
  store().setMailbox({ accountId: "a1", labelId: "SENT" });
  expect(store().searchText).toBe("");
});

test("unread filters are independent per account, label and category, and reset on launch", () => {
  const key = (ref: { accountId: string | null; labelId: string; category?: string }) =>
    JSON.stringify([ref.accountId, ref.labelId, ref.category ?? null]);
  const first = { accountId: "a1", labelId: "INBOX", category: "CATEGORY_SOCIAL" };
  ui().setMailbox(first);
  ui().setOpenThread("a1:t1");
  ui().checkAll(["a1:t1"]);
  ui().toggleUnreadOnly();
  expect(ui().unreadMailboxes[key(first)]).toBe(true);
  expect(ui().openThread).toBeNull();
  expect(ui().checked).toEqual([]);
  for (const other of [
    { ...first, accountId: "a2" },
    { ...first, category: "CATEGORY_UPDATES" },
    { accountId: "a1", labelId: "Label_nested" },
    { accountId: null, labelId: "INBOX" },
  ]) {
    ui().setMailbox(other);
    expect(ui().unreadMailboxes[key(other)] ?? false).toBe(false);
  }
  ui().setMailbox(first);
  expect(ui().unreadMailboxes[key(first)]).toBe(true);
  ui().toggleUnreadOnly();
  expect(ui().unreadMailboxes[key(first)]).toBe(false);
  ui().toggleUnreadOnly();
  __resetUiStoreForTests();
  expect(ui().unreadMailboxes).toEqual({});
});

test("list density defaults to comfortable and persists in the layout", () => {
  expect(ui().listDensity).toBe("comfortable");
  ui().setListDensity("compact");
  expect(ui().listDensity).toBe("compact");
  expect(stored().listDensity).toBe("compact");
  expect(readLayout().listDensity).toBe("compact");
  __resetUiStoreForTests();
  expect(ui().listDensity).toBe("compact");
});

test("an unknown stored list density reads as comfortable", () => {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ listDensity: "tiny" }));
  expect(readLayout().listDensity).toBe("comfortable");
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth: 200 }));
  expect(readLayout().listDensity).toBe("comfortable");
});
