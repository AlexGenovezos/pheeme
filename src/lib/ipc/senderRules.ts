import { call } from "./call";

/** A Gmail filter that files a sender's mail in an inbox category ("from a@x.com → Updates"). */
export interface SenderRule {
  /** Gmail's filter id. */
  id: string;
  sender: string;
  /** `CATEGORY_*`. */
  category: string;
}
/** What saving sender rules changed, so Undo can put it back. */
export interface SavedRules {
  created: string[];
  replaced: SenderRule[];
}
/** A cached inbox conversation and its `CATEGORY_*` labels before a move. */
export interface InboxThread {
  threadId: string;
  categories: string[];
}
/** The account's sender rules. Rejects with `missing_scope` when the account hasn't granted filters access. */
export const listSenderRules = (accountId: string) => call("list_sender_rules", { accountId });
/** The senders a rule would be made for: each conversation's latest sender who isn't the account itself. */
export const ruleSenders = (accountId: string, threadIds: string[]) =>
  call("rule_senders", { accountId, threadIds });
export const saveSenderRules = (accountId: string, senders: string[], category: string) =>
  call("save_sender_rules", { accountId, senders, category });
export const undoSenderRules = (accountId: string, saved: SavedRules) =>
  call("undo_sender_rules", { accountId, saved });
export const deleteSenderRule = (accountId: string, ruleId: string) =>
  call("delete_sender_rule", { accountId, ruleId });
/** Cached inbox conversations from `senders` that aren't in `category` yet. */
export const inboxThreadsFrom = (accountId: string, senders: string[], category: string) =>
  call("inbox_threads_from", { accountId, senders, category });
