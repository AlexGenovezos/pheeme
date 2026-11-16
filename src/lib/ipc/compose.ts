import { call } from "./call";
import type { EmailAddress } from "./mail";

/** An attachment held for the compose panel; `id` is a handle, not a path. */
export interface StagedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Set for images the quoted HTML shows via `cid:`; sent inline. */
  contentId?: string | null;
}

/** A message being written: new, reply, forward or an opened draft. */
export interface ComposeDraft {
  /** The address it goes out from (the account's own or a send-as alias); `null` for the account's default. */
  from?: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** The editor's HTML. */
  bodyHtml: string;
  /** Reply/forward: the quoted original, sent below the body (show it collapsed). */
  quoteHtml?: string | null;
  attachments: StagedAttachment[];
  inReplyTo?: string | null;
  references: string[];
  threadId?: string | null;
  /** The saved Gmail draft this updates; set it from `saveDraft`'s result. */
  draftId?: string | null;
}

export type ComposeMode = "reply" | "replyAll" | "forward";

export interface SavedDraft {
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  subject: string | null;
  to: EmailAddress[];
  snippet: string | null;
  date: number;
}

export interface QueuedSend {
  /** Outbox op: pass to `cancelSend`; progress arrives as `outbox:send_status`. */
  opId: string;
  /** Unix ms when it leaves; undo works until then. */
  sendAt: number;
}

export const composeTemplate = (accountId: string, messageId: string, mode: ComposeMode) =>
  call("compose_template", { accountId, messageId, mode });
/** The account's signature as set in Gmail (HTML), or `null` when it has none. */
export const gmailSignature = (accountId: string) => call("gmail_signature", { accountId });
/** An account's choices in Settings › Compose, as Pheeme keeps them for every compose path (AI drafts too). */
export interface SignatureSettings {
  newMessages: "gmail" | "custom" | "none";
  replies: "gmail" | "custom" | "none";
  custom: string;
}
/** The account's saved signature choices, or `null` if none were ever saved. */
export const getSignatureSettings = (accountId: string) =>
  call("signature_settings", { accountId });
export const setSignatureSettings = (accountId: string, settings: SignatureSettings) =>
  call("set_signature_settings", { accountId, settings });
/** An address an account can send from (Gmail's "Send mail as"): its own, or a verified alias. */
export interface SendAsAddress {
  email: string;
  name: string | null;
  isPrimary: boolean;
  /** Gmail's default for new messages. */
  isDefault: boolean;
  /** This address's Gmail signature (HTML), `null` when it has none. */
  signature: string | null;
}
/** The addresses the account can send from, its own first. */
export const sendAsAddresses = (accountId: string) => call("send_as_addresses", { accountId });
export const stageAttachment = (path: string) => call("stage_attachment", { path });
/** Call when a compose panel closes (sent, saved or discarded). */
export const discardAttachments = (ids: string[]) => call("discard_attachments", { ids });
export const saveDraft = (accountId: string, message: ComposeDraft) =>
  call("save_draft", { accountId, message });
/** Open the draft behind a message in Drafts. */
export const openDraft = (accountId: string, messageId: string) =>
  call("open_draft", { accountId, messageId });
export const deleteDraft = (accountId: string, draftId: string) =>
  call("delete_draft", { accountId, draftId });
/** Queue a send; with `undoMs` it waits that long (max 60 s) so `cancelSend` can stop it. */
export const sendEmail = (accountId: string, message: ComposeDraft, undoMs?: number) =>
  call("send_email", { accountId, message, undoMs: undoMs ?? null });
/** Undo send: true if stopped before it left. */
export const cancelSend = (opId: string) => call("cancel_send", { opId });

/** A send still in the outbox that didn't go through (`sync::outbox::FailedSend`). */
export interface FailedSend {
  opId: string;
  /** `failed`: Gmail refused it, so it wasn't sent. `unconfirmed`: Gmail may have it; it never showed in Sent. */
  status: "failed" | "unconfirmed";
  subject: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  /** Why Gmail refused it; `null` when unconfirmed. */
  error: string | null;
  threadId: string | null;
  queuedAt: number;
  failedAt: number;
}

/** The account's failed and unconfirmed sends, oldest first. */
export const failedSends = (accountId: string) => call("failed_sends", { accountId });
/**
 * Put a failed or unconfirmed send back in the account's Drafts (out of the outbox), to open with `openDraft`
 * by `messageId`. `null` when it went meanwhile.
 */
export const reopenFailedSend = (accountId: string, opId: string) =>
  call("reopen_failed_send", { accountId, opId });
