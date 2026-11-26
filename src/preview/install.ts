import { createModHandlers } from "./mods";
import { createAssistantHandlers } from "./assistant";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  type AccountInfo,
  type ClientChoice,
  type LabelCount,
  type MailboxCount,
  type MessageDetail,
  SYNC_EVENTS,
  type SyncMessagesUpdated,
  type ThreadDetail,
  type ThreadPage,
  type ThreadSummary,
} from "../lib/tauri";
import type { DesktopSettings, NotifySchedule, NotifyTarget } from "../desktop/api";
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
import { createFilterHandlers } from "./filters";
import { createCalendarHandlers } from "./calendar";
import { createAvailabilityHandlers } from "./availability";
import { createTasksHandlers } from "./tasks";
import { createTemplateHandlers } from "./templates";
import { createWeatherHandlers } from "./weather";
import { createContactHandlers, type MeetingsWith } from "./contacts";
import { createTransferHandlers } from "./transfer";
import { previewQuotaUsage } from "./quota";
import { previewMailStats, previewUnsubscribe, previewUnsubscribeOutcome } from "./stats";
import { createDriveHandlers } from "./drive";
import { byName, type PreviewHandlers } from "./handlers";

/** A grey 16 × 10 PNG standing in for a screenshot dropped in the browser preview. */
const PREVIEW_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAAAFElEQVR42mM4ceIsSYhhVMPQ1AAA9JF6MAsQG6oAAAAASUVORK5CYII=";

type Args = Record<string, unknown> | undefined;
/** Browser-test hook installed before startup, so speculative reads see the same fixtures as opens. */
export type PreviewInvoke = (cmd: string, args: Args, next: typeof handlePreviewCommand) => unknown;

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
    // Like the cache, a conversation in Trash or Spam carries only that one of its system labels (an Important
    // marker or an Inbox label doesn't show while it sits there).
    systemLabelIds: [
      ...(hasLabel(t, "TRASH")
        ? ["TRASH"]
        : hasLabel(t, "SPAM")
          ? ["SPAM"]
          : t.labelIds.filter(
              (id) => !labels.some((l) => l.accountId === t.accountId && l.id === id),
            )),
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
    unsubscribe: m.unsubscribe,
  }));
  return { thread: toSummary(t, labels), messages, bodyError: null };
}

/** The preview's OAuth clients, shaped like Google's: the Cloud project's number first. */
const PREVIEW_CLIENT = "418203915572-preview8k2m.apps.googleusercontent.com";
const OTHER_CLIENT = "730561248890-studio4hq7.apps.googleusercontent.com";

/** One stateful backend for both onboarding and the shell in browser preview. */
export function createPreviewHandlers(search = ""): PreviewHandlers {
  const params = new URLSearchParams(search);
  const accounts: AccountInfo[] =
    params.get("accounts") === "0"
      ? []
      : fixtureAccounts
          .slice(0, params.get("accounts") === "1" ? 1 : undefined)
          .map((account, i) => ({
            ...account,
            // `?clients=2` signs the second account in through a client of its own.
            clientId: params.get("clients") === "2" && i > 0 ? OTHER_CLIENT : PREVIEW_CLIENT,
            synced: true,
            color: (i % 6) + 1,
          }));
  const downloadTotal = params.get("download") === "1" ? 29_100 : 0;
  let downloadSynced = 9_800;
  const flows = new Map<string, ClientChoice | null>();
  const beginSignIn = (args?: { client: ClientChoice }) => {
    const flowId = crypto.randomUUID();
    flows.set(flowId, args?.client ?? null);
    return { flowId, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" };
  };
  const threads = [
    ...createFixtureThreads(),
    ...generatedThreads(Number(params.get("threads")) || 0),
  ];
  const labels = createPreviewLabels();
  const drive = createDriveHandlers(accounts, threads, params.get("drive"));
  const calendarZone =
    params.get("calendarZone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // `?calendarColors=missing_scope`: recolouring a calendar asks for the consent first.
  const calendarColorsAllowed = new Set(
    params.get("calendarColors") === "missing_scope" ? [] : accounts.map((a) => a.id),
  );
  const calendar = createCalendarHandlers(
    accounts,
    params.get("calendar"),
    undefined,
    calendarZone,
    calendarColorsAllowed,
  );
  const availability = createAvailabilityHandlers(
    accounts,
    (fromMs, toMs) => calendar.calendar_events({ fromMs, toMs, timeZone: calendarZone }),
    params.get("freebusy"),
  );
  const meetingsWith: MeetingsWith = (accountId, address, fromMs, toMs) =>
    calendar
      .calendar_events({ fromMs, toMs, timeZone: calendarZone })
      .filter((e) => e.accountId === accountId && e.selfResponse !== "declined")
      .filter((e) => {
        const detail = calendar.calendar_event_detail({
          accountId,
          calendarId: e.calendarId,
          eventId: e.id,
        });
        return [
          detail.organizer?.email,
          ...detail.attendees.filter((a) => a.response !== "declined").map((a) => a.email),
        ].some((a) => a?.toLowerCase() === address);
      });
  const summary = (t: FixtureThread) => toSummary(t, labels);

  /** Apply `change` to the named threads, then tell the stores, as the backend does after a cache write. */
  const changeThreads = (
    args: { accountId: string; threadIds: string[] },
    change: (t: FixtureThread) => void,
  ): void => {
    const { accountId } = args;
    const changed = threads.filter(
      (t) => t.accountId === accountId && args.threadIds.includes(t.id),
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

  /** The search's matches: every word in the subject, sender or snippet (`from:`/`subject:` read as words). */
  const searchHits = (args: { accountIds: string[]; query: string }): FixtureThread[] => {
    const words = args.query
      .toLowerCase()
      .replace(/\b(from|subject):/g, "")
      .replace(/"/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const ids = args.accountIds;
    return threads.filter((t) => {
      if (ids.length && !ids.includes(t.accountId)) return false;
      // Like local search, never Spam or Trash. (The preview reads no operators; `in:` is just a word here.)
      if (hasLabel(t, "SPAM") || hasLabel(t, "TRASH")) return false;
      const row = summary(t);
      const text = [row.subject, row.fromName, row.fromAddress, row.snippet]
        .join(" ")
        .toLowerCase();
      return words.length > 0 && words.every((w) => text.includes(w));
    });
  };

  let recent: string[] = [];
  const notificationChoices = new Map<string, boolean>();
  let gmailQuota = 6000;
  let trayIcon = true;
  let notifySchedule: NotifySchedule = {
    mode: "always",
    startHour: 9,
    endHour: 17,
    weekdaysOnly: true,
  };
  let telemetry = true;
  let calendarReminders = true;
  let notificationTarget: NotifyTarget | null = null;
  // Preview only: `__pheemeNotificationClick({ kind: "event", ... })` acts as a clicked notification.
  (
    globalThis as { __pheemeNotificationClick?: (target: unknown) => void }
  ).__pheemeNotificationClick = (target) => {
    notificationTarget = target as NotifyTarget;
    void emit("desktop:open-thread").catch(() => {});
  };
  const inboxTabs = new Map<string, string[]>();
  const hiddenTabs = (accountId: string) => inboxTabs.get(accountId) ?? [];
  const desktopSettings = (): DesktopSettings => ({
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
    calendarReminders,
  });
  return {
    list_accounts: () => [...accounts],
    get_sync_progress: () =>
      accounts.map((account, i) => {
        // `?download=1` downloads the first account's mailbox, a page per poll, then finishes.
        if (i === 0 && downloadTotal) {
          downloadSynced = Math.min(downloadTotal, downloadSynced + 1400);
          return {
            accountId: account.id,
            syncedMessages: downloadSynced,
            totalMessages: downloadTotal,
            downloadedMessages: downloadSynced,
            complete: downloadSynced === downloadTotal,
          };
        }
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
      notificationChoices.set(args.accountId, args.enabled === true);
      return desktopSettings();
    },
    answer_notification_prompt: (args) => {
      for (const a of accounts)
        if (!notificationChoices.has(a.id)) notificationChoices.set(a.id, args.enable === true);
      return desktopSettings();
    },
    set_tray_icon: (args) => {
      trayIcon = args.shown === true;
      return desktopSettings();
    },
    set_notification_schedule: (args) => {
      notifySchedule = { ...notifySchedule, ...(args.schedule as typeof notifySchedule) };
      return desktopSettings();
    },
    take_notification_target: () => {
      const target = notificationTarget;
      notificationTarget = null;
      return target;
    },
    set_calendar_reminders: (args) => {
      calendarReminders = args.enabled === true;
      return desktopSettings();
    },
    gmail_quota: () => gmailQuota,
    gmail_quota_usage: (args) => previewQuotaUsage(args.accountId, gmailQuota),
    mail_stats: (args) => previewMailStats(args.accountId, args.sinceMs),
    unsubscribe_sender: (args) => {
      // A message in the conversation, else a sender in the Stats window.
      const m = threads.flatMap((t) => t.messages).find((x) => x.id === args.messageId);
      return m
        ? previewUnsubscribeOutcome(m.fromAddress, m.unsubscribe)
        : previewUnsubscribe(args.threadId);
    },
    set_gmail_quota: (args) => {
      gmailQuota = Math.min(1_200_000, Math.max(600, args.perMinute || 6000));
      return gmailQuota;
    },
    list_labels: (args) => labelsFor(labels, args.accountId),
    inbox_tabs: (args) => [...(inboxTabs.get(args.accountId) ?? [])],
    // Like the backend: keeps only the four hideable tabs, then tells the stores to reload.
    set_inbox_tabs: (args) => {
      const accountId = args.accountId;
      const hidden = CATEGORY_IDS.filter(
        (c) => c !== "CATEGORY_PERSONAL" && args.hidden.includes(c),
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
    ...createFilterHandlers(
      threads,
      labels,
      params.get("senderRules") === "missing",
      changeThreads,
    ),
    ...createContactHandlers(
      threads,
      (id) => accounts.find((a) => a.id === id)?.email,
      params.get("contacts"),
      meetingsWith,
    ),
    ...calendar,
    calendar_availability: availability.calendar_availability,
    ...createTasksHandlers(accounts, params.get("tasks")),
    ...createTemplateHandlers(accounts, params.get("templates")),
    ...createWeatherHandlers(),
    ...drive.handlers,
    list_threads: (args): ThreadPage => ({
      threads: threadsIn(
        threads,
        args.labelId,
        args.alsoLabelId ?? null,
        args.accountIds,
        hiddenTabs,
      )
        .filter(
          (t) =>
            !args.unreadOnly ||
            hasLabel(t, "UNREAD") ||
            args.keepRead?.some(([accountId, id]) => accountId === t.accountId && id === t.id),
        )
        .map(summary),
      next: null,
    }),
    get_thread: (args) => {
      const t = threads.find((f) => f.id === args.threadId && f.accountId === args.accountId);
      if (!t) throw { code: "not_found", message: "That conversation isn't on this device." };
      return toDetail(t, labels);
    },
    // Unread inbox conversations, overall and per category, for the accounts asked about.
    mailbox_counts: (args): MailboxCount[] => {
      const ids = args.accountIds;
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
      const mine = threads.filter((t) => t.accountId === args.accountId);
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
    search_messages: (args) => ({
      threads: searchHits(args).map(summary),
      next: null,
      local: true,
    }),
    search_gmail: () => ({ threads: [], next: {}, failed: [] }),
    recent_searches: () => [...recent],
    add_recent_search: (args) => {
      const q = args.query.trim();
      if (q) recent = [q, ...recent.filter((r) => r !== q)].slice(0, 20);
    },
    remove_recent_search: (args) => {
      recent = args.query == null ? [] : recent.filter((r) => r !== args.query);
    },
    sync_now: () => undefined,
    network_online: () => !params.has("offline"),
    modify_threads: (args) => {
      const add = args.add;
      const remove = args.remove;
      // Like the backend: Spam can be added and removed (Report spam, Not spam), Trash has its own command, and
      // getting INBOX leaves Trash.
      const toInbox = add.includes("INBOX");
      if (add.includes("TRASH") || remove.includes("TRASH")) {
        throw { code: "invalid", message: "Use trash for Trash." };
      }
      return changeThreads(args, (t) => {
        if (toInbox) t.labelIds = t.labelIds.filter((l) => l !== "TRASH");
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
    mark_inbox_tab_read: (args) => {
      const accountId = args.accountId;
      const category = args.category;
      const ids = threadsIn(threads, "INBOX", category, [accountId], hiddenTabs)
        .filter((t) => hasLabel(t, "UNREAD"))
        .map((t) => t.id);
      changeThreads({ accountId, threadIds: ids }, (t) =>
        t.messages.forEach((m) => (m.unread = false)),
      );
    },
    mark_search_read: (args) => {
      for (const accountId of args.accountIds) {
        const ids = searchHits({ accountIds: [accountId], query: args.query })
          .filter((t) => hasLabel(t, "UNREAD"))
          .map((t) => t.id);
        changeThreads({ accountId, threadIds: ids }, (t) =>
          t.messages.forEach((m) => (m.unread = false)),
        );
      }
    },
    trash_threads: (args) =>
      changeThreads(args, (t) => {
        t.labelIds = [...t.labelIds.filter((l) => l !== "INBOX"), "TRASH"];
      }),
    begin_oauth: beginSignIn,
    ...createTransferHandlers(beginSignIn),
    complete_oauth: async (args) => {
      const flowId = args.flowId;
      await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 2500)));
      if (!flows.has(flowId)) throw { code: "cancelled", message: "Sign-in cancelled." };
      const choice = flows.get(flowId);
      flows.delete(flowId);
      const fail = params.get("fail");
      if (fail) throw { code: fail, message: `Mock failure: ${fail}.` };
      if (
        choice &&
        "accountId" in choice &&
        ["drive", "contacts", "calendar", "availability", "calendarColors", "reconnect"].includes(
          choice.kind,
        )
      ) {
        const existing = accounts.find((a) => a.id === choice.accountId);
        if (!existing) throw { code: "not_found", message: "That account isn't connected." };
        if (choice.kind === "drive") drive.allow(existing.id);
        if (choice.kind === "availability") availability.allow(existing.id);
        if (choice.kind === "calendarColors") calendarColorsAllowed.add(existing.id);
        return existing;
      }
      const account = accounts.find((a) => a.email === "you@example.com") ?? {
        id: crypto.randomUUID(),
        email: "you@example.com",
        displayName: "You",
        clientId: PREVIEW_CLIENT,
        synced: true,
        color: 1,
      };
      if (!accounts.includes(account)) accounts.push(account);
      return account;
    },
    cancel_oauth: (args) => {
      flows.delete(args.flowId);
    },
    remove_account: (args) => {
      const index = accounts.findIndex((a) => a.id === args.accountId);
      if (index !== -1) accounts.splice(index, 1);
    },
    set_account_color: (args) => {
      const account = accounts.find((a) => a.id === args.accountId);
      if (!account) throw { code: "not_found", message: "That account isn't connected any more." };
      account.color = args.color;
    },
    reorder_accounts: (args) => {
      const rank = (a: AccountInfo) => {
        const i = args.accountIds.indexOf(a.id);
        return i === -1 ? args.accountIds.length : i;
      };
      accounts.sort((a, b) => rank(a) - rank(b));
    },
    open_external: () => undefined,
    open_mail_link: () => undefined,
    // The page in a tab of its own, standing in for the print window.
    print_email: (args) => {
      const url = URL.createObjectURL(new Blob([String(args.html)], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
      // A noopener tab has no load callback here. Give it time to read the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    open_meeting_link: () => undefined,
    save_attachment: () => "/Users/you/Downloads/attachment.pdf",
    // Every attachment of a kind reads as the matching sample file.
    read_attachment: (args) => {
      const att = threads
        .filter((t) => t.accountId === args.accountId)
        .flatMap((t) => t.messages)
        .find((m) => m.id === args.messageId)
        ?.attachments.find((a) => a.id === args.attachmentId);
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
      telemetry = args.enabled === true;
      return telemetry;
    },
    send_diagnostics: () => undefined,
    record_usage: () => undefined,
    save_diagnostics: () => undefined,
    // The browser can't re-encode like Rust does: a pasted image comes back as it is, a dropped path as a grey tile.
    prepare_screenshot: (args) => ({
      png: "data" in args ? args.data : PREVIEW_SCREENSHOT,
      width: 1280,
      height: 800,
    }),
    log_update: () => undefined,
    start_hidden_next_launch: () => undefined,
    launch_hidden: () => false,
    log_thread_shown: () => undefined,
    log_preview: () => undefined,
    log_window_problem: () => undefined,
    "plugin:dialog|open": () => ["/Users/you/Documents/Quarterly report.pdf"],
    "plugin:dialog|save": () => "/Users/you/Downloads/pheeme-diagnostics.zip",
    reveal_download: () => undefined,
    list_theme_folder: () => ({
      path: "/Users/you/Library/Application Support/app.pheeme.desktop/themes",
      files: [],
    }),
    open_theme_folder: () => undefined,
    "plugin:updater|check": () => null,
    ...createComposeHandlers(threads, () => accounts),
    ...createModHandlers(params),
    ...createAssistantHandlers(),
  };
}

export let previewHandlers = createPreviewHandlers();

export function handlePreviewCommand(cmd: string, args?: unknown): unknown {
  // Commands arrive by name from the IPC mock, so this is the one place the typed map is looked up loosely.
  const handler = byName(previewHandlers)[cmd];
  if (handler) return handler(args);
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
