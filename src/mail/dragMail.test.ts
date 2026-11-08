import { beforeEach, expect, test } from "vitest";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { canDrop } from "./dragMail";

beforeEach(() => {
  __resetUiStoreForTests();
  __resetMailStoreForTests();
});

const to = (labelId: string, accountId = "a1") => ({ accountId, labelId });

test("only the dragged rows' own account takes them", () => {
  useUiStore.setState({ mailbox: { accountId: null, labelId: "INBOX" } });
  expect(canDrop("a1", to("CATEGORY_UPDATES"))).toBe(true);
  expect(canDrop("a1", to("CATEGORY_UPDATES", "a2"))).toBe(false);
  expect(canDrop(null, to("CATEGORY_UPDATES"))).toBe(false); // rows of several accounts
});

test("the mailbox the rows are shown in isn't a target", () => {
  useUiStore.setState({
    mailbox: { accountId: "a1", labelId: "INBOX", category: "CATEGORY_SOCIAL" },
  });
  expect(canDrop("a1", to("CATEGORY_SOCIAL"))).toBe(false);
  expect(canDrop("a1", to("CATEGORY_PERSONAL"))).toBe(true);
  expect(canDrop("a1", to("Label_1"))).toBe(true);

  useUiStore.setState({ mailbox: { accountId: "a1", labelId: "Label_1" } });
  expect(canDrop("a1", to("Label_1"))).toBe(false);
  expect(canDrop("a1", to("TRASH"))).toBe(true);
  // Search results come from anywhere, so the label is somewhere to move them.
  useMailStore.setState({ query: { accountIds: ["a1"], labelId: "ALL", search: "x" } });
  expect(canDrop("a1", to("Label_1"))).toBe(true);
});

test("nothing leaves Spam or Trash by dragging, as with Move to…", () => {
  for (const labelId of ["SPAM", "TRASH"]) {
    useUiStore.setState({ mailbox: { accountId: "a1", labelId } });
    expect(canDrop("a1", to("CATEGORY_UPDATES"))).toBe(false);
    expect(canDrop("a1", to("Label_1"))).toBe(false);
  }
});
