import { beforeEach, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import { useUiStore } from "../store/uiStore";
import { useComposeStore } from "./composeStore";
import { forwardConversationsAsAttachment, forwardMessageAsAttachment } from "./respond";
import { threadKey } from "../mail/mailboxes";

const forward = vi.fn(async () => {});

beforeEach(() => {
  forward.mockClear();
  useComposeStore.setState({ forwardAsAttachment: forward });
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
});

test("forward as attachment: the checked conversations, else the open one, from their account", async () => {
  useUiStore.setState({ checked: [threadKey("a1", "t1"), threadKey("a1", "t2")] });
  await forwardConversationsAsAttachment();
  expect(forward).toHaveBeenLastCalledWith("a1", { threadIds: ["t1", "t2"] });

  await forwardConversationsAsAttachment([threadKey("a2", "t9")]);
  expect(forward).toHaveBeenLastCalledWith("a2", { threadIds: ["t9"] });

  await forwardMessageAsAttachment("a1", "m3");
  expect(forward).toHaveBeenLastCalledWith("a1", { messageIds: ["m3"] });
});

test("a selection across accounts is turned down, not split", async () => {
  await forwardConversationsAsAttachment([threadKey("a1", "t1"), threadKey("a2", "t2")]);
  expect(forward).not.toHaveBeenCalled();
  expect(useToastStore.getState().toasts.map((t) => t.title)).toContain(
    "Forward conversations from one account at a time.",
  );

  await forwardConversationsAsAttachment([]);
  expect(forward).not.toHaveBeenCalled();
});
