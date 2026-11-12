// Signatures: each account's choice for new messages and for replies/forwards (its Gmail signature, one of its
// own, or none), and the Gmail signatures themselves, kept from the last fetch so a compose panel opens with one
// at once, offline too. Settings › Signatures edits them; the compose store puts the chosen one in the body.
import DOMPurify from "dompurify";
import { create } from "zustand";
import { type CommandError, gmailSignature, toCommandError } from "../lib/tauri";
import { sameAddress, useSendAs } from "./sendAs";

export type SignatureChoice = "gmail" | "custom" | "none";

export interface AccountSignatures {
  newMessages: SignatureChoice;
  replies: SignatureChoice;
  /** The account's own signature (editor HTML), used where `custom` is chosen. */
  custom: string;
}

export const DEFAULT_SIGNATURES: AccountSignatures = {
  newMessages: "gmail",
  replies: "gmail",
  custom: "",
};

export interface GmailSignature {
  /** From the last fetch: HTML, `null` for none set in Gmail, `undefined` when never fetched. */
  html?: string | null;
  loading: boolean;
  /** The last fetch failed (`missing_scope`: sign in again and allow Gmail settings). */
  error?: CommandError;
}

/** What a compose panel is for, as far as signatures go. */
export type SignatureUse = "new" | "reply";

const SETTINGS_KEY = "pheeme.signatures";
const GMAIL_KEY = "pheeme.gmail-signatures";

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readJson<T>(key: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function persist(key: string, value: unknown) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Kept until the app closes.
  }
}

const CHOICES: readonly SignatureChoice[] = ["gmail", "custom", "none"];
const choice = (v: unknown, fallback: SignatureChoice) =>
  CHOICES.includes(v as SignatureChoice) ? (v as SignatureChoice) : fallback;

function readSettings(): Record<string, AccountSignatures> {
  const out: Record<string, AccountSignatures> = {};
  for (const [id, raw] of Object.entries(readJson<Partial<AccountSignatures>>(SETTINGS_KEY))) {
    out[id] = {
      newMessages: choice(raw?.newMessages, DEFAULT_SIGNATURES.newMessages),
      replies: choice(raw?.replies, DEFAULT_SIGNATURES.replies),
      custom: typeof raw?.custom === "string" ? raw.custom : "",
    };
  }
  return out;
}

function readGmail(): Record<string, GmailSignature> {
  const out: Record<string, GmailSignature> = {};
  for (const [id, html] of Object.entries(readJson<unknown>(GMAIL_KEY)))
    if (typeof html === "string" || html === null) out[id] = { html, loading: false };
  return out;
}

const textOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/ /g, " ").trim();
};

/** Whether `html` shows anything: text, or an image (a logo-only signature). */
export function hasContent(html: string | null | undefined): html is string {
  if (!html) return false;
  if (textOf(html)) return true;
  return /<img\b/i.test(html);
}

/** Signature HTML made safe to show in the editor and to send. */
export const cleanSignature = (html: string) => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false });

/** The block a signature takes in a message body; the editor keeps it as one piece (`SignatureNode`). */
export const signatureBlock = (html: string) =>
  `<div class="gmail_signature" data-smartmail="gmail_signature">${cleanSignature(html)}</div>`;

/** A fresh body: an empty line to type on, then the signature. Empty without one. */
export const bodyWithSignature = (html: string | null) =>
  html ? `<p></p>${signatureBlock(html)}` : "";

/** `html` without its signature block, for telling whether anything was typed. */
export function withoutSignature(html: string): string {
  if (!html.includes("gmail_signature")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll(".gmail_signature").forEach((el) => el.remove());
  return doc.body.innerHTML;
}

interface SignatureState {
  settings: Record<string, AccountSignatures>;
  gmail: Record<string, GmailSignature>;
  /** The account's choices (defaults when it has none saved). */
  forAccount(accountId: string): AccountSignatures;
  update(accountId: string, change: Partial<AccountSignatures>): void;
  /** Fetch the account's Gmail signature again. Resolves once it's known (or the fetch failed). */
  refreshGmail(accountId: string): Promise<void>;
  /** Fetch it once per session, when the account uses it. */
  refreshGmailOnce(accountId: string): Promise<void>;
  /**
   * The signature to start a message with, or `null` for none. With Gmail's chosen, a message `from` one of
   * the account's aliases takes that alias's Gmail signature.
   */
  signatureFor(accountId: string, use: SignatureUse, from?: string | null): string | null;
}

const inflight = new Map<string, Promise<void>>();
/** Accounts whose Gmail signature was fetched this session. */
const fetched = new Set<string>();

export const useSignatures = create<SignatureState>((set, get) => ({
  settings: readSettings(),
  gmail: readGmail(),

  forAccount: (accountId) => get().settings[accountId] ?? DEFAULT_SIGNATURES,

  update(accountId, change) {
    const settings = {
      ...get().settings,
      [accountId]: { ...get().forAccount(accountId), ...change },
    };
    persist(SETTINGS_KEY, settings);
    set({ settings });
  },

  refreshGmail(accountId) {
    const running = inflight.get(accountId);
    if (running) return running;
    const patch = (change: Partial<GmailSignature>) =>
      set((s) => ({
        gmail: {
          ...s.gmail,
          [accountId]: { ...(s.gmail[accountId] ?? { loading: false }), ...change },
        },
      }));
    fetched.add(accountId);
    patch({ loading: true });
    const run = gmailSignature(accountId).then(
      (html) => {
        patch({ html, loading: false, error: undefined });
        const cached: Record<string, string | null> = {};
        for (const [id, g] of Object.entries(get().gmail))
          if (g.html !== undefined) cached[id] = g.html;
        persist(GMAIL_KEY, cached);
      },
      (e: unknown) => patch({ loading: false, error: toCommandError(e) }),
    );
    const done = run.finally(() => inflight.delete(accountId));
    inflight.set(accountId, done);
    return done;
  },

  refreshGmailOnce(accountId) {
    const prefs = get().forAccount(accountId);
    const used = prefs.newMessages === "gmail" || prefs.replies === "gmail";
    if (!used || fetched.has(accountId)) return inflight.get(accountId) ?? Promise.resolve();
    return get().refreshGmail(accountId);
  },

  signatureFor(accountId, use, from) {
    const prefs = get().forAccount(accountId);
    const picked = use === "new" ? prefs.newMessages : prefs.replies;
    const alias = useSendAs
      .getState()
      .lists[accountId]?.find((a) => !a.isPrimary && sameAddress(a.email, from));
    const html =
      picked === "gmail"
        ? alias
          ? alias.signature
          : get().gmail[accountId]?.html
        : picked === "custom"
          ? prefs.custom
          : null;
    return hasContent(html) ? html : null;
  },
}));

/** Test helper: re-read what's stored. */
export function __resetSignaturesForTests() {
  inflight.clear();
  fetched.clear();
  useSignatures.setState({ settings: readSettings(), gmail: readGmail() });
}
