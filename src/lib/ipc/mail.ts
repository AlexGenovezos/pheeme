import { call, type CommandError } from "./call";

export interface ThreadCursor {
  lastMessageDate: number;
  accountId: string;
  threadId: string;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  fromName: string | null;
  fromAddress: string | null;
  /** ms since epoch; 0 if unknown. */
  date: number;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  messageCount: number;
  /** The thread's user labels (not system labels), sorted by label name. */
  labelIds: string[];
  /** The thread's system labels (INBOX, CATEGORY_*, SPAM, TRASH, SENT…), sorted. */
  systemLabelIds: string[];
}

export interface ThreadPage {
  threads: ThreadSummary[];
  next: ThreadCursor | null;
}

export interface ThreadQuery {
  accountIds: string[];
  labelId: string;
  /**
   * Second label the thread must also carry (e.g. INBOX ∩ CATEGORY_SOCIAL). `CATEGORY_PERSONAL`
   * (Primary) means the label minus the other four categories. `labelId: "ALL"` is All Mail.
   */
  alsoLabelId?: string | null;
  unreadOnly?: boolean;
}

export interface EmailAddress {
  name: string | null;
  address: string;
}

export interface AttachmentInfo {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  isInline: boolean;
  contentId: string | null;
}

export interface MessageDetail {
  id: string;
  threadId: string;
  fromName: string | null;
  fromAddress: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  snippet: string | null;
  date: number;
  /** Sanitized HTML fragment from the backend, never the raw email body. */
  bodyHtml: string | null;
  hasRemoteContent: boolean;
  declaresDarkMode: boolean;
  bodyText: string | null;
  /** False when only metadata is cached (the body couldn't be fetched, e.g. offline): offer to try again. */
  bodyAvailable: boolean;
  unread: boolean;
  starred: boolean;
  labelIds: string[];
  hasAttachment: boolean;
  attachments: AttachmentInfo[];
  /** How the message offers to unsubscribe (its `List-Unsubscribe` headers): `none` when it doesn't. */
  unsubscribe: "one_click" | "link" | "email" | "none";
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageDetail[];
  /** Set when bodies were missing and fetching them failed: why, in words for the user (no URLs). */
  bodyError: CommandError | null;
}
export interface MailboxCount {
  labelId: string;
  unread: number;
}

/** What `list_threads` takes: the mailbox, a page cursor and, in an unread-only mailbox, what stays. */
export type ListThreadsArgs = ThreadQuery & {
  before?: ThreadCursor | null;
  limit?: number;
  /** Account/thread pairs opened in this unread-only mailbox visit. */
  keepRead?: [string, string][];
};
export const listThreads = (query: ListThreadsArgs) => call("list_threads", { ...query });
/** User opens report fetch diagnostics; speculative preloads use bulk quota and stay silent. */
export const getThread = (accountId: string, threadId: string, opened = false, preload = false) =>
  call("get_thread", { accountId, threadId, opened, preload });
export const mailboxCounts = (accountIds: string[]) => call("mailbox_counts", { accountIds });
export const modifyThreads = (
  accountId: string,
  threadIds: string[],
  add: string[],
  remove: string[],
) => call("modify_threads", { accountId, threadIds, add, remove });
/** Marks every unread conversation in one inbox tab read (`category`: `CATEGORY_*`; Primary is `CATEGORY_PERSONAL`), including mail not downloaded yet. */
export const markInboxTabRead = (accountId: string, category: string) =>
  call("mark_inbox_tab_read", { accountId, category });
/** Marks every unread match of a search read in each account, including mail not downloaded yet. */
export const markSearchRead = (accountIds: string[], query: string) =>
  call("mark_search_read", { accountIds, query });
export const trashThreads = (accountId: string, threadIds: string[]) =>
  call("trash_threads", { accountId, threadIds });
/** Saves an attachment into the Downloads folder and resolves to the file's absolute path. */
export const saveAttachment = (accountId: string, messageId: string, attachmentId: string) =>
  call("save_attachment", { accountId, messageId, attachmentId });
/** One SPF, DKIM or DMARC result from the message's topmost `Authentication-Results` header. */
export interface AuthResult {
  method: "spf" | "dkim" | "dmarc";
  /** Lowercase: pass, fail, softfail, neutral, none… */
  result: string;
  /** What the header says after the result. */
  detail: string | null;
}

/** A message's source and the header summary Show original opens with (headers decoded). */
export interface OriginalMessage {
  messageId: string | null;
  /** The Date header, ms since epoch. */
  createdAt: number | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  auth: AuthResult[];
  /** The source as text, cut at 1 MB unless asked for in full. */
  source: string;
  truncated: boolean;
}
/** A message's source from Gmail (never cached): rejects with `network` when Gmail can't be reached. */
export const messageOriginal = (accountId: string, messageId: string, full = false) =>
  call("message_original", { accountId, messageId, full });
/** Saves a message's whole source into Downloads as an `.eml` and resolves to the file's path. */
export const saveOriginal = (accountId: string, messageId: string) =>
  call("save_original", { accountId, messageId });
/** An attachment's bytes for the preview panel (from the disk cache, else Gmail). */
export const readAttachment = (accountId: string, messageId: string, attachmentId: string) =>
  call("read_attachment", { accountId, messageId, attachmentId });
/** Starts caching the previewable attachments of these messages in the background; returns at once. */
export const prefetchAttachments = (accountId: string, messageIds: string[]) =>
  call("prefetch_attachments", { accountId, messageIds });
/** Opens an attachment in the default app for its type (documents and media only). */
export const openAttachment = (accountId: string, messageId: string, attachmentId: string) =>
  call("open_attachment", { accountId, messageId, attachmentId });
/** Shows a file saved by `saveAttachment` in the system file manager. */
export const revealDownload = (path: string) => call("reveal_download", { path });
/** Opens an http, https or mailto link from an email; anything else is rejected. */
export const openMailLink = (url: string) => call("open_mail_link", { url });
/** Opens a print window on `html` (a whole page) with the system's print dialog over it. */
export const printEmail = (title: string, html: string, allowRemote: boolean) =>
  call("print_email", { title, html, allowRemote });
export interface SyncProgress {
  accountId: string;
  syncedMessages: number;
  totalMessages: number | null;
  downloadedMessages: number;
  /** The whole-mailbox backfill has finished, independently of inbox readiness. */
  complete: boolean;
}

export const getSyncProgress = () => call("get_sync_progress");
/** Whether Google answered the last time it was asked. */
export const networkOnline = () => call("network_online");
