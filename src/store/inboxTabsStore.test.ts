import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
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

/** `set_inbox_tabs` calls held until released, each answering what it was sent (or failing). */
function heldSaves() {
  const held: Array<{ hidden: string[]; answer(fail?: boolean): void }> = [];
  mockIPC((command, args) => {
    if (command !== "set_inbox_tabs") return undefined;
    const hidden = (args as { hidden: string[] }).hidden;
    return new Promise((resolve, reject) =>
      held.push({ hidden, answer: (fail) => (fail ? reject({ code: "x" }) : resolve(hidden)) }),
    );
  });
  return held;
}

test("toggles are saved in order; a failed one never undoes a newer one", async () => {
  const held = heldSaves();
  const first = useInboxTabs.getState().setHidden("x", "CATEGORY_SOCIAL", true);
  const second = useInboxTabs.getState().setHidden("x", "CATEGORY_FORUMS", true);
  expect(useInboxTabs.getState().hidden.x).toEqual(["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
  // The second waits for the first, so the backend ends with the newest choice.
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0].answer(true);
  await expect(first).rejects.toBeTruthy();
  await vi.waitFor(() => expect(held).toHaveLength(2));
  expect(held[1].hidden).toEqual(["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
  held[1].answer();
  await second;
  expect(useInboxTabs.getState().hidden.x).toEqual(["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
});

test("when every toggle fails, the tabs go back to what was last saved", async () => {
  const held = heldSaves();
  const first = useInboxTabs.getState().setHidden("y", "CATEGORY_SOCIAL", true);
  const second = useInboxTabs.getState().setHidden("y", "CATEGORY_FORUMS", true);
  const failed = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0].answer(true);
  await vi.waitFor(() => expect(held).toHaveLength(2));
  held[1].answer(true);
  expect((await failed).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(useInboxTabs.getState().hidden.y).toEqual([]);
});

test("a load answered after a toggle, or after a newer load, keeps what's newer", async () => {
  const reads: Array<(tabs: string[]) => void> = [];
  mockIPC((command, args) => {
    if (command === "inbox_tabs") return new Promise((resolve) => reads.push(resolve));
    if (command === "set_inbox_tabs") return (args as { hidden: string[] }).hidden;
  });
  const loading = useInboxTabs.getState().load(["a", "b"]);
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  await useInboxTabs.getState().setHidden("a", "CATEGORY_SOCIAL", true);
  reads[0]([]);
  reads[1](["CATEGORY_UPDATES"]);
  await loading;
  expect(useInboxTabs.getState().hidden).toEqual({
    a: ["CATEGORY_SOCIAL"],
    b: ["CATEGORY_UPDATES"],
  });
  // What that load read for `a` is older than the save: a failed toggle goes back to the save.
  mockIPC((command) => {
    if (command === "set_inbox_tabs") throw { code: "x" };
  });
  await expect(
    useInboxTabs.getState().setHidden("a", "CATEGORY_FORUMS", true),
  ).rejects.toBeTruthy();
  expect(useInboxTabs.getState().hidden.a).toEqual(["CATEGORY_SOCIAL"]);
  mockIPC((command) => {
    if (command === "inbox_tabs") return new Promise((resolve) => reads.push(resolve));
  });

  const older = useInboxTabs.getState().load(["a"]);
  const newer = useInboxTabs.getState().load(["a"]);
  await vi.waitFor(() => expect(reads).toHaveLength(4));
  reads[3](["CATEGORY_FORUMS"]);
  await newer;
  reads[2]([]);
  await older;
  expect(useInboxTabs.getState().hidden).toEqual({ a: ["CATEGORY_FORUMS"] });
});
