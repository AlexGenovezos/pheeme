// The messages being written. Each open compose panel is a `ComposeWindow`; sends that left a panel are tracked
// until Gmail confirms them, so Undo and a refused send can bring the message back exactly as it was.
import { create } from "zustand";
import { toast, toastError } from "../components/ui/Toast";
import { base64Of } from "../lib/base64";
import {
  type ComposeDraft,
  type ComposeMode,
  composeTemplate,
  type EmailAddress,
  deleteDraft,
  openExternal,
  openDraft,
  saveDraft,
  sendEmail,
  stageAttachment,
  type StagedAttachment,
  stagePastedAttachment,
  toCommandError,
} from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useComposeSettings } from "./composeSettings";
import {
  newContentId,
  outgoingDraft,
  stagedImage,
  stagingImage,
  withoutImages,
} from "./inlineImages";
import { isValidAddress } from "./recipients";
import {
  checkFailedSends,
  dropStaged,
  listenSendStatus,
  type SendingHost,
  trackSend,
  __resetSendingForTests,
} from "./sending";
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
  /** Why the last save (autosave included) didn't reach Gmail; `null` once one does. */
  saveError: string | null;
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

/** A path the user picked or dropped, or a file the window holds (pasted from the clipboard). */
export type AttachSource = string | File;

async function stage(source: AttachSource, contentId: string | null = null) {
  if (typeof source === "string") return stageAttachment(source);
  if (source.size > MAX_ATTACHMENT_BYTES) {
    throw { code: "invalid_input", message: "Attachments can add up to 25 MB at most." };
  }
  const ext = source.type.split("/")[1]?.split(/[+;]/)[0] || "bin";
  const staged = await stagePastedAttachment(
    source.name || `image.${ext}`,
    source.type,
    await base64Of(source),
    contentId,
  );
  return staged;
}
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

/** Nothing typed or pasted (a signature alone doesn't count), nobody to send to, nothing attached. */
export function isBlank(d: ComposeDraft): boolean {
  const out = outgoingDraft(d);
  const body = withoutSignature(out.bodyHtml);
  return (
    d.to.length + d.cc.length + d.bcc.length === 0 &&
    !d.subject.trim() &&
    !bodyText(body) &&
    !/<img\b/i.test(body) &&
    out.attachments.length === 0
  );
}

/** What the message's files add up to, as sent (a pasted image deleted from the text doesn't count). */
export const attachmentBytes = (d: ComposeDraft) =>
  outgoingDraft(d).attachments.reduce((sum, a) => sum + a.size, 0);

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
 * Gmail's Drafts on the web, signed in as `email`, where Send later hands the saved draft (on top, the newest)
 * over to Gmail's own Schedule send. Not a link to the draft itself: Gmail web names drafts in `#drafts?compose=`
 * by its own token, and the API's message id there opens a blank message instead.
 */
export const gmailDraftsUrl = (email: string) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#drafts`;

/** The answer: `true` when nothing is left unsaved, `false` when a save failed (the app then stays open). */
export const SAVED_BEFORE_EXIT_EVENT = "compose:saved_before_exit";

/** The palette command (registered by `ComposeHost`) behind the Send menu's Send later. */
export const SEND_LATER_COMMAND = "compose.sendLater";

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
  /** Attach files: paths the user picked or dropped, or files from a paste. */
  attachFiles(id: number, sources: AttachSource[]): Promise<void>;
  /**
   * Images pasted into the text: names each with a Content-ID for the editor to put in at once (`contentIds`, in
   * order) and stages their files. A file that can't be staged takes its image back out of the stored text, and
   * `failed` resolves to those ids for the editor to do the same. A save waits for the staging.
   */
  pasteImages(id: number, files: File[]): { contentIds: string[]; failed: Promise<string[]> };
  removeAttachment(id: number, attachmentId: string): void;
  /** Save to Gmail Drafts now (autosave passes `quiet`, which keeps failures off the toasts). */
  save(id: number, opts?: { quiet?: boolean }): Promise<boolean>;
  /**
   * Save every open message with unsaved changes, before the app quits or restarts. False when one couldn't
   * be saved: its panel comes up saying why.
   */
  saveAll(): Promise<boolean>;
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
  /**
   * Once per session per account: tell the user about sends still in the outbox that Gmail refused or never
   * confirmed, which no panel remembers after a restart.
   */
  checkFailedSends(accountId: string): Promise<void>;
  /** Listen for send outcomes. Resolves to the unlisten fn. */
  subscribe(): Promise<() => void>;
}

let nextId = 1;
let focusSeq = 0;
/** Each window's pasted images being staged: a save waits, so it never keeps a `cid:` without its image. */
const pastes = new Map<number, Promise<unknown>>();
/** Each window's save in flight, so a send or a second save waits for it. */
const saves = new Map<number, Promise<boolean>>();
/** Sends being handed to the outbox, by panel: quitting waits for them. */
const sends = new Map<number, Promise<void>>();
/** The Gmail draft each window's last save made, read by a discard that raced it. */
const savedDrafts = new Map<number, string>();
/** The message id of each window's last saved draft (it changes with every save), for Send later. */
const savedMessages = new Map<number, string>();
/** Every Drafts message each window's draft has been (the one it was opened from, then one per save). */
const draftMessages = new Map<number, Set<string>>();
const noteDraftMessage = (id: number, messageId: string) => {
  const known = draftMessages.get(id) ?? new Set<string>();
  draftMessages.set(id, known.add(messageId));
};

export const useComposeStore = create<ComposeState>((set, get) => {
  const find = (id: number) => get().windows.find((w) => w.id === id);
  const patch = (id: number, change: Partial<ComposeWindow>) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...change } : w)) }));
  const remove = (id: number) => {
    // A discard that raced a save reads `savedDrafts` once the save lands, and takes that entry itself.
    saves.delete(id);
    sends.delete(id);
    savedDrafts.delete(id);
    savedMessages.delete(id);
    draftMessages.delete(id);
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
  };
  /** A user edit. Ignored while sending: the message already went to the outbox as it was. */
  const edit = (id: number, change: (w: ComposeWindow) => Partial<ComposeWindow>) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id && !w.sending ? { ...w, ...change(w), version: w.version + 1, error: null } : w,
      ),
    }));

  /** Stage files into a panel's attachments (with `contentIds`: images pasted into the text). */
  const addStaged = async (
    id: number,
    sources: AttachSource[],
    contentIds: string[] = [],
  ): Promise<StagedAttachment[]> => {
    if (sources.length === 0 || find(id)?.sending) return [];
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, attaching: w.attaching + sources.length } : w,
      ),
    }));
    const results = await Promise.allSettled(
      sources.map((source, i) => stage(source, contentIds[i] ?? null)),
    );
    const staged = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (!find(id)) {
      dropStaged(staged);
      return [];
    }
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              attaching: Math.max(0, w.attaching - sources.length),
              draft: { ...w.draft, attachments: [...w.draft.attachments, ...staged] },
              version: staged.length > 0 ? w.version + 1 : w.version,
            }
          : w,
      ),
    }));
    if (failed) toastError(failed.reason);
    return staged;
  };

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
    saveError: null,
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

  const host: SendingHost = {
    reopen,
    editDraft: (accountId, messageId) => get().editDraft(accountId, messageId),
  };

  /** Close a panel for good and drop the staged files nothing will read again. */
  const dispose = (id: number, attachments: ComposeDraft["attachments"]) => {
    remove(id);
    dropStaged(attachments);
  };

  /** The reason the panel's message can't be sent yet: files still being read, else `sendProblem`. */
  const attachingProblem = (w: ComposeWindow) =>
    w.attaching > 0 ? "Wait for the attachments to finish." : null;
  /** Show why the message can't be sent yet in its panel and say so; `false` when it can go. */
  const refuseUnready = (w: ComposeWindow, extra: Partial<ComposeWindow> = {}): boolean => {
    const problem = attachingProblem(w) ?? sendProblem(w.draft);
    if (problem) patch(w.id, { error: problem, ...extra });
    return problem !== null;
  };

  /**
   * Save until nothing is unsaved: edits made while a save is out need a save of their own. Resolves to the panel
   * afterwards (`null` if it closed), or `false` when a save failed. Only panels `saveable` says yes to are saved.
   */
  const saveUntilClean = async (
    id: number,
    saveable: (w: ComposeWindow) => boolean = () => true,
  ): Promise<ComposeWindow | null | false> => {
    let win = find(id);
    while (win && saveable(win) && win.version !== win.savedVersion) {
      if (!(await get().save(id))) return false;
      win = find(id);
    }
    return win ?? null;
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
        toastError(e);
      }
    },

    async editDraft(accountId, messageId) {
      // Already open (or opening): show that panel, whether or not there's room for another.
      const opened = get().windows.find(
        (w) => w.accountId === accountId && draftMessages.get(w.id)?.has(messageId),
      );
      if (opened) return get().focus(opened.id);
      const id = open(blank(accountId, "draft", emptyDraft(), true));
      if (id === null) return;
      noteDraftMessage(id, messageId);
      try {
        const draft = await openDraft(accountId, messageId);
        if (!find(id)) return dropStaged(draft.attachments);
        const already = existing(accountId, (d) => d.draftId === draft.draftId);
        if (already) {
          dispose(id, draft.attachments);
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

    async attachFiles(id, sources) {
      await addStaged(id, sources);
    },

    pasteImages(id, files) {
      const contentIds = files.map((file) => {
        const contentId = newContentId();
        stagingImage(contentId, file);
        return contentId;
      });
      const failed = addStaged(id, files, contentIds).then((staged) => {
        const kept = new Map(staged.map((a) => [a.contentId, a]));
        for (const contentId of contentIds) stagedImage(contentId, kept.get(contentId) ?? null);
        const lost = contentIds.filter((contentId) => !kept.has(contentId));
        if (lost.length > 0)
          set((s) => ({
            windows: s.windows.map((w) =>
              w.id === id
                ? { ...w, draft: { ...w.draft, bodyHtml: withoutImages(w.draft.bodyHtml, lost) } }
                : w,
            ),
          }));
        return lost;
      });
      const before = pastes.get(id);
      const all = Promise.all([before, failed]);
      pastes.set(id, all);
      void all.finally(() => {
        if (pastes.get(id) === all) pastes.delete(id);
      });
      return { contentIds, failed };
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
        // Until none is pending: an image pasted while waiting has to land too.
        for (let p = pastes.get(id); p; p = pastes.get(id)) await p.catch(() => {});
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
          const saved = await saveDraft(accountId, outgoingDraft(win.draft));
          savedDrafts.set(id, saved.draftId);
          savedMessages.set(id, saved.messageId);
          noteDraftMessage(id, saved.messageId);
          set((s) => ({
            windows: s.windows.map((w) =>
              w.id === id && w.accountId === accountId
                ? {
                    ...w,
                    saving: false,
                    savedVersion: Math.max(w.savedVersion, version),
                    savedAt: Date.now(),
                    saveError: null,
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
          // Always kept for the footer's "Not saved"; only a save the user asked for interrupts with it.
          patch(id, {
            saving: false,
            saveError: message,
            ...(opts?.quiet ? {} : { error: message }),
          });
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

    async saveAll() {
      let allSaved = true;
      // A send on its way to the outbox lands there first; one that fails leaves its panel to save.
      await Promise.all(sends.values());
      for (const { id } of get().windows) {
        // A message still loading has nothing typed.
        const saved = await saveUntilClean(id, (w) => !w.loading && !w.sending);
        if (saved === false) {
          allSaved = false;
          get().focus(id);
        }
      }
      return allSaved;
    },

    requestSend(id) {
      const win = find(id);
      if (!win || win.loading || win.sending) return;
      if (useComposeSettings.getState().confirmSend && !win.confirmingSend) {
        if (refuseUnready(win)) return;
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
      if (refuseUnready(win)) return;
      patch(id, { sending: true, error: null });
      const queue = async () => {
        // A save in flight may be creating the draft this send replaces.
        await saves.get(id)?.catch(() => {});
        const current = find(id);
        if (!current) return;
        const undoMs = useComposeSettings.getState().undoSendSeconds * 1000;
        try {
          const queued = await sendEmail(current.accountId, outgoingDraft(current.draft), undoMs);
          remove(id);
          trackSend(current, queued, undoMs, host);
        } catch (e) {
          patch(id, { sending: false, error: toCommandError(e).message });
        }
      };
      const queued = queue().finally(() => sends.delete(id));
      sends.set(id, queued);
      await queued;
    },

    async sendLater(id) {
      const win = find(id);
      if (!win || win.loading || win.sending) return;
      if (refuseUnready(win, { confirmingSend: false })) return;
      // Save now, even with nothing new: Gmail web opens the draft's latest message.
      patch(id, { confirmingSend: false, confirmingClose: false, version: win.version + 1 });
      const current = await saveUntilClean(id); // a failed save shows its reason in the panel
      if (!current || !savedMessages.get(id)) return;
      // A file attached while saving isn't in the draft yet.
      const attaching = attachingProblem(current);
      if (attaching) {
        patch(id, { error: attaching });
        return;
      }
      // The account it was saved in, which may have changed while saving.
      const accountId = current.accountId;
      const email = useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email;
      if (!email) {
        patch(id, { error: "That account isn't connected any more." });
        return;
      }
      dispose(id, current.draft.attachments);
      try {
        await openExternal(gmailDraftsUrl(email));
        toast({
          title: "Draft saved and Gmail opened",
          description: "Open it at the top of Drafts and choose Schedule send to pick a time.",
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
        dispose(id, win.draft.attachments);
        if (win.version > 0 && win.draft.draftId) toast({ title: "Draft saved" });
        return;
      }
      // An image still being staged isn't in what would be saved yet, but it is something to keep.
      if (isBlank(win.draft) && !win.draft.draftId && !pastes.has(id)) {
        dispose(id, win.draft.attachments);
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
      const win = await saveUntilClean(id);
      if (!win) return;
      dispose(id, win.draft.attachments);
      toast({ title: "Draft saved" });
    },

    async discard(id) {
      const win = find(id);
      if (!win || win.sending) return;
      // Wait for a save in flight, which may be what creates the draft (removing the panel forgets it).
      const saving = saves.get(id);
      dispose(id, win.draft.attachments);
      await saving?.catch(() => {});
      const draftId = savedDrafts.get(id) ?? win.draft.draftId ?? null;
      // The save may have put back what removing the panel cleared.
      savedDrafts.delete(id);
      savedMessages.delete(id);
      draftMessages.delete(id);
      if (draftId) {
        try {
          await deleteDraft(win.accountId, draftId);
        } catch (e) {
          toastError(e);
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

    async checkFailedSends(accountId) {
      await checkFailedSends(accountId, host);
    },

    async subscribe() {
      return listenSendStatus(host);
    },
  };
});

/** Test helper. */
export function __resetComposeStoreForTests() {
  __resetSendingForTests();
  saves.clear();
  pastes.clear();
  savedDrafts.clear();
  savedMessages.clear();
  draftMessages.clear();
  nextId = 1;
  useComposeStore.setState({ windows: [], focusRequest: null });
}
