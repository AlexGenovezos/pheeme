import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import {
  type AccountInfo,
  type CommandError,
  listAccounts,
  NETWORK_EVENT,
  type NetworkStatusEvent,
  networkOnline,
  removeAccount,
  SYNC_EVENTS,
  type SyncAccountEvent,
  type SyncErrorEvent,
  toCommandError,
} from "../lib/tauri";
import { useUiStore } from "./uiStore";

export interface SyncFailure {
  code: string;
  message: string;
}

interface AccountState {
  accounts: AccountInfo[];
  /** Per account: the last sync failure, until that account next completes a sync. Session only. */
  syncErrors: Record<string, SyncFailure>;
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
          listen<SyncAccountEvent>(SYNC_EVENTS.completed, ({ payload }) => {
            get().markSynced(payload.accountId);
            if (payload.accountId in get().syncErrors) {
              const syncErrors = { ...get().syncErrors };
              delete syncErrors[payload.accountId];
              set({ syncErrors });
            }
          }),
        () =>
          listen<SyncErrorEvent>(SYNC_EVENTS.error, ({ payload }) => {
            // The offline note already says why; a network failure isn't this account's problem.
            if (get().offline && payload.code === "network") return;
            set((s) => ({
              syncErrors: {
                ...s.syncErrors,
                [payload.accountId]: { code: payload.code, message: payload.message },
              },
            }));
          }),
        () => listen<NetworkStatusEvent>(NETWORK_EVENT, ({ payload }) => setOnline(payload.online)),
      ],
      signal,
    );
    // The app may have gone offline before the window listened.
    try {
      if ((await networkOnline()) === false) setOnline(false);
    } catch {
      // An older backend without the command: assume online.
    }
    return stop;
  },
}));

function setOnline(online: boolean) {
  useAccountStore.setState((s) => ({
    offline: !online,
    syncErrors: online
      ? s.syncErrors
      : Object.fromEntries(Object.entries(s.syncErrors).filter(([, e]) => e.code !== "network")),
  }));
}
