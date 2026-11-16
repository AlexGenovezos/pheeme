import { call } from "./call";

/** Received mail counted one way (the Stats window). Engaged: opened, replied to or starred. */
export interface MailCounts {
  received: number;
  opened: number;
  replied: number;
  starred: number;
  engaged: number;
}
export type InboxTab = "primary" | "promotions" | "social" | "updates" | "forums" | "spam";
/** How a sender's newest mail offers unsubscribing; `unknown` until its headers are downloaded. */
export type UnsubscribeKind = "one_click" | "link" | "email" | "none" | "unknown";
export interface DayStats extends MailCounts {
  /** Local `YYYY-MM-DD`. */
  day: string;
}
export interface PlaceStats extends MailCounts {
  id: string;
  name: string;
}
export interface SenderStats extends MailCounts {
  /** The account, conversation and message of its newest mail, which Unsubscribe uses. */
  accountId: string;
  threadId: string | null;
  messageId: string | null;
  sender: string;
  name: string | null;
  tab: InboxTab;
  unsubscribe: UnsubscribeKind;
  lastDate: number;
}
export interface MailStats {
  since: number;
  /** Every account's older mail is downloaded; until then older days count low. */
  complete: boolean;
  totals: MailCounts;
  /** Days with mail, oldest first. */
  days: DayStats[];
  /** Every inbox tab and Spam, in a fixed order. */
  tabs: PlaceStats[];
  /** User labels with mail, most first. */
  labels: PlaceStats[];
  /** Who sends the most, most first. */
  senders: SenderStats[];
}
/** Mail received since `sinceMs` by one account, or all of them (`accountId` null). Local only. */
export const getMailStats = (accountId: string | null, sinceMs: number) =>
  call("mail_stats", { accountId, sinceMs });

export interface Unsubscribed {
  sender: string | null;
  method: "one_click" | "link" | "email" | "none";
  /** True when a one-click link did it; otherwise `web` or `mailto` is for the user to use. */
  unsubscribed: boolean;
  web: string | null;
  mailto: string | null;
}
/** Unsubscribe from the list a message came from. */
export const unsubscribeSender = (accountId: string, threadId: string, messageId: string | null) =>
  call("unsubscribe_sender", { accountId, threadId, messageId });
