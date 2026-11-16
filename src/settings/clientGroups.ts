import type { AccountInfo } from "../lib/tauri";

/** The accounts that sign in through one Google Cloud OAuth client. */
export interface ClientGroup {
  clientId: string;
  accounts: AccountInfo[];
}

/** Accounts grouped by the OAuth client they signed in with, in the order the groups first appear. */
export function groupByClient(accounts: AccountInfo[]): ClientGroup[] {
  const groups = new Map<string, ClientGroup>();
  for (const account of accounts) {
    const group = groups.get(account.clientId);
    if (group) group.accounts.push(account);
    else groups.set(account.clientId, { clientId: account.clientId, accounts: [account] });
  }
  return [...groups.values()];
}

const SUFFIX = ".apps.googleusercontent.com";

/**
 * A short name for an OAuth client: Google's client IDs start with the Cloud project's number
 * (`123456789012-abc…xyz.apps.googleusercontent.com`), so "Project 123456789012 · client …wxyz",
 * which tells two clients of one project apart. Anything else is shown as it is, less the suffix.
 */
export function clientLabel(clientId: string): string {
  const id = clientId.endsWith(SUFFIX) ? clientId.slice(0, -SUFFIX.length) : clientId;
  const match = /^(\d+)-(.+)$/.exec(id);
  if (!match) return `Client ${id}`;
  const [, project, rest] = match;
  return `Project ${project} · client …${rest!.slice(-4)}`;
}
