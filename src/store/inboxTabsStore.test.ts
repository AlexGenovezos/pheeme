import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test } from "vitest";
import { categoryMailbox } from "../mail/mailboxes";
import { useInboxTabs, visibleCategories } from "./inboxTabsStore";
import { useMailStore } from "./mailStore";
import { __resetUiStoreForTests, useUiStore } from "./uiStore";

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  useInboxTabs.setState({ hidden: {} });
  mockIPC((command, args) => {
    if (command === "set_inbox_tabs") return (args as { hidden: string[] }).hidden;
    if (command === "inbox_tabs") return ["CATEGORY_FORUMS"];
  });
});

test("load reads each account's hidden tabs", async () => {
  await useInboxTabs.getState().load(["a"]);
  expect(visibleCategories("a").map((c) => c.name)).toEqual([
    "Primary",
    "Social",
    "Promotions",
    "Updates",
  ]);
});

test("hiding the open tab goes to Primary", async () => {
  useUiStore.getState().setMailbox(categoryMailbox("a", "CATEGORY_SOCIAL"));
  await useInboxTabs.getState().setHidden("a", "CATEGORY_SOCIAL", true);
  expect(useUiStore.getState().mailbox).toEqual(categoryMailbox("a", "CATEGORY_PERSONAL"));
  expect(useInboxTabs.getState().hidden.a).toEqual(["CATEGORY_SOCIAL"]);
});

test("saving reloads the open Primary list", async () => {
  let lists = 0;
  mockIPC((command, args) => {
    if (command === "list_threads") {
      lists++;
      return { threads: [], next: null };
    }
    if (command === "set_inbox_tabs") return (args as { hidden: string[] }).hidden;
  });
  useUiStore.getState().setMailbox(categoryMailbox("a", "CATEGORY_PERSONAL"));
  await useMailStore
    .getState()
    .load({ accountIds: ["a"], labelId: "INBOX", alsoLabelId: "CATEGORY_PERSONAL" });
  const loaded = lists;
  await useInboxTabs.getState().setHidden("a", "CATEGORY_SOCIAL", true);
  expect(lists).toBeGreaterThan(loaded);
});
