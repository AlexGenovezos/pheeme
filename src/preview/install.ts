import { createModHandlers } from "./mods";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  type AccountInfo,
  type LabelCount,
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
  type FixtureThread,
  generatedThreads,
  hasLabel,
  lastMessage,
  threadDate,
  threadsIn,
} from "./fixtures";
import { createComposeHandlers } from "./compose";
import { sampleAttachment } from "./attachments";
import { createLabelHandlers, createPreviewLabels, labelsFor, type PreviewLabel } from "./labels";
import { createSenderRuleHandlers } from "./senderRules";
import { createContactHandlers } from "./contacts";
import { createTransferHandlers } from "./transfer";

type Args = Record<string, unknown> | undefined;
/** Browser-test hook installed before startup, so speculative reads see the same fixtures as opens. */
export type PreviewInvoke = (cmd: string, args: Args, next: typeof handlePreviewCommand) => unknown;

const accountIdsOf = (args: Args): string[] =>
  Array.isArray(args?.accountIds) ? args.accountIds.map(String) : [];
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** The thread's user labels, sorted by name like the backend's rows. */
function userLabelIds(t: FixtureThread, labels: PreviewLabel[]): string[] {
  return labels
    .filter((l) => l.accountId === t.accountId && t.labelIds.includes(l.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => l.id);
}

/** A fixture thread as `list_threads` returns it. */
export function toSummary(t: FixtureThread, labels: PreviewLabel[]): ThreadSummary {
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
    labelIds: userLabelIds(t, labels),
    systemLabelIds: [
      ...t.labelIds.filter((id) => !labels.some((l) => l.accountId === t.accountId && l.id === id)),
      ...(hasLabel(t, "UNREAD") ? ["UNREAD"] : []),
    ].sort(),
  };
}

/** A fixture thread as `get_thread` returns it: copies, so later fixture changes don't alias what a store holds. */
function toDetail(t: FixtureThread, labels: PreviewLabel[]): ThreadDetail {
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
    bodyAvailable: true,
    unread: m.unread,
    starred: t.labelIds.includes("STARRED"),
    labelIds: m.unread ? [...t.labelIds, "UNREAD"] : [...t.labelIds],
    hasAttachment: m.attachments.length > 0,
    attachments: m.attachments.map((a) => ({ ...a })),
  }));
  return { thread: toSummary(t, labels), messages, bodyError: null };
}

/** One stateful backend for both onboarding and the shell in browser preview. */
export function createPreviewHandlers(search = ""): Record<string, (args: Args) => unknown> {
  const params = new URLSearchParams(search);
  const accounts: AccountInfo[] =
    params.get("accounts") === "0"
      ? []
      : fixtureAccounts.slice(0, params.get("accounts") === "1" ? 1 : undefined).map((account) => ({
          ...account,
          clientId: "1.apps.googleusercontent.com",
          synced: true,
        }));
  const flows = new Set<string>();
  const beginSignIn = () => {
    const flowId = crypto.randomUUID();
    flows.add(flowId);
    return { flowId, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" };
  };
  const threads = [
    ...createFixtureThreads(),
    ...generatedThreads(Number(params.get("threads")) || 0),
  ];
  const labels = createPreviewLabels();
  const summary = (t: FixtureThread) => toSummary(t, labels);

  /** Apply `change` to the named threads, then tell the stores, as the backend does after a cache write. */
  const changeThreads = (args: Args, change: (t: FixtureThread) => void): void => {
    const accountId = String(args?.accountId);
    const changed = threads.filter(
      (t) => t.accountId === accountId && stringsOf(args?.threadIds).includes(t.id),
    );
    changed.forEach(change);
    const payload: SyncMessagesUpdated = {
      accountId,
      added: [],
      removed: [],
      modified: changed.map((t) => t.id),
    };
    // Fire and forget: the IPC mock isn't there when a test calls a handler directly.
    void emit(SYNC_EVENTS.messagesUpdated, payload).catch(() => {});
  };

  let recent: string[] = [];
  const notificationChoices = new Map<string, boolean>();
  let gmailQuota = 6000;
  let trayIcon = true;
  let notifySchedule = { mode: "always", startHour: 9, endHour: 17, weekdaysOnly: true };
  let telemetry = true;
  const inboxTabs = new Map<string, string[]>();
  const hiddenTabs = (accountId: string) => inboxTabs.get(accountId) ?? [];
  const desktopSettings = () => ({
    accounts: accounts.map((a) => ({
      accountId: a.id,
      email: a.email,
      enabled: notificationChoices.get(a.id) ?? false,
      asked: notificationChoices.has(a.id),
    })),
    permission: "system",
    trayAvailable: false,
    trayEnabled: trayIcon,
    schedule: notifySchedule,
  });
  return {
    greet: (args) => `Hello, ${String(args?.name ?? "world")}! (preview)`,
    list_accounts: () => [...accounts],
    get_sync_progress: () =>
      accounts.map((account) => {
        const count = threads
          .filter((t) => t.accountId === account.id)
          .reduce((total, thread) => total + thread.messages.length, 0);
        return {
          accountId: account.id,
          syncedMessages: count,
          totalMessages: count,
          downloadedMessages: count,
          complete: true,
        };
      }),
    desktop_settings: desktopSettings,
    set_account_notifications: (args) => {
      notificationChoices.set(String(args?.accountId), args?.enabled === true);
      return desktopSettings();
    },
    answer_notification_prompt: (args) => {
      for (const a of accounts)
        if (!notificationChoices.has(a.id)) notificationChoices.set(a.id, args?.enable === true);
      return desktopSettings();
    },
    set_tray_icon: (args) => {
      trayIcon = args?.shown === true;
      return desktopSettings();
    },
    set_notification_schedule: (args) => {
      notifySchedule = { ...notifySchedule, ...(args?.schedule as typeof notifySchedule) };
      return desktopSettings();
    },
    take_notification_target: () => null,
    gmail_quota: () => gmailQuota,
    set_gmail_quota: (args) => {
      gmailQuota = Math.min(1_200_000, Math.max(600, Number(args?.perMinute) || 6000));
      return gmailQuota;
    },
    list_labels: (args) => labelsFor(labels, String(args?.accountId)),
    inbox_tabs: (args) => [...(inboxTabs.get(String(args?.accountId)) ?? [])],
    // Like the backend: keeps only the four hideable tabs, then tells the stores to reload.
    set_inbox_tabs: (args) => {
      const accountId = String(args?.accountId);
      const hidden = CATEGORY_IDS.filter(
        (c) => c !== "CATEGORY_PERSONAL" && stringsOf(args?.hidden).includes(c),
      );
      inboxTabs.set(accountId, hidden);
      void emit(SYNC_EVENTS.labelsUpdated, { accountId }).catch(() => {});
      return [...hidden];
    },
    ...createLabelHandlers(labels, threads),
    ...createSenderRuleHandlers(
      threads,
      (id) => accounts.find((a) => a.id === id)?.email,
      params.get("senderRules") === "missing",
    ),
    ...createContactHandlers(
      threads,
      (id) => accounts.find((a) => a.id === id)?.email,
      params.get("contacts"),
    ),
    list_threads: (args): ThreadPage => ({
      threads: threadsIn(
        threads,
        String(args?.labelId ?? "INBOX"),
        args?.alsoLabelId ? String(args.alsoLabelId) : null,
        accountIdsOf(args),
        hiddenTabs,
      )
        .filter(
          (t) =>
            !args?.unreadOnly ||
            hasLabel(t, "UNREAD") ||
            (Array.isArray(args?.keepRead) &&
              args.keepRead.some(
                (pair) => Array.isArray(pair) && pair[0] === t.accountId && pair[1] === t.id,
              )),
        )
        .map(summary),
      next: null,
    }),
    get_thread: (args) => {
      const t = threads.find((f) => f.id === args?.threadId && f.accountId === args?.accountId);
      if (!t) throw { code: "not_found", message: "That conversation isn't on this device." };
      return toDetail(t, labels);
    },
    // Unread inbox conversations, overall and per category, for the accounts asked about.
    mailbox_counts: (args): MailboxCount[] => {
      const ids = accountIdsOf(args);
      const unread = (category: string | null) =>
        threadsIn(threads, "INBOX", category, ids, hiddenTabs).filter((t) => hasLabel(t, "UNREAD"))
          .length;
      return [
        { labelId: "INBOX", unread: unread(null) },
        ...CATEGORY_IDS.map((c) => ({ labelId: c, unread: unread(c) })),
      ];
    },
    // Like the backend: counts thread-label rows (so no ALL, and Primary has no row of its own).
    label_counts: (args): LabelCount[] => {
      const mine = threads.filter((t) => t.accountId === args?.accountId);
      // UNREAD is a row of its own in the backend; here it follows the messages.
      const labelIds = new Set([
        ...mine.flatMap((t) => t.labelIds),
        ...(mine.some((t) => hasLabel(t, "UNREAD")) ? ["UNREAD"] : []),
      ]);
      const countOf = (labelId: string, members: FixtureThread[]): LabelCount => ({
        labelId,
        unread: members.filter((t) => hasLabel(t, "UNREAD")).length,
        total: members.length,
      });
      const rows = [...labelIds].sort().map((labelId) =>
        countOf(
          labelId,
          mine.filter((t) => hasLabel(t, labelId)),
        ),
      );
      // All Mail, like the backend: everything outside Spam and Trash.
      const allMail = mine.filter((t) => !hasLabel(t, "SPAM") && !hasLabel(t, "TRASH"));
      return allMail.length > 0 ? [...rows, countOf("ALL", allMail)] : rows;
    },
    // Words must all appear in the subject, sender or snippet; Gmail finds nothing more.
    search_messages: (args) => {
      const words = String(args?.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const hit = (t: FixtureThread) => {
        const row = summary(t);
        const text = [row.subject, row.fromName, row.fromAddress, row.snippet]
          .join(" ")
          .toLowerCase();
        return words.length > 0 && words.every((w) => text.includes(w));
      };
      return {
        threads: threads
          .filter(
            (t) =>
              (!accountIdsOf(args).length || accountIdsOf(args).includes(t.accountId)) && hit(t),
          )
          .map(summary),
        next: null,
        local: true,
      };
    },
    search_gmail: () => ({ threads: [], next: {}, failed: [] }),
    recent_searches: () => [...recent],
    add_recent_search: (args) => {
      const q = String(args?.query ?? "").trim();
      if (q) recent = [q, ...recent.filter((r) => r !== q)].slice(0, 20);
    },
    remove_recent_search: (args) => {
      recent = args?.query == null ? [] : recent.filter((r) => r !== args.query);
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
          // Like the backend, an added label lands on every message of the thread.
          if (label === "UNREAD") t.messages.forEach((m) => (m.unread = true));
          else if (!t.labelIds.includes(label)) t.labelIds.push(label);
        }
      });
    },
    trash_threads: (args) =>
      changeThreads(args, (t) => {
        t.labelIds = [...t.labelIds.filter((l) => l !== "INBOX"), "TRASH"];
      }),
    begin_oauth: beginSignIn,
    ...createTransferHandlers(beginSignIn),
    complete_oauth: async (args) => {
      const flowId = String(args?.flowId);
      await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 2500)));
      if (!flows.delete(flowId)) throw { code: "cancelled", message: "Sign-in cancelled." };
      const fail = params.get("fail");
      if (fail) throw { code: fail, message: `Mock failure: ${fail}.` };
      const account = accounts.find((a) => a.email === "you@example.com") ?? {
        id: crypto.randomUUID(),
        email: "you@example.com",
        displayName: "You",
        clientId: "1.apps.googleusercontent.com",
        synced: true,
      };
      if (!accounts.includes(account)) accounts.push(account);
      return account;
    },
    cancel_oauth: (args) => {
      flows.delete(String(args?.flowId));
    },
    remove_account: (args) => {
      const index = accounts.findIndex((a) => a.id === args?.accountId);
      if (index !== -1) accounts.splice(index, 1);
    },
    open_external: () => undefined,
    open_mail_link: () => undefined,
    save_attachment: () => "/Users/you/Downloads/attachment.pdf",
    // Every attachment of a kind reads as the matching sample file.
    read_attachment: (args) => {
      const att = threads
        .filter((t) => t.accountId === args?.accountId)
        .flatMap((t) => t.messages)
        .find((m) => m.id === args?.messageId)
        ?.attachments.find((a) => a.id === args?.attachmentId);
      if (!att) throw { code: "not_found", message: "That attachment isn't on this device." };
      return sampleAttachment(att.filename, att.mimeType);
    },
    prefetch_attachments: () => undefined,
    open_attachment: () => undefined,
    // The fixtures have no download to drop: report what the app would clear and keep them.
    clear_downloaded_mail: () => ({
      messages: threads.filter((t) => !t.labelIds.includes("DRAFT")).flatMap((t) => t.messages)
        .length,
      bytes: 0,
    }),
    // Diagnostics: nothing leaves the browser; both just succeed.
    telemetry_enabled: () => telemetry,
    set_telemetry: (args) => {
      telemetry = args?.enabled === true;
      return telemetry;
    },
    send_diagnostics: () => undefined,
    save_diagnostics: () => undefined,
    log_update: () => undefined,
    log_thread_shown: () => undefined,
    "plugin:dialog|save": () => "/Users/you/Downloads/pheeme-diagnostics.zip",
    reveal_download: () => undefined,
    "plugin:updater|check": () => null,
    ...createComposeHandlers(threads, () => accounts),
    ...createModHandlers(params),
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
  const intercept = (window as unknown as { __PHEEME_PREVIEW_INVOKE__?: PreviewInvoke })
    .__PHEEME_PREVIEW_INVOKE__;
  mockIPC(
    intercept
      ? (cmd, args) => intercept(cmd, args as Args, handlePreviewCommand)
      : handlePreviewCommand,
    {
      shouldMockEvents: true,
    },
  );
}
