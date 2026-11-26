// Unsubscribing from a mailing list, as Gmail does it beside the sender in an open message: one click
// when the sender supports it (RFC 8058), else its page opens or a message to the list is made ready.
// Rust's `senders::unsubscribe` does the work (the Stats window uses it too); this is what the window
// adds: asking first, remembering which senders are done, and saying what happened.
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import { type MessageDetail, toCommandError, unsubscribeSender } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { openLink } from "./linkify";
import { parseThreadKey } from "./mailboxes";

export const UNSUBSCRIBE_COMMAND = "conversation.unsubscribe";

/** `busy` while asking the sender, `done` once unsubscribed, `opened` once the page or the message is up. */
export type SenderState = "busy" | "done" | "opened";

/** One message, with what the confirmation needs to say. */
export interface UnsubscribeRequest {
  accountId: string;
  threadId: string;
  messageId: string;
  address: string;
  /** Who it's from, as the message shows it. */
  who: string;
  method: Exclude<MessageDetail["unsubscribe"], "none">;
}

interface UnsubscribeStore {
  /** Senders handled this session, so no screen offers Unsubscribe from them again. */
  senders: Record<string, SenderState>;
  /** The confirmation being asked, if any. */
  request: UnsubscribeRequest | null;
}
export const useUnsubscribeStore = create<UnsubscribeStore>(() => ({ senders: {}, request: null }));

/** The list a message came from: its account and sender address, as the Stats window names a sender. */
export const senderKey = (accountId: string, address: string) =>
  `${accountId}\n${address.toLowerCase()}`;

function setSenderState(key: string, state: SenderState | undefined) {
  useUnsubscribeStore.setState((s) => {
    const senders = { ...s.senders };
    if (state) senders[key] = state;
    else delete senders[key];
    return { senders };
  });
}

/** The address and the fields Pheeme can fill in from a `mailto:` link. */
export function parseMailto(url: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(url)) return null;
  const [path, query = ""] = url.slice("mailto:".length).split("?", 2);
  const params = new URLSearchParams(query);
  const to = decodeURIComponent(path).split(",")[0]?.trim() || params.get("to") || "";
  if (!to) return null;
  return {
    to,
    subject: params.get("subject") ?? "unsubscribe",
    body: params.get("body") ?? "",
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What came of it: `email` means a message is open to send, so the caller may need to get out of the way. */
export type UnsubscribeOutcome = "done" | "opened" | "email" | "none" | "failed";

/** Unsubscribe from the list `messageId` came from, and tell the user what happened. */
export async function unsubscribeFrom(target: {
  accountId: string;
  threadId: string;
  messageId: string | null;
  /** The sender's address, which the result is remembered under. */
  address: string;
  who: string;
}): Promise<UnsubscribeOutcome> {
  const { accountId, address, who } = target;
  const key = senderKey(accountId, address);
  setSenderState(key, "busy");
  try {
    const result = await unsubscribeSender(accountId, target.threadId, target.messageId);
    if (result.unsubscribed) {
      setSenderState(key, "done");
      toast({
        title: `Unsubscribed from ${who}`,
        description: "Some lists take a few days to stop.",
      });
      return "done";
    }
    if (result.web) {
      setSenderState(key, "opened");
      openLink(result.web);
      toast({
        title: `Opened ${who}'s unsubscribe page`,
        description: "Finish there to stop their mail.",
      });
      return "opened";
    }
    const mail = result.mailto ? parseMailto(result.mailto) : null;
    if (mail) {
      setSenderState(key, "opened");
      useComposeStore.getState().compose(accountId, {
        to: [{ name: null, address: mail.to }],
        subject: mail.subject,
        bodyHtml: mail.body ? `<p>${escapeHtml(mail.body)}</p>` : "",
      });
      toast({
        title: `${who} unsubscribes by email`,
        description: "Send the message that just opened to stop their mail.",
      });
      return "email";
    }
    setSenderState(key, undefined);
    toast({
      title: `${who} doesn't offer unsubscribing`,
      description: "A sender rule or filter can file their mail instead.",
    });
    return "none";
  } catch (raw) {
    setSenderState(key, undefined);
    toast({
      title: `Couldn't unsubscribe from ${who}`,
      description: toCommandError(raw).message,
      tone: "danger",
    });
    return "failed";
  }
}

/** Ask "Unsubscribe from …?" for `message`. */
export function confirmUnsubscribe(accountId: string, message: MessageDetail) {
  if (message.unsubscribe === "none" || !message.fromAddress) return;
  useUnsubscribeStore.setState({
    request: {
      accountId,
      threadId: message.threadId,
      messageId: message.id,
      address: message.fromAddress,
      who: message.fromName || message.fromAddress,
      method: message.unsubscribe,
    },
  });
}

/** The newest message of a conversation that offers unsubscribing and isn't the account's own or a draft. */
export function unsubscribableMessage(
  messages: MessageDetail[],
  ownAddress: string | undefined,
): MessageDetail | undefined {
  return [...messages]
    .reverse()
    .find(
      (m) =>
        m.unsubscribe !== "none" &&
        !!m.fromAddress &&
        !m.labelIds.includes("DRAFT") &&
        m.fromAddress.toLowerCase() !== ownAddress,
    );
}

/** Whether the conversation `key` is known to have nothing to unsubscribe from (one still loading may). */
export function lacksUnsubscribe(key: string): boolean {
  const detail = useThreadStore.getState().details.get(key);
  if (!detail) return false;
  const { accountId } = parseThreadKey(key);
  const own = useAccountStore
    .getState()
    .accounts.find((a) => a.id === accountId)
    ?.email.toLowerCase();
  return !unsubscribableMessage(detail.messages, own);
}

/** The command and the More menu: ask about the open conversation's latest message that offers it. */
export async function unsubscribeOpenConversation() {
  const key = useUiStore.getState().openThread;
  if (!key) {
    toast({ title: "Open a conversation to unsubscribe from it." });
    return;
  }
  const { accountId } = parseThreadKey(key);
  const threads = useThreadStore.getState();
  if (!threads.details.has(key)) await threads.load(key);
  const detail = useThreadStore.getState().details.get(key);
  const own = useAccountStore
    .getState()
    .accounts.find((a) => a.id === accountId)
    ?.email.toLowerCase();
  const message = unsubscribableMessage(detail?.messages ?? [], own);
  if (!message) {
    toast({
      title: "This conversation has no unsubscribe link",
      description: "A sender rule or filter can file the sender's mail instead.",
    });
    return;
  }
  const state = useUnsubscribeStore.getState().senders[senderKey(accountId, message.fromAddress!)];
  if (state === "done" || state === "opened") {
    toast({ title: `Already unsubscribed from ${message.fromName || message.fromAddress}` });
    return;
  }
  confirmUnsubscribe(accountId, message);
}

export function __resetUnsubscribedForTests() {
  useUnsubscribeStore.setState({ senders: {}, request: null });
}
