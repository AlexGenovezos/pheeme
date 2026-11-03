import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  type AccountInfo,
  type LabelCount,
  type LabelInfo,
  type MailboxCount,
  type MessageDetail,
  SYNC_EVENTS,
  type SyncMessagesUpdated,
  type ThreadDetail,
  type ThreadPage,
  type ThreadSummary,
} from "../lib/tauri";
import {
  CATEGORY_IDS,
  createFixtureThreads,
  fixtureAccounts,
  fixtureUserLabels,
  type FixtureThread,
  hasLabel,
  lastMessage,
  SYSTEM_LABELS,
  threadDate,
  threadsIn,
} from "./fixtures";

type Args = Record<string, unknown> | undefined;

const accountIdsOf = (args: Args): string[] => (Array.isArray(args?.accountIds) ? args.accountIds.map(String) : []);
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** The account's system labels and user labels, shaped like `list_labels`. */
function labelsFor(accountId: string): LabelInfo[] {
  const base = { accountId, messagesTotal: 0, messagesUnread: 0, threadsTotal: 0, threadsUnread: 0, colorText: null };
  return [
    ...SYSTEM_LABELS.map((l) => ({ ...base, id: l.id, name: l.name, type: "system", colorBackground: null })),
    ...fixtureUserLabels
      .filter((l) => l.accountId === accountId)
      .map((l) => ({ ...base, id: l.id, name: l.name, type: "user", colorBackground: l.color ?? null })),
  ];
}

/** A fixture thread as `list_threads` returns it. */
export function toSummary(t: FixtureThread): ThreadSummary {
  const last = lastMessage(t);
  return {
    id: t.id,
    accountId: t.accountId,
    subject: t.subject,
    snippet: last.bodyText?.replace(/\s+/g, " ").trim().slice(0, 140) ?? null,
    fromName: last.fromName,
    fromAddress: last.fromAddress,
    date: threadDate(t),
    unread: hasLabel(t, "UNREAD"),
    starred: hasLabel(t, "STARRED"),
    hasAttachment: t.messages.some((m) => m.attachments.some((a) => !a.isInline)),
    messageCount: t.messages.length,
  };
}

/** A fixture thread as `get_thread` returns it: copies, so later fixture changes don't alias what a store holds. */
function toDetail(t: FixtureThread): ThreadDetail {
  const messages: MessageDetail[] = t.messages.map((m) => ({
    id: m.id,
    threadId: t.id,
    fromName: m.fromName,
    fromAddress: m.fromAddress,
    to: [...m.to],
    cc: [...m.cc],
    subject: t.subject,
    snippet: m.bodyText?.replace(/\s+/g, " ").trim().slice(0, 140) ?? null,
    date: m.date,
    bodyHtml: m.bodyHtml,
    hasRemoteContent: m.hasRemoteContent,
    declaresDarkMode: m.declaresDarkMode,
    bodyText: m.bodyText,
    unread: m.unread,
    starred: t.labelIds.includes("STARRED"),
    labelIds: m.unread ? [...t.labelIds, "UNREAD"] : [...t.labelIds],
    hasAttachment: m.attachments.length > 0,
    attachments: m.attachments.map((a) => ({ ...a })),
  }));
  return { thread: toSummary(t), messages };
}

/** One stateful backend for both onboarding and the shell in browser preview. */
export function createPreviewHandlers(search = ""): Record<string, (args: Args) => unknown> {
  const params = new URLSearchParams(search);
  const accounts: AccountInfo[] = params.get("accounts") === "0" ? [] : fixtureAccounts
    .slice(0, params.get("accounts") === "1" ? 1 : undefined)
    .map((account) => ({ ...account, clientId: "1.apps.googleusercontent.com", synced: true }));
  const flows = new Set<string>();
  const threads = createFixtureThreads();

  /** Apply `change` to the named threads, then tell the stores, as the backend does after a cache write. */
  const changeThreads = (args: Args, change: (t: FixtureThread) => void): void => {
    const accountId = String(args?.accountId);
    const changed = threads.filter((t) => t.accountId === accountId && stringsOf(args?.threadIds).includes(t.id));
    changed.forEach(change);
    const payload: SyncMessagesUpdated = { accountId, added: [], removed: [], modified: changed.map((t) => t.id) };
    // Fire and forget: the IPC mock isn't there when a test calls a handler directly.
    void emit(SYNC_EVENTS.messagesUpdated, payload).catch(() => {});
  };

  return {
    greet: (args) => `Hello, ${String(args?.name ?? "world")}! (preview)`,
    list_accounts: () => [...accounts],
    list_labels: (args) => labelsFor(String(args?.accountId)),
    list_threads: (args): ThreadPage => ({
      threads: threadsIn(
        threads,
        String(args?.labelId ?? "INBOX"),
        args?.alsoLabelId ? String(args.alsoLabelId) : null,
        accountIdsOf(args),
      ).map(toSummary),
      next: null,
    }),
    get_thread: (args) => {
      const t = threads.find((f) => f.id === args?.threadId && f.accountId === args?.accountId);
      if (!t) throw { code: "not_found", message: "That conversation isn't on this device." };
      return toDetail(t);
    },
    // Unread inbox conversations, overall and per category, for the accounts asked about.
    mailbox_counts: (args): MailboxCount[] => {
      const ids = accountIdsOf(args);
      const unread = (category: string | null) =>
        threadsIn(threads, "INBOX", category, ids).filter((t) => hasLabel(t, "UNREAD")).length;
      return [{ labelId: "INBOX", unread: unread(null) }, ...CATEGORY_IDS.map((c) => ({ labelId: c, unread: unread(c) }))];
    },
    // Like the backend: counts thread-label rows (so no ALL, and Primary has no row of its own).
    label_counts: (args): LabelCount[] => {
      const mine = threads.filter((t) => t.accountId === args?.accountId);
      const labelIds = new Set(mine.flatMap((t) => t.labelIds));
      return [...labelIds].sort().map((labelId) => {
        const members = mine.filter((t) => hasLabel(t, labelId));
        return { labelId, unread: members.filter((t) => hasLabel(t, "UNREAD")).length, total: members.length };
      });
    },
    sync_now: () => undefined,
    modify_threads: (args) => {
      const add = stringsOf(args?.add);
      const remove = stringsOf(args?.remove);
      if ([...add, ...remove].some((l) => l === "TRASH" || l === "SPAM")) {
        throw { code: "invalid", message: "Use trash for Trash." };
      }
      return changeThreads(args, (t) => {
        for (const label of remove) {
          if (label === "UNREAD") t.messages.forEach((m) => (m.unread = false));
          else t.labelIds = t.labelIds.filter((l) => l !== label);
        }
        for (const label of add) {
          // Gmail marks the newest message unread; the rest keep their state.
          if (label === "UNREAD") lastMessage(t).unread = true;
          else if (!t.labelIds.includes(label)) t.labelIds.push(label);
        }
      });
    },
    trash_threads: (args) =>
      changeThreads(args, (t) => {
        t.labelIds = [...t.labelIds.filter((l) => l !== "INBOX"), "TRASH"];
      }),
    begin_oauth: () => {
      const flowId = crypto.randomUUID();
      flows.add(flowId);
      return { flowId, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" };
    },
    complete_oauth: async (args) => {
      const flowId = String(args?.flowId);
      await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 2500)));
      if (!flows.delete(flowId)) throw { code: "cancelled", message: "Sign-in cancelled." };
      const fail = params.get("fail");
      if (fail) throw { code: fail, message: `Mock failure: ${fail}.` };
      const account = accounts.find((a) => a.email === "you@example.com") ?? {
        id: crypto.randomUUID(), email: "you@example.com", displayName: "You", clientId: "1.apps.googleusercontent.com", synced: true,
      };
      if (!accounts.includes(account)) accounts.push(account);
      return account;
    },
    cancel_oauth: (args) => { flows.delete(String(args?.flowId)); },
    remove_account: (args) => {
      const index = accounts.findIndex((a) => a.id === args?.accountId);
      if (index !== -1) accounts.splice(index, 1);
    },
    open_external: () => undefined,
    open_mail_link: () => undefined,
    save_attachment: () => "/Users/you/Downloads/attachment.pdf",
    reveal_download: () => undefined,
    "plugin:updater|check": () => null,
  };
}

export let previewHandlers = createPreviewHandlers();

export function handlePreviewCommand(cmd: string, args?: unknown): unknown {
  const handler = previewHandlers[cmd];
  if (handler) return handler(args as Args);
  console.warn(`[preview] no fixture for "${cmd}"; returning null`);
  return null;
}

/** Make invoke() and window APIs answer from fixtures in a plain browser. */
export function installPreview() {
  previewHandlers = createPreviewHandlers(location.search);
  mockWindows("main");
  mockIPC(handlePreviewCommand, { shouldMockEvents: true });
}
