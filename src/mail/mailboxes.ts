// Mailbox definitions and the helpers that turn a sidebar choice into a list query.
import {
  Archive,
  File,
  Info,
  Inbox,
  type LucideIcon,
  Megaphone,
  MessagesSquare,
  OctagonAlert,
  Send,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import type { ThreadQuery } from "../lib/tauri";

/** `${accountId}:${threadId}`. Thread ids are per account, so every UI collection keys on this. */
export type ThreadKey = string;

export const threadKey = (accountId: string, threadId: string): ThreadKey =>
  `${accountId}:${threadId}`;

/** Splits on the first `:` (account ids never contain one). */
export function parseThreadKey(key: ThreadKey): { accountId: string; threadId: string } {
  const at = key.indexOf(":");
  return { accountId: key.slice(0, at), threadId: key.slice(at + 1) };
}

/** A place the list pane can show. */
export interface MailboxRef {
  /** `null` is All Inboxes: every account. */
  accountId: string | null;
  labelId: string;
  /** `CATEGORY_*` for a category inbox (INBOX ∩ that category). */
  category?: string;
}

export interface MailboxRow {
  labelId: string;
  name: string;
  icon: LucideIcon;
  /** CSS custom property holding the row's color. */
  colorToken: string;
}

export interface FavoriteRow extends MailboxRow {
  /** Starred and Drafts show how many there are; the rest show unread. */
  count: "total" | "unread";
  /** Gmail-style `g` chord key. */
  goKey?: string;
}

export const CATEGORIES: MailboxRow[] = [
  {
    labelId: "CATEGORY_PERSONAL",
    name: "Primary",
    icon: Inbox,
    colorToken: "--color-mailbox-primary",
  },
  { labelId: "CATEGORY_SOCIAL", name: "Social", icon: Users, colorToken: "--color-mailbox-social" },
  {
    labelId: "CATEGORY_PROMOTIONS",
    name: "Promotions",
    icon: Megaphone,
    colorToken: "--color-mailbox-promotions",
  },
  {
    labelId: "CATEGORY_UPDATES",
    name: "Updates",
    icon: Info,
    colorToken: "--color-mailbox-updates",
  },
  {
    labelId: "CATEGORY_FORUMS",
    name: "Forums",
    icon: MessagesSquare,
    colorToken: "--color-mailbox-forums",
  },
];

export const FAVORITES: FavoriteRow[] = [
  {
    labelId: "STARRED",
    name: "Starred",
    icon: Star,
    colorToken: "--color-mailbox-starred",
    count: "total",
    goKey: "s",
  },
  {
    labelId: "DRAFT",
    name: "Drafts",
    icon: File,
    colorToken: "--color-mailbox-drafts",
    count: "total",
    goKey: "d",
  },
  {
    labelId: "SENT",
    name: "Sent",
    icon: Send,
    colorToken: "--color-mailbox-sent",
    count: "unread",
    goKey: "t",
  },
  {
    labelId: "ALL",
    name: "All Mail",
    icon: Archive,
    colorToken: "--color-mailbox-allmail",
    count: "unread",
    goKey: "a",
  },
  {
    labelId: "SPAM",
    name: "Spam",
    icon: OctagonAlert,
    colorToken: "--color-mailbox-spam",
    count: "unread",
  },
  {
    labelId: "TRASH",
    name: "Trash",
    icon: Trash2,
    colorToken: "--color-mailbox-trash",
    count: "total",
  },
];

/** The list query for `ref`; `accountIds` is every connected account, used for All Inboxes. */
export function queryFor(ref: MailboxRef, accountIds: string[]): ThreadQuery {
  const ids = ref.accountId === null ? accountIds : [ref.accountId];
  if (ref.category) return { accountIds: ids, labelId: "INBOX", alsoLabelId: ref.category };
  return { accountIds: ids, labelId: ref.labelId };
}

/** Count text for a sidebar row: blank at 0, capped at 999+. */
export function formatCount(n: number): string {
  if (n <= 0) return "";
  return n > 999 ? "999+" : String(n);
}

/** The heading for a mailbox. `labels` are the ref's account's labels, for user label names. */
export function mailboxTitle(ref: MailboxRef, labels: { id: string; name: string }[]): string {
  if (ref.category) return CATEGORIES.find((c) => c.labelId === ref.category)?.name ?? "Inbox";
  if (ref.labelId === "INBOX") return ref.accountId === null ? "All Inboxes" : "Inbox";
  const favorite = FAVORITES.find((f) => f.labelId === ref.labelId);
  if (favorite) return favorite.name;
  return labels.find((l) => l.id === ref.labelId)?.name ?? "Mail";
}

/** 1..6: the account's position in list order, cycling through the six `--color-account-N` tokens. */
export function accountColorIndex(accountId: string, accounts: { id: string }[]): number {
  const index = accounts.findIndex((a) => a.id === accountId);
  return (Math.max(index, 0) % 6) + 1;
}

/** All Inboxes: every account's INBOX, categories mixed in. */
export const ALL_INBOXES: MailboxRef = { accountId: null, labelId: "INBOX" };

/** An account's category inbox (INBOX ∩ `category`). */
export const categoryMailbox = (accountId: string, category: string): MailboxRef => ({
  accountId,
  labelId: "INBOX",
  category,
});

/** Where "inbox" goes: All Inboxes, or the only account's Primary (there is no All Inboxes row then). */
export function homeMailbox(accounts: { id: string }[]): MailboxRef {
  return accounts.length === 1
    ? categoryMailbox(accounts[0].id, CATEGORIES[0].labelId)
    : ALL_INBOXES;
}

/**
 * Whether a mailbox restored from the last launch still exists: its account is connected and, for a user label once
 * that account's labels are known, the label is one of them. All Inboxes always exists.
 */
export function mailboxExists(
  ref: MailboxRef,
  accounts: { id: string }[],
  labels: Record<string, { id: string }[]>,
): boolean {
  if (ref.accountId === null) return true;
  if (!accounts.some((a) => a.id === ref.accountId)) return false;
  // Inbox, its categories and the Favorites are Gmail system labels, which every account has.
  if (ref.labelId === "INBOX" || FAVORITES.some((f) => f.labelId === ref.labelId)) return true;
  const known = labels[ref.accountId];
  // Not loaded yet, or a new account before its first sync: nothing to check against.
  if (!known?.length) return true;
  return known.some((l) => l.id === ref.labelId);
}

/** The account Favorites and labels follow: the stored one while it is still connected, else the first. */
export function resolveActiveAccount(
  activeAccountId: string | null,
  accounts: { id: string }[],
): string | null {
  if (activeAccountId !== null && accounts.some((a) => a.id === activeAccountId))
    return activeAccountId;
  return accounts[0]?.id ?? null;
}

/** Session filter identity, including account and category. */
export const mailboxKey = (ref: MailboxRef): string =>
  JSON.stringify([ref.accountId, ref.labelId, ref.category ?? null]);

/**
 * Where a conversation sits, from its labels: Trash, Spam, its inbox tab (Primary, Social, …),
 * Sent or Drafts when it left the inbox that way, otherwise Archived.
 */
export function locationOf(labelIds: readonly string[]): string {
  const has = new Set(labelIds);
  if (has.has("TRASH")) return "Trash";
  if (has.has("SPAM")) return "Spam";
  if (has.has("INBOX")) {
    const tab = CATEGORIES.find((c) => c.labelId !== "CATEGORY_PERSONAL" && has.has(c.labelId));
    return tab ? tab.name : "Primary";
  }
  if (has.has("SENT")) return "Sent";
  if (has.has("DRAFT")) return "Drafts";
  return "Archived";
}

/** Rows name their location in views that mix locations: All Mail, Starred, user labels and search. */
export function showsLocation(mailbox: MailboxRef, searching: boolean): boolean {
  if (searching) return true;
  return !["INBOX", "SPAM", "TRASH", "SENT", "DRAFT"].includes(mailbox.labelId);
}
