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
  toCommandError,
} from "../lib/tauri";

interface AccountState {
  accounts: AccountInfo[];
  loaded: boolean;
  error: CommandError | null;
  load: () => Promise<void>;
  /** Adds or replaces (re-sign-in of the same address keeps its id). */
  upsert: (account: AccountInfo) => void;
  remove: (accountId: string) => Promise<void>;
  /** The account's first sync finished, so its cache is usable. */
  markSynced: (accountId: string) => void;
  /** Mark accounts synced on `sync:completed`. Resolves to the unsubscribe function. */
  subscribe: () => Promise<() => void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
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
  },
  markSynced: (accountId) =>
    set((state) =>
      state.accounts.some((a) => a.id === accountId && !a.synced)
        ? { accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, synced: true } : a)) }
        : {},
    ),
  subscribe: async () => {
    const stop = await listen<SyncAccountEvent>(SYNC_EVENTS.completed, ({ payload }) =>
      get().markSynced(payload.accountId),
    );
    return () => stopQuietly(stop);
  },
}));
