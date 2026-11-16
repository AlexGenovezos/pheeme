import { call } from "./call";

/** A recipient suggestion for To, Cc or Bcc. */
export interface ContactSuggestion {
  name: string | null;
  address: string;
}
/** Where an account's Google Contacts stand (Settings › Contacts). */
export interface GoogleContactsStatus {
  /** `unknown` before the first check; `missing_scope`: sign in again and allow contacts; `api_disabled`: turn on the People API. */
  status: "unknown" | "on" | "missing_scope" | "api_disabled" | "error";
  /** What failed, for `error`. */
  message: string | null;
  /** The People API page for the account's Google Cloud project, for `api_disabled`. */
  enableUrl: string | null;
  /** Addresses downloaded from Google Contacts. */
  count: number;
  /** The last download that worked (ms since the epoch). */
  syncedAt: number | null;
}
/** Addresses matching what's typed, best first, from the local cache (no network). */
export const suggestContacts = (accountId: string, query: string, limit?: number) =>
  call("suggest_contacts", { accountId, query, limit });
export const googleContactsStatus = (accountId: string) =>
  call("google_contacts_status", { accountId });
/** Download the account's Google Contacts now and answer the new status. */
export const refreshGoogleContacts = (accountId: string) =>
  call("refresh_google_contacts", { accountId });
