import { call } from "./call";
import type { ThreadCursor, ThreadPage, ThreadSummary } from "./mail";

export interface SearchPage extends ThreadPage {
  /** False when the query uses syntax only Gmail understands; then only Gmail answers. */
  local: boolean;
}

export interface GmailSearchPage {
  /** Newest first; cached by the backend, so they open like any thread. */
  threads: ThreadSummary[];
  /** Page token per account with more results; pass back as `pageTokens`. */
  next: Record<string, string>;
  /** Accounts whose Gmail search failed (offline, for example). */
  failed: string[];
}

/** Cached mail matching `query` (Gmail syntax), instantly. */
export const searchMessages = (
  accountIds: string[],
  query: string,
  before?: ThreadCursor | null,
  limit?: number,
) =>
  call("search_messages", {
    accountIds,
    query,
    before: before ?? null,
    limit: limit ?? null,
  });
/** Gmail's search, for mail not cached yet. Omit `pageTokens` for the first page. */
export const searchGmail = (
  accountIds: string[],
  query: string,
  pageTokens?: Record<string, string> | null,
) => call("search_gmail", { accountIds, query, pageTokens: pageTokens ?? null });
export const recentSearches = () => call("recent_searches");
export const addRecentSearch = (query: string) => call("add_recent_search", { query });
/** Forget one recent search, or all of them when `query` is omitted. */
export const removeRecentSearch = (query?: string | null) =>
  call("remove_recent_search", { query: query ?? null });
