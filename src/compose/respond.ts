// Starting a message from the mail view: a new one, or a reply to the open conversation.
import { type ComposeMode, type ThreadDetail } from "../lib/tauri";
import { resolveActiveAccount, parseThreadKey } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { useComposeStore } from "./composeStore";

/** The message a Reply, Reply all or Forward answers: the conversation's latest that isn't a draft. */
function replyTarget(detail: ThreadDetail | undefined): string | null {
  const sent = detail?.messages.filter((m) => !m.labelIds.includes("DRAFT")) ?? [];
  return sent[sent.length - 1]?.id ?? null;
}

/** Reply, Reply all or Forward the open conversation, from the account it's in. */
export async function respond(mode: ComposeMode): Promise<void> {
  const key = useUiStore.getState().openThread;
  if (key === null) return;
  const { accountId } = parseThreadKey(key);
  const threads = useThreadStore.getState();
  if (!threads.details.has(key)) await threads.load(key);
  const messageId = replyTarget(useThreadStore.getState().details.get(key));
  if (!messageId) return;
  await useComposeStore.getState().respond(accountId, messageId, mode);
}

/** A new message, from the account the sidebar is showing (or the open conversation's). */
export function composeNew(): void {
  const { activeAccountId, mailbox, openThread } = useUiStore.getState();
  const accounts = useAccountStore.getState().accounts;
  const preferred =
    mailbox.accountId ??
    (openThread === null ? activeAccountId : parseThreadKey(openThread).accountId);
  const accountId = resolveActiveAccount(preferred, accounts);
  if (accountId) useComposeStore.getState().compose(accountId);
}
