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
