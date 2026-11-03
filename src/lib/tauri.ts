// Typed wrappers around invoke(). Rust commands live in src-tauri/src/commands/.
import { invoke } from "@tauri-apps/api/core";

export { invoke };

export interface AccountInfo {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string;
  /** The first sync has finished, so the cache is usable; false shows skeletons. */
  synced: boolean;
}

export type ClientChoice =
  | { kind: "new"; clientId: string; clientSecret: string }
  | { kind: "sameAs"; accountId: string };

export interface SignInStart {
  flowId: string;
  authUrl: string;
}

/** Every command rejects with this shape: a stable code and a plain-language message. */
export interface CommandError {
  code: string;
  message: string;
}

export function toCommandError(error: unknown): CommandError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  ) {
    return error as CommandError;
  }
  return { code: "internal", message: `Something went wrong: ${String(error)}` };
}

export const beginOauth = (client: ClientChoice) => invoke<SignInStart>("begin_oauth", { client });
/** Resolves when the browser sign-in finishes; rejects on failure, timeout or cancel. */
export const completeOauth = (flowId: string) => invoke<AccountInfo>("complete_oauth", { flowId });
export const cancelOauth = (flowId: string) => invoke<void>("cancel_oauth", { flowId });
export const refreshToken = (accountId: string) => invoke<void>("refresh_token", { accountId });
export const listAccounts = () => invoke<AccountInfo[]>("list_accounts");
export const removeAccount = (accountId: string) => invoke<void>("remove_account", { accountId });
/** Opens an allow-listed https URL (Google, Pheeme) in the default browser. */
export const openExternal = (url: string) => invoke<void>("open_external", { url });

// ── Mail (Phase 4 sync engine) ───────────────────────────────────────────────

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
  unread: boolean;
  starred: boolean;
  labelIds: string[];
  hasAttachment: boolean;
  attachments: AttachmentInfo[];
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageDetail[];
}

export interface LabelInfo {
  id: string;
  accountId: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
  colorBackground: string | null;
  colorText: string | null;
}

export interface MailboxCount {
  labelId: string;
  unread: number;
}

export const listThreads = (query: ThreadQuery & { before?: ThreadCursor | null; limit?: number }) =>
  invoke<ThreadPage>("list_threads", { ...query });
export const getThread = (accountId: string, threadId: string) =>
  invoke<ThreadDetail>("get_thread", { accountId, threadId });
export const listLabels = (accountId: string) => invoke<LabelInfo[]>("list_labels", { accountId });
export const mailboxCounts = (accountIds: string[]) => invoke<MailboxCount[]>("mailbox_counts", { accountIds });
/** Unread conversations per label of one account, counted from the local cache. */
export const labelCounts = (accountId: string) => invoke<MailboxCount[]>("label_counts", { accountId });
export const modifyThreads = (accountId: string, threadIds: string[], add: string[], remove: string[]) =>
  invoke<void>("modify_threads", { accountId, threadIds, add, remove });
export const trashThreads = (accountId: string, threadIds: string[]) =>
  invoke<void>("trash_threads", { accountId, threadIds });
/** Saves an attachment into the Downloads folder and resolves to the file's absolute path. */
export const saveAttachment = (accountId: string, messageId: string, attachmentId: string) =>
  invoke<string>("save_attachment", { accountId, messageId, attachmentId });
/** Shows a file saved by `saveAttachment` in the system file manager. */
export const revealDownload = (path: string) => invoke<void>("reveal_download", { path });
/** Opens an http, https or mailto link from an email; anything else is rejected. */
export const openMailLink = (url: string) => invoke<void>("open_mail_link", { url });
/** Sync one account now, or every account when omitted. */
export const syncNow = (accountId?: string | null) => invoke<void>("sync_now", { accountId: accountId ?? null });

/** Call an event unlisten fn, ignoring failures (e.g. the IPC bridge is already gone). */
export function stopQuietly(stop: () => void) {
  try {
    void Promise.resolve(stop() as unknown).catch(() => {});
  } catch {
    // Nothing to clean up.
  }
}

export const SYNC_EVENTS = {
  started: "sync:started",
  messagesUpdated: "sync:messages_updated",
  labelsUpdated: "sync:labels_updated",
  completed: "sync:completed",
  error: "sync:error",
  outboxRejected: "outbox:rejected",
  outboxSendStatus: "outbox:send_status",
} as const;

export interface SyncAccountEvent {
  accountId: string;
}

export interface SyncMessagesUpdated extends SyncAccountEvent {
  /** Thread ids. */
  added: string[];
  removed: string[];
  modified: string[];
}

export interface SyncErrorEvent extends SyncAccountEvent {
  code: string;
  message: string;
}

export interface OutboxRejected extends SyncAccountEvent {
  opId: string;
  kind: string;
  message: string;
}

export interface OutboxSendStatus extends SyncAccountEvent {
  opId: string;
  status: string;
}
