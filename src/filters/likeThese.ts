// Filter messages like these: Gmail's conversation action, which opens the filter form with the
// sender's address in From.
import { toast } from "../components/ui/Toast";
import type { ThreadKey } from "../mail/mailboxes";
import { conversationSender } from "../mail/searchActions";
import { openFilterEditor } from "./editorStore";

export const FILTER_LIKE_THESE_COMMAND = "conversation.filter-like-these";

/** Opens a new filter for the conversation's sender (default: the open or highlighted conversation). */
export async function filterMessagesLikeThese(key?: ThreadKey): Promise<void> {
  const found = await conversationSender(true, key);
  if (found === null) return;
  if (!found.sender) {
    toast({ title: "No sender to filter on.", tone: "danger" });
    return;
  }
  openFilterEditor({ accountId: found.accountId, spec: { from: found.sender } });
}
