// The messages being written. Each open compose panel is a `ComposeWindow`; sends that left a panel are tracked
// until Gmail confirms them, so Undo and a refused send can bring the message back exactly as it was.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { dismissToast, toast } from "../components/ui/Toast";
import {
  cancelSend,
  type ComposeDraft,
  type ComposeMode,
  composeTemplate,
  type EmailAddress,
  deleteDraft,
  discardAttachments,
  openExternal,
  openDraft,
  type OutboxSendStatus,
  saveDraft,
  sendEmail,
  type StagedAttachment,
  stageAttachment,
  stopQuietly,
  SYNC_EVENTS,
  toCommandError,
} from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useComposeSettings } from "./composeSettings";
import { isValidAddress } from "./recipients";
import { useSendAs } from "./sendAs";
import { bodyWithSignature, useSignatures, withoutSignature } from "./signatures";

export type ComposeKind = "new" | ComposeMode | "draft";

export interface ComposeWindow {
  id: number;
  accountId: string;
  kind: ComposeKind;
  draft: ComposeDraft;
  /** Waiting for the reply template or the saved draft. */
  loading: boolean;
  /** Bumped by every edit; equal to `savedVersion` when nothing is unsaved. */
  version: number;
  savedVersion: number;
  saving: boolean;
  /** When the draft last reached Gmail (Unix ms). */
  savedAt: number | null;
  sending: boolean;
  /** Files being read into staging. */
  attaching: number;
  /** Shown above the footer until the next edit. */
  error: string | null;
  minimized: boolean;
  /** Asking "Save draft or discard?". */
  confirmingClose: boolean;
  /** Asking "Send this message?" (Settings › Compose › Confirm before sending). */
  confirmingSend: boolean;
}

/** Gmail's limit on everything attached to one message. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Panels side by side before the oldest has to be closed. */
export const MAX_WINDOWS = 3;
export const AUTOSAVE_MS = 30_000;

export const emptyDraft = (): ComposeDraft => ({
  from: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  bodyHtml: "",
  quoteHtml: null,
  attachments: [],
  inReplyTo: null,
  references: [],
  threadId: null,
  draftId: null,
});

const bodyText = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

/** Nothing typed (a signature alone doesn't count), nobody to send to, nothing attached. */
export function isBlank(d: ComposeDraft): boolean {
  return (
    d.to.length + d.cc.length + d.bcc.length === 0 &&
    !d.subject.trim() &&
    !bodyText(withoutSignature(d.bodyHtml)) &&
    d.attachments.length === 0
  );
}

export const attachmentBytes = (d: ComposeDraft) =>
  d.attachments.reduce((sum, a) => sum + a.size, 0);

/** Why the message can't be sent yet, or `null`. */
export function sendProblem(d: ComposeDraft): string | null {
  const all = [...d.to, ...d.cc, ...d.bcc];
  if (all.length === 0) return "Add at least one recipient.";
  const bad = all.find((r) => !isValidAddress(r.address));
  if (bad) return `“${bad.address}” isn't an email address.`;
  if (attachmentBytes(d) > MAX_ATTACHMENT_BYTES) return "Attachments are over Gmail's 25 MB limit.";
  return null;
}

/**
 * The saved draft in Gmail on the web, signed in as `email`, where Send later hands it over to Gmail's own
 * Schedule send. `compose=` takes the draft message's id, which the Gmail API gives in hex (`18c2f4a1…`), the
 * form Gmail web's own links used.
 *
 * Unverified on a real account: if Gmail web stops opening the draft from it, use `#drafts` alone (the Drafts
 * list, the draft on top).
 */
export const gmailDraftUrl = (email: string, messageId: string) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#drafts?compose=${encodeURIComponent(messageId)}`;

/** The palette command (registered by `ComposeHost`) behind the Send menu's Send later. */
export const SEND_LATER_COMMAND = "compose.sendLater";

/** A send waiting to leave or to be confirmed, with what's needed to reopen it. */
interface PendingSend {
  window: ComposeWindow;
  toastId: number | null;
}

interface ComposeState {
  windows: ComposeWindow[];
  /** Start a new message from `accountId`. */
  compose(accountId: string, initial?: Partial<ComposeDraft>): number;
  /** Reply, Reply all or Forward `messageId`. */
  respond(accountId: string, messageId: string, mode: ComposeMode): Promise<void>;
  /** Edit a saved draft (the message in Drafts). */
  editDraft(accountId: string, messageId: string): Promise<void>;
  update(id: number, change: Partial<ComposeDraft>): void;
  /** Change who a new message is from. A draft already saved in the old account is removed from it. */
  setAccount(id: number, accountId: string): void;
  /** Send from another of the account's addresses (a send-as alias). */
  setFrom(id: number, from: EmailAddress): void;
  attachFiles(id: number, paths: string[]): Promise<void>;
  removeAttachment(id: number, attachmentId: string): void;
  /** Save to Gmail Drafts now (autosave passes `quiet`, which keeps failures off the toasts). */
  save(id: number, opts?: { quiet?: boolean }): Promise<boolean>;
  send(id: number): Promise<void>;
  /**
   * Send later: save the message to Gmail Drafts now, close the panel and open the draft in Gmail on the web,
   * where Gmail's Schedule send picks the time. Pheeme keeps no schedule of its own.
   */
  sendLater(id: number): Promise<void>;
  /** Send, or ask first when "Confirm before sending" is on. */
  requestSend(id: number): void;
  cancelSend(id: number): void;
  /** Close: quietly when nothing is unsaved, else ask. */
  requestClose(id: number): void;
  cancelClose(id: number): void;
  /** "Save draft" from the close prompt. */
  saveAndClose(id: number): Promise<void>;
  discard(id: number): Promise<void>;
  setMinimized(id: number, minimized: boolean): void;
  /** Bring a panel back up and ask it to take focus. */
  focus(id: number): void;
  /** Bumped by `focus`; panels watch it. */
  focusRequest: { id: number; seq: number } | null;
  /** Listen for send outcomes. Resolves to the unlisten fn. */
  subscribe(): Promise<() => void>;
}

let nextId = 1;
let focusSeq = 0;
const pending = new Map<string, PendingSend>();
/** Each window's save in flight, so a send or a second save waits for it. */
const saves = new Map<number, Promise<boolean>>();
/** The Gmail draft each window's last save made, read by a discard that raced it. */
const savedDrafts = new Map<number, string>();
/** The message id of each window's last saved draft (it changes with every save), for Send later. */
const savedMessages = new Map<number, string>();

export const useComposeStore = create<ComposeState>((set, get) => {
  const find = (id: number) => get().windows.find((w) => w.id === id);
  const patch = (id: number, change: Partial<ComposeWindow>) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...change } : w)) }));
  const remove = (id: number) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
  /** A user edit. Ignored while sending: the message already went to the outbox as it was. */
  const edit = (id: number, change: (w: ComposeWindow) => Partial<ComposeWindow>) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id && !w.sending ? { ...w, ...change(w), version: w.version + 1, error: null } : w,
      ),
    }));

  /** Make room and add a panel; returns its id, or `null` when the limit says no. */
  const open = (win: Omit<ComposeWindow, "id">, force = false): number | null => {
    if (!force && get().windows.length >= MAX_WINDOWS) {
      toast({
        title: "Too many messages open",
        description: "Send or close one first.",
      });
      return null;
    }
    const id = nextId++;
    set((s) => ({
      windows: [...s.windows.map((w) => ({ ...w, minimized: true })), { ...win, id }],
      focusRequest: { id, seq: ++focusSeq },
    }));
    return id;
  };

  const blank = (accountId: string, kind: ComposeKind, draft: ComposeDraft, loading: boolean) => ({
    accountId,
    kind,
    draft,
    loading,
    version: 0,
    savedVersion: 0,
    saving: false,
    savedAt: null,
    sending: false,
    attaching: 0,
    error: null,
    minimized: false,
    confirmingClose: false,
    confirmingSend: false,
  });

  /** A panel already open for this conversation or draft. */
  const existing = (accountId: string, test: (d: ComposeDraft) => boolean) =>
    get().windows.find((w) => w.accountId === accountId && !w.loading && test(w.draft));

  const dropStaged = (attachments: StagedAttachment[]) => {
    if (attachments.length > 0)
      void discardAttachments(attachments.map((a) => a.id)).catch(() => {});
  };

  /** Put a message back into a panel (after Undo or a refused send). */
  const reopen = (win: ComposeWindow, error: string | null) => {
    // Past the panel limit if need be: this message exists nowhere else.
    open(
      {
        ...win,
        sending: false,
        saving: false,
        error,
        confirmingClose: false,
        confirmingSend: false,
      },
      true,
    );
  };

  const onSendStatus = (event: OutboxSendStatus) => {
    const entry = pending.get(event.opId);
    if (!entry) return;
    if (event.status === "sent") {
      pending.delete(event.opId);
      if (entry.toastId !== null) dismissToast(entry.toastId);
      dropStaged(entry.window.draft.attachments);
      toast({ title: "Message sent" });
    } else if (event.status === "failed") {
      pending.delete(event.opId);
      if (entry.toastId !== null) dismissToast(entry.toastId);
      // Drop the refused send from the outbox; the message comes back to be fixed and sent again.
      void cancelSend(event.opId).catch(() => {});
      reopen(entry.window, "Gmail didn't accept this message.");
      toast({ title: "Couldn't send your message", tone: "danger" });
    } else if (event.status === "unconfirmed") {
      pending.delete(event.opId);
      toast({
        title: "Couldn't confirm your message was sent",
        description: "Check Sent before sending it again.",
        tone: "danger",
        duration: 0,
      });
    }
  };

  const undo = async (opId: string) => {
    const entry = pending.get(opId);
    if (!entry) return;
    let stopped = false;
    try {
      stopped = await cancelSend(opId);
    } catch (e) {
      toast({ title: toCommandError(e).message, tone: "danger" });
      return;
    }
    if (!stopped) {
      toast({ title: "Too late to undo", description: "The message has already left." });
      return;
    }
    pending.delete(opId);
    reopen(entry.window, null);
  };

  return {
    windows: [],
    focusRequest: null,

    compose(accountId, initial) {
      const from = initial?.from ?? useSendAs.getState().defaultFrom(accountId);
      const bodyHtml = bodyWithSignature(
        useSignatures.getState().signatureFor(accountId, "new", from?.address),
      );
      return (
        open(blank(accountId, "new", { ...emptyDraft(), from, bodyHtml, ...initial }, false)) ?? -1
      );
    },

    async respond(accountId, messageId, mode) {
      const id = open(blank(accountId, mode, emptyDraft(), true));
      if (id === null) return;
      try {
        const signatures = useSignatures.getState();
        const sendAs = useSendAs.getState();
        // Wait for a first fetch of the Gmail signature and the account's addresses (an alias has its own
        // signature), never a refresh of ones already known.
        const fetching = signatures.refreshGmailOnce(accountId);
        const known = signatures.gmail[accountId]?.html !== undefined;
        const fetchingAddresses = sendAs.refreshOnce(accountId);
        const knownAddresses = sendAs.lists[accountId] !== undefined;
        const [draft] = await Promise.all([
          composeTemplate(accountId, messageId, mode),
          known ? null : fetching,
          knownAddresses ? null : fetchingAddresses,
        ]);
        if (!find(id)) return dropStaged(draft.attachments); // closed while loading
        draft.bodyHtml = bodyWithSignature(
          useSignatures.getState().signatureFor(accountId, "reply", draft.from?.address),
        );
        patch(id, { draft, loading: false });
        get().focus(id);
      } catch (e) {
        remove(id);
        toast({ title: toCommandError(e).message, tone: "danger" });
      }
    },

    async editDraft(accountId, messageId) {
      const id = open(blank(accountId, "draft", emptyDraft(), true));
      if (id === null) return;
      try {
        const draft = await openDraft(accountId, messageId);
        if (!find(id)) return dropStaged(draft.attachments);
        const already = existing(accountId, (d) => d.draftId === draft.draftId);
        if (already) {
          remove(id);
          dropStaged(draft.attachments);
          get().focus(already.id);
          return;
        }
        patch(id, { draft, loading: false, savedAt: Date.now() });
        get().focus(id);
      } catch (e) {
        remove(id);
        const err = toCommandError(e);
        toast({
          title: err.code === "not_found" ? "That draft isn't in Gmail any more." : err.message,
          tone: "danger",
        });
      }
    },

    update(id, change) {
      edit(id, (w) => ({ draft: { ...w.draft, ...change } }));
    },

    setAccount(id, accountId) {
      const win = find(id);
      if (!win || win.accountId === accountId || win.kind !== "new") return;
      const old = win.draft.draftId;
      if (old) void deleteDraft(win.accountId, old).catch(() => {});
      edit(id, (w) => ({
        accountId,
        draft: { ...w.draft, from: useSendAs.getState().defaultFrom(accountId), draftId: null },
        savedAt: null,
      }));
    },

    setFrom(id, from) {
      edit(id, (w) => ({ draft: { ...w.draft, from } }));
    },

    async attachFiles(id, paths) {
      if (paths.length === 0 || find(id)?.sending) return;
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, attaching: w.attaching + paths.length } : w,
        ),
      }));
      const results = await Promise.allSettled(paths.map((p) => stageAttachment(p)));
      const staged = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!find(id)) return dropStaged(staged);
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id
            ? {
                ...w,
                attaching: Math.max(0, w.attaching - paths.length),
                draft: { ...w.draft, attachments: [...w.draft.attachments, ...staged] },
                version: staged.length > 0 ? w.version + 1 : w.version,
              }
            : w,
        ),
      }));
      if (failed) toast({ title: toCommandError(failed.reason).message, tone: "danger" });
    },

    removeAttachment(id, attachmentId) {
      const win = find(id);
      const att = win?.draft.attachments.find((a) => a.id === attachmentId);
      if (!win || !att || win.sending) return;
      edit(id, (w) => ({
        draft: {
          ...w.draft,
          attachments: w.draft.attachments.filter((a) => a.id !== attachmentId),
        },
      }));
      dropStaged([att]);
    },

    save(id, opts) {
      const run = async (): Promise<boolean> => {
        const win = find(id);
        // A queued send owns the message (and its draft id) now.
        if (!win || win.loading || win.sending) return false;
        // Nothing new since the last save, or nothing worth keeping yet.
        if (win.version === win.savedVersion) return true;
        if (isBlank(win.draft) && !win.draft.draftId) {
          patch(id, { savedVersion: win.version });
          return true;
        }
        const version = win.version;
        const accountId = win.accountId;
        patch(id, { saving: true });
        try {
          const saved = await saveDraft(accountId, win.draft);
          savedDrafts.set(id, saved.draftId);
          savedMessages.set(id, saved.messageId);
          set((s) => ({
            windows: s.windows.map((w) =>
              w.id === id && w.accountId === accountId
                ? {
                    ...w,
                    saving: false,
                    savedVersion: Math.max(w.savedVersion, version),
                    savedAt: Date.now(),
                    draft: { ...w.draft, draftId: saved.draftId },
                  }
                : w,
            ),
          }));
          // Closed (or moved to another account) while saving: that draft is no one's now.
          const now = find(id);
          if (!now) return true;
          if (now.accountId !== accountId)
            void deleteDraft(accountId, saved.draftId).catch(() => {});
          return true;
        } catch (e) {
          const message = toCommandError(e).message;
          patch(id, { saving: false, ...(opts?.quiet ? {} : { error: message }) });
          return false;
        }
      };
      const previous = saves.get(id) ?? Promise.resolve(true);
      const next = previous.then(run, run);
      saves.set(id, next);
      void next.finally(() => {
        if (saves.get(id) === next) saves.delete(id);
      });
      return next;
    },

    requestSend(id) {
      const win = find(id);
      if (!win || win.loading || win.sending) return;
      if (useComposeSettings.getState().confirmSend && !win.confirmingSend) {
        const problem =
          win.attaching > 0 ? "Wait for the attachments to finish." : sendProblem(win.draft);
        if (problem) {
          patch(id, { error: problem });
          return;
        }
        patch(id, { confirmingSend: true, confirmingClose: false, minimized: false });
        return;
      }
      void get().send(id);
    },

    cancelSend(id) {
      patch(id, { confirmingSend: false });
      get().focus(id);
    },

    async send(id) {
      const win = find(id);
      if (!win || win.loading || win.sending) return;
      patch(id, { confirmingSend: false });
      const problem =
        win.attaching > 0 ? "Wait for the attachments to finish." : sendProblem(win.draft);
      if (problem) {
        patch(id, { error: problem });
        return;
      }
      patch(id, { sending: true, error: null });
      // A save in flight may be creating the draft this send replaces.
      await saves.get(id)?.catch(() => {});
      const current = find(id);
      if (!current) return;
      const undoMs = useComposeSettings.getState().undoSendSeconds * 1000;
      try {
        const queued = await sendEmail(current.accountId, current.draft, undoMs);
        remove(id);
        const entry: PendingSend = { window: current, toastId: null };
        pending.set(queued.opId, entry);
        const left = queued.sendAt - Date.now();
        entry.toastId = toast({
          title: "Sending…",
          duration: undoMs > 0 ? Math.max(left, 1000) : 0,
          action: undoMs > 0 ? { label: "Undo", run: () => void undo(queued.opId) } : undefined,
        });
      } catch (e) {
        patch(id, { sending: false, error: toCommandError(e).message });
      }
    },

    async sendLater(id) {
      const win = find(id);
      if (!win || win.loading || win.sending) return;
      const problem =
        win.attaching > 0 ? "Wait for the attachments to finish." : sendProblem(win.draft);
      if (problem) {
        patch(id, { error: problem, confirmingSend: false });
        return;
      }
      // Save now, even with nothing new: Gmail web opens the draft's latest message.
      patch(id, { confirmingSend: false, confirmingClose: false, version: win.version + 1 });
      let current = find(id);
      while (current && current.version !== current.savedVersion) {
        if (!(await get().save(id))) return; // the reason shows in the panel
        current = find(id);
      }
      const messageId = savedMessages.get(id);
      if (!current || !messageId) return;
      // A file attached while saving isn't in the draft yet.
      if (current.attaching > 0) {
        patch(id, { error: "Wait for the attachments to finish." });
        return;
      }
      // The account it was saved in, which may have changed while saving.
      const accountId = current.accountId;
      const email = useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email;
      if (!email) {
        patch(id, { error: "That account isn't connected any more." });
        return;
      }
      remove(id);
      dropStaged(current.draft.attachments);
      try {
        await openExternal(gmailDraftUrl(email, messageId));
        toast({
          title: "Draft opened in Gmail",
          description: "Choose Schedule send there to pick a time.",
        });
      } catch (e) {
        toast({
          title: "Saved in Drafts",
          description: `Couldn't open Gmail: ${toCommandError(e).message}`,
          tone: "danger",
        });
      }
    },

    requestClose(id) {
      const win = find(id);
      if (!win || win.sending) return;
      if (win.loading || win.version === win.savedVersion) {
        remove(id);
        dropStaged(win.draft.attachments);
        if (win.version > 0 && win.draft.draftId) toast({ title: "Draft saved" });
        return;
      }
      if (isBlank(win.draft) && !win.draft.draftId) {
        remove(id);
        dropStaged(win.draft.attachments);
        return;
      }
      patch(id, { confirmingClose: true, confirmingSend: false, minimized: false });
    },

    cancelClose(id) {
      patch(id, { confirmingClose: false });
      get().focus(id);
    },

    async saveAndClose(id) {
      patch(id, { confirmingClose: false });
      // Edits made while a save is out need a save of their own before the panel can go.
      let win = find(id);
      while (win && win.version !== win.savedVersion) {
        if (!(await get().save(id))) return;
        win = find(id);
      }
      if (!win) return;
      remove(id);
      dropStaged(win.draft.attachments);
      toast({ title: "Draft saved" });
    },

    async discard(id) {
      const win = find(id);
      if (!win || win.sending) return;
      remove(id);
      dropStaged(win.draft.attachments);
      // Wait for a save in flight, which may be what creates the draft.
      await saves.get(id)?.catch(() => {});
      const draftId = savedDrafts.get(id) ?? win.draft.draftId ?? null;
      savedDrafts.delete(id);
      savedMessages.delete(id);
      if (draftId) {
        try {
          await deleteDraft(win.accountId, draftId);
        } catch (e) {
          toast({ title: toCommandError(e).message, tone: "danger" });
          return;
        }
      }
      if (!isBlank(win.draft) || draftId) toast({ title: "Draft discarded" });
    },

    setMinimized(id, minimized) {
      patch(id, { minimized });
      if (!minimized) get().focus(id);
    },

    focus(id) {
      set((s) => ({
        windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: false } : w)),
        focusRequest: { id, seq: ++focusSeq },
      }));
    },

    async subscribe() {
      return listen<OutboxSendStatus>(SYNC_EVENTS.outboxSendStatus, ({ payload }) =>
        onSendStatus(payload),
      ).then((stop) => () => stopQuietly(stop));
    },
  };
});

/** Test helper. */
export function __resetComposeStoreForTests() {
  pending.clear();
  saves.clear();
  savedDrafts.clear();
  savedMessages.clear();
  nextId = 1;
  useComposeStore.setState({ windows: [], focusRequest: null });
}
