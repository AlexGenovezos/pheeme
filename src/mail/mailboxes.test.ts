import { expect, test } from "vitest";
import {
  accountColorIndex,
  CATEGORIES,
  categoryMailbox,
  FAVORITES,
  formatCount,
  homeMailbox,
  locationOf,
  mailboxExists,
  type MailboxRef,
  mailboxTitle,
  parseThreadKey,
  queryFor,
  resolveActiveAccount,
  showsLocation,
  threadKey,
} from "./mailboxes";

const ALL_IDS = ["a1", "a2"];

test("All Inboxes queries every account's INBOX with no second label", () => {
  const ref: MailboxRef = { accountId: null, labelId: "INBOX" };
  expect(queryFor(ref, ALL_IDS)).toEqual({ accountIds: ALL_IDS, labelId: "INBOX" });
  expect(queryFor(ref, ALL_IDS)).not.toHaveProperty("alsoLabelId");
});

test("an account's Social category is INBOX plus CATEGORY_SOCIAL for that account only", () => {
  const ref: MailboxRef = { accountId: "a2", labelId: "INBOX", category: "CATEGORY_SOCIAL" };
  expect(queryFor(ref, ALL_IDS)).toEqual({
    accountIds: ["a2"],
    labelId: "INBOX",
    alsoLabelId: "CATEGORY_SOCIAL",
  });
});

test("an account's Sent is one id and no second label", () => {
  const query = queryFor({ accountId: "a1", labelId: "SENT" }, ALL_IDS);
  expect(query).toEqual({ accountIds: ["a1"], labelId: "SENT" });
  expect(query).not.toHaveProperty("alsoLabelId");
});

test("All Mail queries the ALL pseudo-label", () => {
  expect(queryFor({ accountId: "a1", labelId: "ALL" }, ALL_IDS)).toEqual({
    accountIds: ["a1"],
    labelId: "ALL",
  });
});

test("formatCount is blank at zero and caps at 999+", () => {
  expect(formatCount(0)).toBe("");
  expect(formatCount(7)).toBe("7");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(1000)).toBe("999+");
});

test("thread keys round-trip and the parser splits on the first colon", () => {
  expect(threadKey("acc-1", "18f3")).toBe("acc-1:18f3");
  expect(parseThreadKey("acc-1:18f3")).toEqual({ accountId: "acc-1", threadId: "18f3" });
  expect(parseThreadKey("acc-1:weird:id")).toEqual({ accountId: "acc-1", threadId: "weird:id" });
});

test("categories and favorites keep the designed order and ids", () => {
  expect(CATEGORIES.map((c) => [c.labelId, c.name])).toEqual([
    ["CATEGORY_PERSONAL", "Primary"],
    ["CATEGORY_SOCIAL", "Social"],
    ["CATEGORY_PROMOTIONS", "Promotions"],
    ["CATEGORY_UPDATES", "Updates"],
    ["CATEGORY_FORUMS", "Forums"],
  ]);
  expect(FAVORITES.map((f) => [f.labelId, f.name, f.count, f.goKey])).toEqual([
    ["STARRED", "Starred", "total", "s"],
    ["DRAFT", "Drafts", "total", "d"],
    ["SENT", "Sent", "unread", "t"],
    ["ALL", "All Mail", "unread", "a"],
    ["SPAM", "Spam", "unread", undefined],
    ["TRASH", "Trash", "total", undefined],
  ]);
  for (const row of [...CATEGORIES, ...FAVORITES])
    expect(row.colorToken).toMatch(/^--color-mailbox-[a-z]+$/);
});

test("mailbox titles", () => {
  const labels = [{ id: "Label_1", name: "Receipts" }];
  expect(mailboxTitle({ accountId: null, labelId: "INBOX" }, labels)).toBe("All Inboxes");
  expect(
    mailboxTitle({ accountId: "a1", labelId: "INBOX", category: "CATEGORY_UPDATES" }, labels),
  ).toBe("Updates");
  expect(
    mailboxTitle({ accountId: "a1", labelId: "INBOX", category: "CATEGORY_PERSONAL" }, labels),
  ).toBe("Primary");
  expect(mailboxTitle({ accountId: "a1", labelId: "INBOX" }, labels)).toBe("Inbox");
  expect(mailboxTitle({ accountId: "a1", labelId: "ALL" }, labels)).toBe("All Mail");
  expect(mailboxTitle({ accountId: "a1", labelId: "STARRED" }, labels)).toBe("Starred");
  expect(mailboxTitle({ accountId: "a1", labelId: "Label_1" }, labels)).toBe("Receipts");
  expect(mailboxTitle({ accountId: "a1", labelId: "Label_9" }, labels)).toBe("Mail");
});

test("account colors follow list order, cycling through six", () => {
  const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}` }));
  expect(accountColorIndex("a0", accounts)).toBe(1);
  expect(accountColorIndex("a5", accounts)).toBe(6);
  expect(accountColorIndex("a6", accounts)).toBe(1);
  expect(accountColorIndex("a7", accounts)).toBe(2);
  expect(accountColorIndex("gone", accounts)).toBe(1);
});

test("the active account falls back to the first when unset or no longer connected", () => {
  const accounts = [{ id: "a1" }, { id: "a2" }];
  expect(resolveActiveAccount("a2", accounts)).toBe("a2");
  expect(resolveActiveAccount(null, accounts)).toBe("a1");
  expect(resolveActiveAccount("removed", accounts)).toBe("a1");
  expect(resolveActiveAccount("a1", [])).toBeNull();
});

test("home is All Inboxes, or the only account's Primary", () => {
  expect(homeMailbox([{ id: "a1" }, { id: "a2" }])).toEqual({ accountId: null, labelId: "INBOX" });
  expect(homeMailbox([{ id: "a1" }])).toEqual({
    accountId: "a1",
    labelId: "INBOX",
    category: "CATEGORY_PERSONAL",
  });
});

test("mailboxExists: gone accounts and deleted user labels don't, system mailboxes always do", () => {
  const accounts = [{ id: "a1" }];
  const labels = { a1: [{ id: "INBOX" }, { id: "Label_1" }] };
  expect(mailboxExists({ accountId: null, labelId: "INBOX" }, [], {})).toBe(true);
  expect(mailboxExists({ accountId: "gone", labelId: "INBOX" }, accounts, labels)).toBe(false);
  expect(mailboxExists({ accountId: "a1", labelId: "Label_1" }, accounts, labels)).toBe(true);
  expect(mailboxExists({ accountId: "a1", labelId: "Label_2" }, accounts, labels)).toBe(false);
  // System mailboxes need no label list; user labels wait for one.
  expect(mailboxExists({ accountId: "a1", labelId: "SENT" }, accounts, labels)).toBe(true);
  expect(
    mailboxExists(categoryMailbox("a1", "CATEGORY_SOCIAL"), accounts, { a1: [{ id: "Label_1" }] }),
  ).toBe(true);
  expect(mailboxExists({ accountId: "a1", labelId: "Label_2" }, accounts, {})).toBe(true);
});

test("locationOf names where a conversation sits", () => {
  expect(locationOf(["INBOX", "CATEGORY_UPDATES", "UNREAD"])).toBe("Updates");
  expect(locationOf(["INBOX", "CATEGORY_PERSONAL"])).toBe("Primary");
  // Accounts without category labels: the inbox is Primary.
  expect(locationOf(["INBOX", "IMPORTANT"])).toBe("Primary");
  expect(locationOf(["CATEGORY_UPDATES", "Label_1"])).toBe("Archived");
  expect(locationOf([])).toBe("Archived");
  expect(locationOf(["SPAM", "CATEGORY_PROMOTIONS"])).toBe("Spam");
  expect(locationOf(["TRASH", "INBOX"])).toBe("Trash");
  expect(locationOf(["SENT"])).toBe("Sent");
  expect(locationOf(["INBOX", "SENT", "CATEGORY_SOCIAL"])).toBe("Social");
  expect(locationOf(["DRAFT"])).toBe("Drafts");
});

test("rows name their location only in views that mix locations", () => {
  const at = (labelId: string, category?: string): MailboxRef => ({
    accountId: "a1",
    labelId,
    category,
  });
  expect(showsLocation(at("ALL"), false)).toBe(true);
  expect(showsLocation(at("STARRED"), false)).toBe(true);
  expect(showsLocation(at("Label_1"), false)).toBe(true);
  expect(showsLocation(at("INBOX"), false)).toBe(false);
  expect(showsLocation(at("INBOX", "CATEGORY_UPDATES"), false)).toBe(false);
  expect(showsLocation(at("SPAM"), false)).toBe(false);
  expect(showsLocation(at("INBOX"), true)).toBe(true);
});
