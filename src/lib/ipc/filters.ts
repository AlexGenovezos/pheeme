import { call } from "./call";

/**
 * Gmail web's filter form (`FilterSpec` in `src-tauri/src/filters.rs`): its search options and
 * its actions, one-to-one with Gmail's filters API. Empty text is unset.
 */
export interface FilterSpec {
  from: string;
  to: string;
  subject: string;
  /** Has the words. */
  query: string;
  /** Doesn't have. */
  negatedQuery: string;
  /** Bytes, with `sizeComparison`. */
  size: number | null;
  sizeComparison: "larger" | "smaller" | null;
  hasAttachment: boolean;
  /** Don't include chats. */
  excludeChats: boolean;
  /** Skip the Inbox (Archive it). */
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  /** Apply the label: a user label's id. */
  label: string | null;
  /** Forward it to: a verified forwarding address. */
  forward: string | null;
  /** Delete it. */
  trash: boolean;
  neverSpam: boolean;
  /** `true` always mark it as important, `false` never. */
  important: boolean | null;
  /** Categorize as: a `CATEGORY_*` id. */
  category: string | null;
}

/** A Gmail filter as Settings › Filters lists it. */
export interface FilterEntry {
  id: string;
  /** What it matches, as the Gmail search it stands for. */
  matches: string;
  /** What it does, one phrase each ("skip the inbox (archive it)"). */
  actions: string[];
  /** The form to edit it with; null when it does something the form can't show. */
  spec: FilterSpec | null;
}

/** Every Gmail filter on the account. Rejects with `missing_scope` without filters access. */
export const listFilters = (accountId: string) => call("list_filters", { accountId });
/** Make a filter; `applyToExisting` also changes the conversations already there. */
export const createFilter = (accountId: string, spec: FilterSpec, applyToExisting: boolean) =>
  call("create_filter", { accountId, spec, applyToExisting });
/** Change a filter: Gmail has no update, so the new one is made and the old one deleted. */
export const replaceFilter = (
  accountId: string,
  filterId: string,
  spec: FilterSpec,
  applyToExisting: boolean,
) => call("replace_filter", { accountId, filterId, spec, applyToExisting });
export const deleteFilter = (accountId: string, filterId: string) =>
  call("delete_filter", { accountId, filterId });
/** Cached conversations the form's search matches; null when only Gmail can tell. */
export const filterMatches = (accountId: string, spec: FilterSpec) =>
  call("filter_matches", { accountId, spec });
/** The verified addresses a filter can forward to. */
export const forwardingAddresses = (accountId: string) =>
  call("forwarding_addresses", { accountId });
