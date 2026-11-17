import { categoryMailbox, FAVORITES, type MailboxRef } from "../../mail/mailboxes";

/**
 * Where picking `accountId` on the account rail goes from `ref`: the same mailbox in that account when it has one
 * (an Inbox tab it shows, a favorite), else its first tab. `tabs` are the account's shown Inbox tabs, Primary first.
 */
export function mailboxInAccount(ref: MailboxRef, accountId: string, tabs: string[]): MailboxRef {
  if (ref.accountId === accountId) return ref;
  if (ref.accountId !== null) {
    if (ref.category && tabs.includes(ref.category))
      return categoryMailbox(accountId, ref.category);
    if (!ref.category && FAVORITES.some((f) => f.labelId === ref.labelId))
      return { accountId, labelId: ref.labelId };
  }
  return categoryMailbox(accountId, tabs[0] ?? "CATEGORY_PERSONAL");
}

/**
 * Ctrl+Tab's next stop from `current` (an account id, or null for All Inboxes): All Inboxes, then each account in
 * order, wrapping; `by` −1 goes back. With one account there is no All Inboxes, so it stays put.
 */
export function nextInbox(current: string | null, accountIds: string[], by: 1 | -1): string | null {
  if (accountIds.length < 2) return current;
  const stops: Array<string | null> = [null, ...accountIds];
  const at = Math.max(stops.indexOf(current), 0);
  return stops[(at + by + stops.length) % stops.length] ?? null;
}
