import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  type AccountInfo,
  type CommandError,
  listAccounts,
  removeAccount,
  stopQuietly,
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
  loaded: boolean;
  error: CommandError | null;
  load: () => Promise<void>;
  /** Adds or replaces (re-sign-in of the same address keeps its id). */
  upsert: (account: AccountInfo) => void;
  /** Removes the account and moves navigation off it (`uiStore.forgetAccount`). */
  remove: (accountId: string) => Promise<void>;
  /** The account's first sync finished, so its cache is usable. */
  markSynced: (accountId: string) => void;
  /** Mark accounts synced and clear their failure on `sync:completed`; record `sync:error`. Resolves to the unsubscribe function. */
  subscribe: () => Promise<() => void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  syncErrors: {},
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
  markSynced: (accountId) =>
    set((state) =>
      state.accounts.some((a) => a.id === accountId && !a.synced)
        ? { accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, synced: true } : a)) }
        : {},
    ),
  subscribe: async () => {
    const stops = await Promise.all([
      listen<SyncAccountEvent>(SYNC_EVENTS.completed, ({ payload }) => {
        get().markSynced(payload.accountId);
        if (payload.accountId in get().syncErrors) {
          const syncErrors = { ...get().syncErrors };
          delete syncErrors[payload.accountId];
          set({ syncErrors });
        }
      }),
      listen<SyncErrorEvent>(SYNC_EVENTS.error, ({ payload }) =>
        set((s) => ({ syncErrors: { ...s.syncErrors, [payload.accountId]: { code: payload.code, message: payload.message } } })),
      ),
    ]);
    return () => stops.forEach(stopQuietly);
  },
}));
