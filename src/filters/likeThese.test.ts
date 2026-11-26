import { afterEach, beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { threadKey } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useFilterEditorStore } from "./editorStore";
import { filterMessagesLikeThese } from "./likeThese";

beforeEach(() => {
  __resetUiStoreForTests();
  __resetMailStoreForTests();
  useAccountStore.setState({ accounts: [{ id: "a1", email: "me@example.com" } as never] });
  useFilterEditorStore.getState().close();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => useFilterEditorStore.getState().close());

const row = (id: string, fromAddress: string) =>
  ({ id, accountId: "a1", fromAddress, subject: "Hi" }) as never;

test("opens a new filter with the conversation's sender in From", async () => {
  useMailStore.setState({ threads: [row("t1", "news@x.com")] });
  useUiStore.setState({ openThread: threadKey("a1", "t1") });
  await filterMessagesLikeThese();
  expect(useFilterEditorStore.getState().editor).toMatchObject({
    accountId: "a1",
    spec: { from: "news@x.com" },
  });
});

test("says so when there's no sender to filter on", async () => {
  // Only your own mail: no one else to filter on, and nothing to read for more.
  useMailStore.setState({ threads: [row("t2", "me@example.com")] });
  const key = threadKey("a1", "t2");
  const { useThreadStore } = await import("../store/threadStore");
  useThreadStore.setState((s) => ({
    details: new Map(s.details).set(key, {
      thread: { subject: "Hi" },
      messages: [{ fromAddress: "me@example.com", labelIds: ["SENT"] }],
    } as never),
  }));
  await filterMessagesLikeThese(key);
  expect(useFilterEditorStore.getState().editor).toBeNull();
  expect(useToastStore.getState().toasts[0]).toMatchObject({ title: "No sender to filter on." });
});

test("does nothing without a conversation", async () => {
  await filterMessagesLikeThese();
  expect(useFilterEditorStore.getState().editor).toBeNull();
});
