// Find similar and mark every match of a search read.
import { toast, toastError } from "../components/ui/Toast";
import { markSearchRead } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { focusedThread } from "../store/uiStore";
import { keyOf, mail, ui } from "./change";
import { parseThreadKey, type ThreadKey } from "./mailboxes";
import { similarSender, type SimilarBy, similarQuery } from "./similar";

/**
 * Find similar: search the conversation's account (default: the open or highlighted conversation) for mail from its
 * sender or with its subject, so every match can be seen and marked read at once.
 */
export async function findSimilar(by: SimilarBy, key?: ThreadKey): Promise<void> {
  const target = key ?? focusedThread(ui());
  if (target === null) return;
  const { accountId } = parseThreadKey(target);
  const own = useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email;
  const row = mail().threads.find((t) => keyOf(t) === target);
  const threads = useThreadStore.getState();
  // A row whose latest message is your own reply names you; the conversation knows who wrote to you.
  if (by === "sender" && !threads.details.has(target) && !similarSender(row, undefined, own)) {
    await threads.load(target);
  }
  const detail = useThreadStore.getState().details.get(target);
  const query = similarQuery(by, {
    sender: similarSender(row, detail?.messages, own),
    subject: row?.subject ?? detail?.thread.subject ?? null,
  });
  if (query === null) {
    toast({
      title: by === "sender" ? "No sender to search for." : "This conversation has no subject.",
      tone: "danger",
    });
    return;
  }
  ui().setSearch(query, accountId);
}

/** Mark every unread match of the search being shown read, including matches not loaded or downloaded yet. */
export async function markSearchResultsRead(): Promise<void> {
  const { searchText, searchAccountId } = ui();
  const query = searchText.trim();
  if (!query) return;
  const accountIds =
    searchAccountId === null
      ? useAccountStore.getState().accounts.map((a) => a.id)
      : [searchAccountId];
  try {
    await markSearchRead(accountIds, query);
    toast({ title: "Marked every match as read" });
  } catch (e) {
    toastError(e);
  }
}
