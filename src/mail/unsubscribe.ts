// Unsubscribing from a mailing list, as Gmail does it beside the sender in an open message: one click
// when the sender supports it (RFC 8058), else its page opens or a message to the list is made ready.
// Rust's `senders::unsubscribe` does the work (the Stats window uses it too); this is what the window
// adds: asking first, remembering which senders are done, and saying what happened.
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import { type MessageDetail, openMailLink, toCommandError, unsubscribeSender } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { parseThreadKey } from "./mailboxes";

export const UNSUBSCRIBE_COMMAND = "conversation.unsubscribe";

/** `busy` while asking the sender, `done` once unsubscribed, `opened` once the page or the message is up. */
export type SenderState = "busy" | "done" | "opened";

/** One message, with what the confirmation needs to say. */
export interface UnsubscribeRequest {
  accountId: string;
  threadId: string;
  messageId: string;
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

/** What a result is remembered under: the message acted on, which is what Unsubscribe's link is read from. */
export const messageKey = (accountId: string, messageId: string) => `${accountId}\n${messageId}`;

function setSenderState(key: string, state: SenderState | undefined) {
  useUnsubscribeStore.setState((s) => {
    const senders = { ...s.senders };
    if (state) senders[key] = state;
    else delete senders[key];
    return { senders };
  });
}

/** Percent-decoded, or as written when it isn't valid percent-encoding. */
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The address and the fields Pheeme can fill in from a `mailto:` link (RFC 6068). */
export function parseMailto(url: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(url)) return null;
  const rest = url.slice("mailto:".length);
  const mark = rest.indexOf("?");
  const path = mark < 0 ? rest : rest.slice(0, mark);
  // Field names ignore case; the first of each counts. A `?` later in the query is part of a value.
  const params = new Map<string, string>();
  for (const pair of mark < 0 ? [] : rest.slice(mark + 1).split("&")) {
    const eq = pair.indexOf("=");
    const name = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!params.has(name)) params.set(name, decode(eq < 0 ? "" : pair.slice(eq + 1)));
  }
  const to = decode(path).split(",")[0]?.trim() || params.get("to")?.split(",")[0]?.trim() || "";
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
  who: string;
}): Promise<UnsubscribeOutcome> {
  const { accountId, who } = target;
  const key = messageKey(accountId, target.messageId ?? target.threadId);
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
      await openMailLink(result.web);
      setSenderState(key, "opened");
      toast({
        title: `Opened ${who}'s unsubscribe page`,
        description: "Finish there to stop their mail.",
      });
      return "opened";
    }
    const mail = result.mailto ? parseMailto(result.mailto) : null;
    if (mail) {
      const opened = useComposeStore.getState().compose(accountId, {
        to: [{ name: null, address: mail.to }],
        subject: mail.subject,
        bodyHtml: mail.body ? `<p>${escapeHtml(mail.body)}</p>` : "",
      });
      if (opened < 0) {
        // The compose panels are full (it said so): nothing is open, so try again later.
        setSenderState(key, undefined);
        return "failed";
      }
      setSenderState(key, "opened");
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
  // The user may have moved on while it loaded.
  if (useUiStore.getState().openThread !== key) return;
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
  const state = useUnsubscribeStore.getState().senders[messageKey(accountId, message.id)];
  if (state === "done") {
    toast({ title: `Already unsubscribed from ${message.fromName || message.fromAddress}` });
    return;
  }
  confirmUnsubscribe(accountId, message);
}

export function __resetUnsubscribedForTests() {
  useUnsubscribeStore.setState({ senders: {}, request: null });
}
