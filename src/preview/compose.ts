// Compose in browser preview: replies and forwards from fixture messages, Gmail drafts in memory, and sends
// that wait out the undo window, land in the conversation (or a new one) in Sent, and report like the outbox.
import { emit } from "@tauri-apps/api/event";
import type {
  ComposeDraft,
  ComposeMode,
  DraftSummary,
  EmailAddress,
  OutboxSendStatus,
  QueuedSend,
  SavedDraft,
  StagedAttachment,
  SyncMessagesUpdated,
} from "../lib/tauri";
import { SYNC_EVENTS } from "../lib/tauri";
import type { FixtureThread } from "./fixtures";

type Args = Record<string, unknown> | undefined;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const prefixed = (subject: string, prefix: string) =>
  subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix}${subject}`;

const htmlToText = (html: string) =>
  html
    .replace(/<\/p>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();

export function createComposeHandlers(
  threads: FixtureThread[],
  accounts: () => { id: string; email: string; displayName?: string | null }[],
): Record<string, (args: Args) => unknown> {
  const drafts = new Map<string, { accountId: string; messageId: string; draft: ComposeDraft }>();
  const sends = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;

  const me = (accountId: string): EmailAddress => {
    const a = accounts().find((x) => x.id === accountId);
    return { name: a?.displayName ?? null, address: a?.email ?? "you@example.com" };
  };

  const updated = (accountId: string, change: Partial<SyncMessagesUpdated>) =>
    void emit(SYNC_EVENTS.messagesUpdated, {
      accountId,
      added: [],
      removed: [],
      modified: [],
      ...change,
    }).catch(() => {});

  /** The message as it lands in Sent. */
  const deliver = (accountId: string, d: ComposeDraft) => {
    const from = me(accountId);
    const message = {
      id: `sent-${++seq}`,
      fromName: from.name ?? from.address,
      fromAddress: from.address,
      to: d.to,
      cc: d.cc,
      date: Date.now(),
      unread: false,
      bodyText: null,
      bodyHtml: d.quoteHtml ? `${d.bodyHtml}<br>${d.quoteHtml}` : d.bodyHtml,
      hasRemoteContent: false,
      declaresDarkMode: false,
      attachments: [],
    };
    const thread = d.threadId
      ? threads.find((t) => t.accountId === accountId && t.id === d.threadId)
      : undefined;
    if (thread) {
      thread.messages.push(message);
      if (!thread.labelIds.includes("SENT")) thread.labelIds.push("SENT");
      updated(accountId, { modified: [thread.id] });
    } else {
      const id = `preview-sent-${seq}`;
      threads.push({ id, accountId, labelIds: ["SENT"], subject: d.subject, messages: [message] });
      updated(accountId, { added: [id] });
    }
  };

  return {
    compose_template: (args) => {
      const accountId = String(args?.accountId);
      const mode = args?.mode as ComposeMode;
      const thread = threads.find(
        (t) => t.accountId === accountId && t.messages.some((m) => m.id === args?.messageId),
      );
      const original = thread?.messages.find((m) => m.id === args?.messageId);
      if (!thread || !original) throw { code: "not_found", message: "That message isn't here." };
      const sender = { name: original.fromName, address: original.fromAddress };
      const mine = me(accountId).address.toLowerCase();
      const others = [...original.to, ...original.cc].filter(
        (r) => r.address.toLowerCase() !== mine && r.address !== sender.address,
      );
      const when = new Date(original.date).toLocaleString();
      const quotedBody = original.bodyHtml ?? `<p>${escapeHtml(original.bodyText ?? "")}</p>`;
      const quoteHtml =
        mode === "forward"
          ? `<div>---------- Forwarded message ---------<br>From: ${escapeHtml(original.fromName)} &lt;${escapeHtml(original.fromAddress)}&gt;<br>Subject: ${escapeHtml(thread.subject)}</div><br>${quotedBody}`
          : `<div>On ${escapeHtml(when)}, ${escapeHtml(original.fromName)} &lt;${escapeHtml(original.fromAddress)}&gt; wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedBody}</blockquote>`;
      const draft: ComposeDraft = {
        to: mode === "forward" ? [] : [sender],
        cc: mode === "replyAll" ? others : [],
        bcc: [],
        subject: prefixed(thread.subject, mode === "forward" ? "Fwd: " : "Re: "),
        bodyHtml: "",
        quoteHtml,
        attachments:
          mode === "forward"
            ? original.attachments
                .filter((a) => !a.isInline)
                .map((a) => ({
                  id: `staged-${++seq}`,
                  filename: a.filename ?? "attachment",
                  mimeType: a.mimeType ?? "application/octet-stream",
                  size: a.size ?? 0,
                  contentId: null,
                }))
            : [],
        inReplyTo: mode === "forward" ? null : `<${original.id}@preview>`,
        references: mode === "forward" ? [] : [`<${original.id}@preview>`],
        threadId: mode === "forward" ? null : thread.id,
        draftId: null,
      };
      return draft;
    },
    stage_attachment: (args): StagedAttachment => {
      const path = String(args?.path);
      const filename = path.split(/[\\/]/).pop() || "file";
      return {
        id: `staged-${++seq}`,
        filename,
        mimeType: "application/octet-stream",
        size: 180_000 + ((seq * 7919) % 900_000),
        contentId: null,
      };
    },
    discard_attachments: () => undefined,
    "plugin:dialog|open": () => ["/Users/you/Documents/Quarterly report.pdf"],
    save_draft: (args): SavedDraft => {
      const accountId = String(args?.accountId);
      const message = args?.message as ComposeDraft;
      const draftId =
        message.draftId && drafts.has(message.draftId) ? message.draftId : `draft-${++seq}`;
      const messageId = `draft-msg-${++seq}`;
      drafts.set(draftId, { accountId, messageId, draft: { ...message, draftId } });
      return { draftId, messageId, threadId: message.threadId ?? `draft-thread-${draftId}` };
    },
    get_drafts: (args): DraftSummary[] =>
      [...drafts]
        .filter(([, d]) => d.accountId === args?.accountId)
        .map(([draftId, d]) => ({
          draftId,
          messageId: d.messageId,
          threadId: d.draft.threadId ?? `draft-thread-${draftId}`,
          subject: d.draft.subject,
          to: d.draft.to,
          snippet: htmlToText(d.draft.bodyHtml).slice(0, 140),
          date: Date.now(),
        })),
    open_draft: (args) => {
      const found = [...drafts.values()].find(
        (d) => d.accountId === args?.accountId && d.messageId === args?.messageId,
      );
      if (!found) throw { code: "not_found", message: "That draft isn't in Gmail any more." };
      return { ...found.draft };
    },
    delete_draft: (args) => {
      drafts.delete(String(args?.draftId));
    },
    send_email: (args): QueuedSend => {
      const accountId = String(args?.accountId);
      const message = args?.message as ComposeDraft;
      if (message.to.length + message.cc.length + message.bcc.length === 0)
        throw { code: "invalid", message: "Add at least one recipient." };
      const undoMs = Math.min(Number(args?.undoMs ?? 0), 60_000);
      const opId = `op-${++seq}`;
      sends.set(
        opId,
        setTimeout(() => {
          sends.delete(opId);
          if (message.draftId) drafts.delete(message.draftId);
          deliver(accountId, message);
          const status: OutboxSendStatus = { accountId, opId, status: "sent" };
          void emit(SYNC_EVENTS.outboxSendStatus, status).catch(() => {});
        }, undoMs + 400),
      );
      return { opId, sendAt: Date.now() + undoMs };
    },
    cancel_send: (args) => {
      const timer = sends.get(String(args?.opId));
      if (!timer) return false;
      clearTimeout(timer);
      sends.delete(String(args?.opId));
      return true;
    },
  };
}
