// Sends that left a panel, tracked until Gmail confirms them: Undo, a refused or unconfirmed send, and the notice for
// failed sends that no panel remembers after a restart. The store hands in what only it can do (`SendingHost`).
import { dismissToast, toast, toastError } from "../components/ui/Toast";
import { subscribeAll } from "../lib/subscriptions";
import {
  listen,
  cancelSend,
  discardAttachments,
  type FailedSend,
  failedSends,
  type OutboxSendStatus,
  reopenFailedSend,
  type StagedAttachment,
  SYNC_EVENTS,
} from "../lib/tauri";
import type { ComposeWindow } from "./composeStore";
import { forgetImages } from "./inlineImages";

/** A send waiting to leave or to be confirmed, with what's needed to reopen it. */
interface PendingSend {
  window: ComposeWindow;
  toastId: number | null;
}

/** What the store does for a send that comes back or needs opening. */
export interface SendingHost {
  /** Put a message back into a panel (after Undo or a refused send). */
  reopen(win: ComposeWindow, error: string | null): void;
  /** Open a saved draft in a panel. */
  editDraft(accountId: string, messageId: string): Promise<void>;
}

const pending = new Map<string, PendingSend>();
/**
 * Failed sends already told about this session, so a dismissed notice doesn't come back until the next launch
 * (when the send, still in the outbox, is shown again).
 */
const noticed = new Set<string>();
/** Accounts whose failed sends were listed this session. */
const checkedAccounts = new Set<string>();

/** Staged files nothing will read again. */
export const dropStaged = (attachments: StagedAttachment[]) => {
  if (attachments.length === 0) return;
  const ids = attachments.map((a) => a.id);
  forgetImages(attachments);
  void discardAttachments(ids).catch(() => {});
};

/** Track a send that reached the outbox, with the Undo toast for as long as it can still be taken back. */
export function trackSend(
  window: ComposeWindow,
  queued: { opId: string; sendAt: number },
  undoMs: number,
  host: SendingHost,
) {
  const entry: PendingSend = { window, toastId: null };
  pending.set(queued.opId, entry);
  const left = queued.sendAt - Date.now();
  entry.toastId = toast({
    title: "Sending…",
    duration: undoMs > 0 ? Math.max(left, 1000) : 0,
    action: undoMs > 0 ? { label: "Undo", run: () => void undo(queued.opId, host) } : undefined,
  });
}

/**
 * A send that didn't go through and that no panel is tracking (queued before a restart): say so until the
 * user opens it or dismisses the notice. Open puts it back in Drafts and opens it in a panel, where it can
 * be fixed and sent, or discarded.
 */
function noticeFailedSend(accountId: string, failed: FailedSend, host: SendingHost) {
  if (noticed.has(failed.opId) || pending.has(failed.opId)) return;
  noticed.add(failed.opId);
  const subject = failed.subject ? `“${failed.subject}”` : "your message";
  const first = [...failed.to, ...failed.cc, ...failed.bcc][0];
  const to = first ? ` to ${first.name?.trim() || first.address}` : "";
  const unconfirmed = failed.status === "unconfirmed";
  const reopenIt = async () => {
    try {
      const draft = await reopenFailedSend(accountId, failed.opId);
      if (draft) await host.editDraft(accountId, draft.messageId);
      else toast({ title: "That message isn't waiting to be sent any more." });
    } catch (e) {
      toastError(e);
      // Still in the outbox: offer it again.
      noticed.delete(failed.opId);
      noticeFailedSend(accountId, failed, host);
    }
  };
  toast({
    title: unconfirmed
      ? `Couldn't confirm ${subject}${to} was sent`
      : `Couldn't send ${subject}${to}`,
    description: unconfirmed
      ? "Check Sent before sending it again."
      : "Gmail didn't accept this message. Open it to fix it and send it again.",
    tone: "danger",
    duration: 0,
    action: { label: "Open", run: () => void reopenIt() },
  });
}

/** The account's failed sends, or the one `opId` names. */
async function noticeFailedSends(accountId: string, host: SendingHost, opId?: string) {
  let list: FailedSend[];
  try {
    list = await failedSends(accountId);
  } catch (e) {
    console.warn("couldn't list failed sends", e);
    return;
  }
  for (const failed of list)
    if (opId === undefined || failed.opId === opId) noticeFailedSend(accountId, failed, host);
}

/** Once per session per account: failed sends still in the outbox that no panel remembers. */
export async function checkFailedSends(accountId: string, host: SendingHost) {
  if (checkedAccounts.has(accountId)) return;
  checkedAccounts.add(accountId);
  await noticeFailedSends(accountId, host);
}

function onSendStatus(event: OutboxSendStatus, host: SendingHost) {
  const entry = pending.get(event.opId);
  if (!entry) {
    if (event.status === "failed" || event.status === "unconfirmed")
      void noticeFailedSends(event.accountId, host, event.opId);
    return;
  }
  if (event.status === "sent") {
    pending.delete(event.opId);
    if (entry.toastId !== null) dismissToast(entry.toastId);
    dropStaged(entry.window.draft.attachments);
    toast({ title: "Message sent" });
  } else if (event.status === "failed") {
    pending.delete(event.opId);
    if (entry.toastId !== null) dismissToast(entry.toastId);
    // Drop the refused send from the outbox; the message comes back to be fixed and sent again.
    void cancelSend(event.opId).catch(() => {});
    host.reopen(entry.window, "Gmail didn't accept this message.");
    toast({ title: "Couldn't send your message", tone: "danger" });
  } else if (event.status === "unconfirmed") {
    pending.delete(event.opId);
    // Told now; it stays in the outbox, so the next launch offers it again.
    noticed.add(event.opId);
    if (entry.toastId !== null) dismissToast(entry.toastId);
    // The message can't come back into a panel from here, so nothing reads its staged files again.
    dropStaged(entry.window.draft.attachments);
    toast({
      title: "Couldn't confirm your message was sent",
      description: "Check Sent before sending it again.",
      tone: "danger",
      duration: 0,
    });
  }
}

async function undo(opId: string, host: SendingHost) {
  const entry = pending.get(opId);
  if (!entry) return;
  let stopped = false;
  try {
    stopped = await cancelSend(opId);
  } catch (e) {
    toastError(e);
    return;
  }
  if (!stopped) {
    toast({ title: "Too late to undo", description: "The message has already left." });
    return;
  }
  pending.delete(opId);
  host.reopen(entry.window, null);
}

/** Listen for send outcomes. Resolves to the unlisten fn. */
export function listenSendStatus(host: SendingHost): Promise<() => void> {
  return subscribeAll([
    () => listen(SYNC_EVENTS.outboxSendStatus, ({ payload }) => onSendStatus(payload, host)),
  ]);
}

/** Test helper. */
export function __resetSendingForTests() {
  pending.clear();
  noticed.clear();
  checkedAccounts.clear();
}
