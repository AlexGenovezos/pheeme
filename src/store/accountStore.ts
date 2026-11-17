import { create } from "zustand";
import { summarizeQuota } from "../settings/QuotaUsage";
import { subscribeAll } from "../lib/subscriptions";
import {
  listen,
  type AccountInfo,
  type CommandError,
  listAccounts,
  NETWORK_EVENT,
  networkOnline,
  removeAccount,
  reorderAccounts,
  setAccountColor,
  SYNC_EVENTS,
  getGmailQuotaUsage,
  toCommandError,
} from "../lib/tauri";
import { useUiStore } from "./uiStore";

export interface SyncFailure {
  code: string;
  message: string;
}

/** How long after Gmail's last refusal the slow-sync note stays. */
export const SLOW_SYNC_HOLD_MS = 3 * 60_000;
/** The quota usage is asked at most this often per account. */
export const SLOW_SYNC_USAGE_MS = 60_000;

export interface SlowSync {
  /** The numbers show this Pheeme couldn't have hit the limit alone. */
  contended: boolean;
  since: number;
}

interface AccountState {
  accounts: AccountInfo[];
  /** Per account: the last sync failure, until that account next completes a sync. Session only. */
  syncErrors: Record<string, SyncFailure>;
  /** Per account: Gmail is rate-limiting sync, until 3 minutes after its last refusal. Session only. */
  slowSync: Record<string, SlowSync>;
  /** Google can't be reached from this device: one note stands in for every account's network failure. */
  offline: boolean;
  /** The account being signed in again (onboarding shows its sign-in), if any. */
  reconnecting: string | null;
  loaded: boolean;
  error: CommandError | null;
  load: () => Promise<void>;
  /** Adds or replaces (re-sign-in of the same address keeps its id). */
  upsert: (account: AccountInfo) => void;
  /** Removes the account and moves navigation off it (`uiStore.forgetAccount`). */
  remove: (accountId: string) => Promise<void>;
  /** Draws the account in colour `color` (1–12) at once; puts the old one back if saving it fails, and rethrows. */
  setColor: (accountId: string, color: number) => Promise<void>;
  /** Puts the accounts in `ids`' order at once; puts the old order back if saving it fails, and rethrows. */
  reorder: (ids: string[]) => Promise<void>;
  /** Start signing an account in again; `reconnect(null)` ends it. */
  reconnect: (accountId: string | null) => void;
  /** The account's first sync finished, so its cache is usable. */
  markSynced: (accountId: string) => void;
  /** Mark accounts synced and clear their failure on `sync:completed`; record `sync:error`; follow `network:status`. Resolves to the unsubscribe function. */
  subscribe: (signal?: AbortSignal) => Promise<() => void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  syncErrors: {},
  slowSync: {},
  offline: false,
  reconnecting: null,
  loaded: false,
  error: null,
  load: async () => {
    try {
      set({ accounts: await listAccounts(), loaded: true, error: null });
    } catch (error) {
      set({ loaded: true, error: toCommandError(error) });
    }
  },
  upsert: (account) =>
    set((state) => {
      const others = state.accounts.filter((a) => a.id !== account.id);
      const index = state.accounts.findIndex((a) => a.id === account.id);
      if (index === -1) return { accounts: [...others, account] };
      const accounts = [...state.accounts];
      accounts[index] = account;
      return { accounts };
    }),
  remove: async (accountId) => {
    await removeAccount(accountId);
    set((state) => ({ accounts: state.accounts.filter((a) => a.id !== accountId) }));
    // Navigation pointing at the removed account would keep querying it.
    useUiStore.getState().forgetAccount(accountId, get().accounts);
  },
  setColor: async (accountId, color) => {
    const before = get().accounts.find((a) => a.id === accountId)?.color;
    if (before === undefined || before === color) return;
    const paint = (c: number) =>
      set((s) => ({
        accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, color: c } : a)),
      }));
    paint(color);
    try {
      await setAccountColor(accountId, color);
    } catch (error) {
      // Only if nothing changed it meanwhile.
      if (get().accounts.find((a) => a.id === accountId)?.color === color) paint(before);
      throw error;
    }
  },
  reorder: async (ids) => {
    const before = get().accounts;
    const ordered = inOrder(before, ids);
    if (ordered.every((a, i) => a === before[i])) return;
    set({ accounts: ordered });
    try {
      await reorderAccounts(ordered.map((a) => a.id));
    } catch (error) {
      // Unless something moved them meanwhile; other changes to the accounts (a colour, a first sync) stay.
      const now = get().accounts;
      if (now.every((a, i) => a.id === ordered[i]?.id))
        set({
          accounts: inOrder(
            now,
            before.map((a) => a.id),
          ),
        });
      throw error;
    }
  },
  reconnect: (accountId) => set({ reconnecting: accountId }),
  markSynced: (accountId) =>
    set((state) =>
      state.accounts.some((a) => a.id === accountId && !a.synced)
        ? { accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, synced: true } : a)) }
        : {},
    ),
  subscribe: async (signal) => {
    const stop = await subscribeAll(
      [
        () =>
          listen(SYNC_EVENTS.completed, ({ payload }) => {
            get().markSynced(payload.accountId);
            if (payload.accountId in get().syncErrors) {
              const syncErrors = { ...get().syncErrors };
              delete syncErrors[payload.accountId];
              set({ syncErrors });
            }
          }),
        () =>
          listen(SYNC_EVENTS.error, ({ payload }) => {
            // The offline note already says why; a network failure isn't this account's problem.
            if (get().offline && payload.code === "network") return;
            set((s) => ({
              syncErrors: {
                ...s.syncErrors,
                [payload.accountId]: { code: payload.code, message: payload.message },
              },
            }));
          }),
        () => listen(SYNC_EVENTS.rateLimited, ({ payload }) => noteRateLimited(payload.accountId)),
        () => listen(NETWORK_EVENT, ({ payload }) => setOnline(payload.online)),
      ],
      signal,
    );
    // The app may have gone offline before the window listened.
    try {
      if ((await networkOnline()) === false) setOnline(false);
    } catch {
      // An older backend without the command: assume online.
    }
    return () => {
      stop();
      clearSlowSyncTimers();
    };
  },
}));

const slowSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const usageAskedAt = new Map<string, number>();

function clearSlowSyncTimers() {
  for (const timer of slowSyncTimers.values()) clearTimeout(timer);
  slowSyncTimers.clear();
  usageAskedAt.clear();
}

function forgetSlowSync(accountId: string) {
  slowSyncTimers.delete(accountId);
  useAccountStore.setState((s) => {
    const slowSync = { ...s.slowSync };
    delete slowSync[accountId];
    return { slowSync };
  });
}

/** Gmail refused a sync request: show the note and keep it 3 minutes past the last refusal. */
function noteRateLimited(accountId: string) {
  clearTimeout(slowSyncTimers.get(accountId));
  slowSyncTimers.set(
    accountId,
    setTimeout(() => forgetSlowSync(accountId), SLOW_SYNC_HOLD_MS),
  );
  const now = Date.now();
  const existing = useAccountStore.getState().slowSync[accountId];
  if (!existing) {
    useAccountStore.setState((s) => ({
      slowSync: { ...s.slowSync, [accountId]: { contended: false, since: now } },
    }));
  }
  const asked = usageAskedAt.get(accountId);
  if (asked !== undefined && now - asked < SLOW_SYNC_USAGE_MS) return;
  usageAskedAt.set(accountId, now);
  getGmailQuotaUsage(accountId)
    .then((usage) => {
      if (!summarizeQuota(usage).somethingElse) return;
      useAccountStore.setState((s) =>
        accountId in s.slowSync
          ? {
              slowSync: {
                ...s.slowSync,
                [accountId]: { ...s.slowSync[accountId]!, contended: true },
              },
            }
          : {},
      );
    })
    .catch(() => {
      // Keep the plain note; the next refusal asks again after a minute.
    });
}

function setOnline(online: boolean) {
  useAccountStore.setState((s) => ({
    offline: !online,
    syncErrors: online
      ? s.syncErrors
      : Object.fromEntries(Object.entries(s.syncErrors).filter(([, e]) => e.code !== "network")),
  }));
}

/** `accounts` in `ids`' order; any `ids` leaves out keep their relative order after the rest. */
export function inOrder<T extends { id: string }>(accounts: T[], ids: string[]): T[] {
  const rank = (a: T) => {
    const i = ids.indexOf(a.id);
    return i === -1 ? ids.length : i;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}
