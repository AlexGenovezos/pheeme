// Typed wrappers around invoke(). Rust commands live in src-tauri/src/commands/.
import { invoke } from "@tauri-apps/api/core";

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
  | { kind: "sameAs"; accountId: string }
  /** Sign an existing account in again with its own client, keeping its mail. */
  | { kind: "reconnect"; accountId: string };

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

/** Gmail's per-user limit (quota units per minute) that sync paces itself by. */
export const getGmailQuota = () => invoke<number>("gmail_quota");
/** Change the Gmail limit; returns the stored value (out-of-range values are clamped). */
export const setGmailQuota = (perMinute: number) =>
  invoke<number>("set_gmail_quota", { perMinute });

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
  /** The thread's user labels (not system labels), sorted by label name. */
  labelIds: string[];
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
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageDetail[];
  /** Set when bodies were missing and fetching them failed: why, in words for the user (no URLs). */
  bodyError: CommandError | null;
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
  /** Gmail's `show` | `hide` | `showIfUnread`; null when Gmail didn't say. */
  messageListVisibility: string | null;
  /** Gmail's `labelShow` | `labelShowIfUnread` | `labelHide`; null when Gmail didn't say. */
  labelListVisibility: string | null;
}

/** A Gmail label colour pair; only values from Gmail's palette are accepted. */
export interface LabelColor {
  background: string;
  text: string;
}

/** Changes to one label; fields left out stay as they are. */
export interface LabelEdit {
  /** The full new path (`Clients/Acme`); renaming a parent renames its sublabels too. */
  name?: string;
  color?: LabelColor;
  clearColor?: boolean;
  /** `labelShow` | `labelShowIfUnread` | `labelHide`. */
  labelListVisibility?: string;
  /** `show` | `hide`. */
  messageListVisibility?: string;
}

/** What deleting a label takes with it. */
export interface LabelDeletePreview {
  /** Conversations with the label, per Gmail; null when Gmail couldn't be asked. */
  threads: number | null;
  /** Full names of the sublabels deleted with it. */
  sublabels: string[];
}

export interface LabelCount {
  labelId: string;
  unread: number;
  total: number;
}

export interface MailboxCount {
  labelId: string;
  unread: number;
}

export const listThreads = (
  query: ThreadQuery & {
    before?: ThreadCursor | null;
    limit?: number;
    /** Account/thread pairs opened in this unread-only mailbox visit. */
    keepRead?: [string, string][];
  },
) => invoke<ThreadPage>("list_threads", { ...query });
/**
 * `opened` is a user-initiated open (not a prefetch): missing bodies are fetched ahead of background sync and
 * `mail:thread_loading` reports what the fetch is waiting on.
 */
export const getThread = (accountId: string, threadId: string, opened = false) =>
  invoke<ThreadDetail>("get_thread", { accountId, threadId, opened });
export const listLabels = (accountId: string) => invoke<LabelInfo[]>("list_labels", { accountId });
export const mailboxCounts = (accountIds: string[]) =>
  invoke<MailboxCount[]>("mailbox_counts", { accountIds });
/** Unread and total conversations per label of one account, counted from the local cache. */
export const labelCounts = (accountId: string) =>
  invoke<LabelCount[]>("label_counts", { accountId });
/** Creates a user label in Gmail (`name` is the full path) and caches it. */
export const createLabel = (accountId: string, name: string, color: LabelColor | null) =>
  invoke<LabelInfo>("create_label", { accountId, name, color });
/** Edits a label in Gmail; resolves to every label changed (parent first, then sublabels). */
export const updateLabel = (accountId: string, labelId: string, edit: LabelEdit) =>
  invoke<LabelInfo[]>("update_label", { accountId, labelId, edit });
/** Deletes a label and its sublabels in Gmail; the conversations stay. */
export const deleteLabel = (accountId: string, labelId: string) =>
  invoke<void>("delete_label", { accountId, labelId });
export const deleteLabelPreview = (accountId: string, labelId: string) =>
  invoke<LabelDeletePreview>("delete_label_preview", { accountId, labelId });
export const modifyThreads = (
  accountId: string,
  threadIds: string[],
  add: string[],
  remove: string[],
) => invoke<void>("modify_threads", { accountId, threadIds, add, remove });
export const trashThreads = (accountId: string, threadIds: string[]) =>
  invoke<void>("trash_threads", { accountId, threadIds });
/** Saves an attachment into the Downloads folder and resolves to the file's absolute path. */
export const saveAttachment = (accountId: string, messageId: string, attachmentId: string) =>
  invoke<string>("save_attachment", { accountId, messageId, attachmentId });
/** Shows a file saved by `saveAttachment` in the system file manager. */
export const revealDownload = (path: string) => invoke<void>("reveal_download", { path });
/** Opens an http, https or mailto link from an email; anything else is rejected. */
export const openMailLink = (url: string) => invoke<void>("open_mail_link", { url });
export interface SearchPage extends ThreadPage {
  /** False when the query uses syntax only Gmail understands; then only Gmail answers. */
  local: boolean;
}

export interface GmailSearchPage {
  /** Newest first; cached by the backend, so they open like any thread. */
  threads: ThreadSummary[];
  /** Page token per account with more results; pass back as `pageTokens`. */
  next: Record<string, string>;
  /** Accounts whose Gmail search failed (offline, for example). */
  failed: string[];
}

/** Cached mail matching `query` (Gmail syntax), instantly. */
export const searchMessages = (
  accountIds: string[],
  query: string,
  before?: ThreadCursor | null,
  limit?: number,
) =>
  invoke<SearchPage>("search_messages", {
    accountIds,
    query,
    before: before ?? null,
    limit: limit ?? null,
  });
/** Gmail's search, for mail not cached yet. Omit `pageTokens` for the first page. */
export const searchGmail = (
  accountIds: string[],
  query: string,
  pageTokens?: Record<string, string> | null,
) => invoke<GmailSearchPage>("search_gmail", { accountIds, query, pageTokens: pageTokens ?? null });
export const recentSearches = () => invoke<string[]>("recent_searches");
export const addRecentSearch = (query: string) => invoke<void>("add_recent_search", { query });
/** Forget one recent search, or all of them when `query` is omitted. */
export const removeRecentSearch = (query?: string | null) =>
  invoke<void>("remove_recent_search", { query: query ?? null });

/** Sync one account now, or every account when omitted. */
// Compose (src-tauri/src/commands/compose.rs)

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
  invoke<ComposeDraft>("compose_template", { accountId, messageId, mode });
export const stageAttachment = (path: string) =>
  invoke<StagedAttachment>("stage_attachment", { path });
/** Call when a compose panel closes (sent, saved or discarded). */
export const discardAttachments = (ids: string[]) => invoke<void>("discard_attachments", { ids });
export const saveDraft = (accountId: string, message: ComposeDraft) =>
  invoke<SavedDraft>("save_draft", { accountId, message });
export const getDrafts = (accountId: string) => invoke<DraftSummary[]>("get_drafts", { accountId });
/** Open the draft behind a message in Drafts. */
export const openDraft = (accountId: string, messageId: string) =>
  invoke<ComposeDraft>("open_draft", { accountId, messageId });
export const deleteDraft = (accountId: string, draftId: string) =>
  invoke<void>("delete_draft", { accountId, draftId });
/** Queue a send; with `undoMs` it waits that long (max 60 s) so `cancelSend` can stop it. */
export const sendEmail = (accountId: string, message: ComposeDraft, undoMs?: number) =>
  invoke<QueuedSend>("send_email", { accountId, message, undoMs: undoMs ?? null });
/** Undo send: true if stopped before it left. */
export const cancelSend = (opId: string) => invoke<boolean>("cancel_send", { opId });

export const syncNow = (accountId?: string | null) =>
  invoke<void>("sync_now", { accountId: accountId ?? null });

export interface SyncProgress {
  accountId: string;
  syncedMessages: number;
  totalMessages: number | null;
  downloadedMessages: number;
  /** The whole-mailbox backfill has finished, independently of inbox readiness. */
  complete: boolean;
}

export const getSyncProgress = () => invoke<SyncProgress[]>("get_sync_progress");

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

/** Emitted while an opened thread's bodies are fetched from Gmail; cached opens emit nothing. */
export const THREAD_LOADING_EVENT = "mail:thread_loading";

export interface ThreadLoading {
  accountId: string;
  threadId: string;
  /** `queued`: waiting for a request slot or quota. `done`: the bodies are stored, or fetching them failed. */
  stage: "queued" | "fetching" | "retrying" | "done";
  /** Retries so far (0 for the first retry), while `retrying`. */
  attempt: number | null;
  retryInMs: number | null;
  reason: "rate_limited" | "network" | "server" | null;
  /** The account's initial sync or backfill is running. */
  syncBusy: boolean;
}

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

// ── Support ──────────────────────────────────────────────────────────────────

/**
 * Upload a scrubbed diagnostics bundle with the user's note (sent as typed). Rejects with `rate_limited`,
 * `network`, `rejected` or `too_large`.
 */
export const sendDiagnostics = (note: string, replyTo: string | null) =>
  invoke<void>("send_diagnostics", { note, replyTo });
/** Write the same bundle to `path` (chosen in a save dialog). */
export const saveDiagnostics = (note: string, replyTo: string | null, path: string) =>
  invoke<void>("save_diagnostics", { note, replyTo, path });
