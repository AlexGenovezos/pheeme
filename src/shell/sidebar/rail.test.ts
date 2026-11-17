import { describe, expect, test } from "vitest";
import { ALL_INBOXES, categoryMailbox } from "../../mail/mailboxes";
import { mailboxInAccount, nextInbox } from "./rail";

const TABS = ["CATEGORY_PERSONAL", "CATEGORY_UPDATES"];

describe("mailboxInAccount", () => {
  test("from All Inboxes, opens the account's first tab", () => {
    expect(mailboxInAccount(ALL_INBOXES, "b", TABS)).toEqual(
      categoryMailbox("b", "CATEGORY_PERSONAL"),
    );
  });

  test("keeps the same Inbox tab when the other account shows it", () => {
    expect(mailboxInAccount(categoryMailbox("a", "CATEGORY_UPDATES"), "b", TABS)).toEqual(
      categoryMailbox("b", "CATEGORY_UPDATES"),
    );
  });

  test("falls back to the first tab when the other account hides it", () => {
    expect(mailboxInAccount(categoryMailbox("a", "CATEGORY_SOCIAL"), "b", TABS)).toEqual(
      categoryMailbox("b", "CATEGORY_PERSONAL"),
    );
  });

  test("keeps a favorite, which every account has", () => {
    expect(mailboxInAccount({ accountId: "a", labelId: "STARRED" }, "b", TABS)).toEqual({
      accountId: "b",
      labelId: "STARRED",
    });
  });

  test("a user label belongs to its account, so the first tab instead", () => {
    expect(mailboxInAccount({ accountId: "a", labelId: "Label_1" }, "b", TABS)).toEqual(
      categoryMailbox("b", "CATEGORY_PERSONAL"),
    );
  });

  test("the account already showing keeps its mailbox", () => {
    const here = { accountId: "b", labelId: "Label_1" };
    expect(mailboxInAccount(here, "b", TABS)).toBe(here);
  });
});

test("Ctrl+Tab goes from All Inboxes through each account in order, and round again", () => {
  const ids = ["a", "b", "c"];
  expect(nextInbox(null, ids, 1)).toBe("a");
  expect(nextInbox("a", ids, 1)).toBe("b");
  expect(nextInbox("c", ids, 1)).toBeNull();
  expect(nextInbox(null, ids, -1)).toBe("c");
  expect(nextInbox("a", ids, -1)).toBeNull();
  // An account that's gone counts as All Inboxes.
  expect(nextInbox("gone", ids, 1)).toBe("a");
  // One account: nowhere else to go.
  expect(nextInbox("a", ["a"], 1)).toBe("a");
});
