// What the sidebar's mailbox rows and label rows both need.
import type { MailboxRef } from "../../mail/mailboxes";

export const NO_COUNTS: Record<string, never> = {};

export const sameMailbox = (a: MailboxRef, b: MailboxRef) =>
  a.accountId === b.accountId &&
  a.labelId === b.labelId &&
  (a.category ?? null) === (b.category ?? null);
