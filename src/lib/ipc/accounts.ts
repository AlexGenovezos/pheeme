import { call } from "./call";

export interface AccountInfo {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string;
  /** The first sync has finished, so the cache is usable; false shows skeletons. */
  synced: boolean;
  /** 1–12: the `--color-account-N` theme token the account is drawn in (`ACCOUNT_COLORS`). */
  color: number;
}

export type ClientChoice =
  | { kind: "new"; clientId: string; clientSecret: string }
  | { kind: "sameAs"; accountId: string }
  /** Sign an existing account in again with its own client, keeping its mail. */
  | { kind: "reconnect"; accountId: string }
  /** Allow calendar and tasks access for an existing account (asked when Calendar first opens). */
  | { kind: "calendar"; accountId: string }
  | { kind: "drive"; accountId: string }
  | { kind: "contacts"; accountId: string }
  /** See guests' free/busy in the event editor (asked when the planner first needs it). */
  | { kind: "availability"; accountId: string };

export interface SignInStart {
  flowId: string;
  authUrl: string;
}

export const beginOauth = (client: ClientChoice) => call("begin_oauth", { client });
/** Resolves when the browser sign-in finishes; rejects on failure, timeout or cancel. */
export const completeOauth = (flowId: string) => call("complete_oauth", { flowId });
export const cancelOauth = (flowId: string) => call("cancel_oauth", { flowId });
export const listAccounts = () => call("list_accounts");
export const removeAccount = (accountId: string) => call("remove_account", { accountId });
/** Draws the account in colour `color` (1–12). */
export const setAccountColor = (accountId: string, color: number) =>
  call("set_account_color", { accountId, color });
/** Lists the accounts in this order from now on (the sidebar, the rail, Settings). */
export const reorderAccounts = (accountIds: string[]) => call("reorder_accounts", { accountIds });
/** Opens an allow-listed https URL (Google, Pheeme) in the default browser. */
export const openExternal = (url: string) => call("open_external", { url });

/** Gmail's per-user limit (quota units per minute) that sync paces itself by. */
export const getGmailQuota = () => call("gmail_quota");
/** Change the Gmail limit; returns the stored value (out-of-range values are clamped). */
export const setGmailQuota = (perMinute: number) => call("set_gmail_quota", { perMinute });

/** What spends an account's Gmail quota, by id (`gmail::usage::UsageSource`). */
export type QuotaSource = "newMail" | "olderMail" | "yourChanges" | "youAsked" | "assistants";

export interface QuotaMinute {
  /** When the minute began (ms since the epoch). */
  startMs: number;
  /** Quota units this copy of Pheeme sent in the minute, by source. */
  units: Record<QuotaSource, number>;
  /** Requests Gmail refused for its rate limit (retried ones included). */
  refused: number;
}

export interface QuotaUsage {
  /** The user's Gmail limit (Settings › Accounts). */
  limitPerMinute: number;
  /** The last 60 minutes, oldest first, the current minute last. */
  minutes: QuotaMinute[];
}

/** What the account's Gmail client spent in each of the last 60 minutes, and what Gmail refused. */
export const getGmailQuotaUsage = (accountId: string) => call("gmail_quota_usage", { accountId });
