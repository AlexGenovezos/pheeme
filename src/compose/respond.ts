// Starting a message from the mail view: a new one, or a reply to the open conversation.
import { toast } from "../components/ui/Toast";
import { type ComposeMode, type ThreadDetail } from "../lib/tauri";
import { targets } from "../mail/change";
import { resolveActiveAccount, parseThreadKey, type ThreadKey } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { useComposeStore } from "./composeStore";

/** The message a Reply, Reply all or Forward answers: the conversation's latest that isn't a draft. */
export function replyTarget(detail: ThreadDetail | undefined): string | null {
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

/** The palette command and menus' Forward as attachment for conversations. */
export const FORWARD_AS_ATTACHMENT_COMMAND = "conversation.forward-attachment";

/**
 * Forward as attachment: one new message with every message of the conversations (`keys`, else the checked ones,
 * else the open one) attached as `.eml` files, from the account they're in. Gmail has no selection spanning
 * accounts, so one that does is turned down rather than split or sent from an account the mail isn't in.
 */
export async function forwardConversationsAsAttachment(
  keys: ThreadKey[] = targets(),
): Promise<void> {
  if (keys.length === 0) return;
  const parsed = keys.map(parseThreadKey);
  const accountId = parsed[0]!.accountId;
  if (parsed.some((k) => k.accountId !== accountId)) {
    toast({ title: "Forward conversations from one account at a time.", tone: "danger" });
    return;
  }
  await useComposeStore
    .getState()
    .forwardAsAttachment(accountId, { threadIds: parsed.map((k) => k.threadId) });
}

/** Forward as attachment: one message, from its own menu. */
export async function forwardMessageAsAttachment(
  accountId: string,
  messageId: string,
): Promise<void> {
  await useComposeStore.getState().forwardAsAttachment(accountId, { messageIds: [messageId] });
}
